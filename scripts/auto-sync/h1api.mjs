// h1api.mjs — huang1111 (Cloudreve 3.8.5) API 封装
// 只封装「已验证」的端点（见 docs/huang1111-api-notes.md §8 调用链）：
//   GET  /site/captcha            → 验证码图（data:image/png;base64,...）
//   GET  /site/captcha/pow        → PoW 挑战（扁平 JSON，非 {code,data} 信封）
//   GET  /site/config             → CSRF（响应头 x-csrf-token，每次写请求前重取）
//   POST /user/session            → 登录（验证码或 PoW + CSRF）
//   PUT  /directory               → 建目录（幂等，中间目录自动创建）
//   GET  /directory/{路径}        → 列目录（objects：id/name/size/type）
//   POST /aria2/url               → 提交离线下载（响应无 gid，轮询反查）
//   GET  /aria2/downloading       → 正在下载的任务（仅用于跳过重复提交）
//   POST /file/source             → 批量取直链（验证码或 PoW + CSRF）
//
// 验证（用户确认，2026-09-26 实测）：
//   站点 site_config.captcha_type = "pow"，但后端**同时保留图形验证码校验通路**
//   （pow_fallback=true），两条路都可用：
//     图形验证码（OCR）：实测 3/6 成功，受 OCR 准确率限制
//     PoW              ：实测 6/6 成功
//   故策略为「默认 OCR，用尽后回退 PoW」：
//     登录 / 取直链：图形验证码最多 RETRY.CAPTCHA_ATTEMPTS 次 → 全败则 PoW 最多 RETRY.POW_ATTEMPTS 次
//   两条路的载荷字段不同：
//     图形验证码 → captchaCode: "ABCD"
//     PoW       → powPayload: '{"token":"...","counter":123}'
//
// PoW 协议（cloudreve-pow-v1，从前端 bundle 逆向 + 实测）：
//   ① GET /site/captcha/pow?purpose=<login|direct_link> → {token,nonce,salt,target,iterations,counterLimit,expiresAt}
//   ② password = "Cloudreve-PoW/v1" || 0x00 || nonce
//      salt     = salt || uint32_be(counter)
//      PBKDF2-SHA256(password, salt, iterations, 256bit) == target  → 该 counter 即答案
//      （纯 WebCrypto 即可；前端另有 WASM SIMD 4 路加速，但结果等价，无需实现）
//   ③ 提交 powPayload = JSON.stringify({token, counter})
//   实测求解耗时 6.8~12.5s；counterLimit 5000、有效期 1200s，余量充足。
//   注意：cloudreve 会随验证码/PoW 轮换会话 cookie，但 `cloudreve_observer` 实测**非必需**；
//   仍按原逻辑只保留 cloudreve-session（其它子域同名 cookie 会干扰会话）。
//
// 成功判据（用户确认）：
//   离线下载是否成功，**只看目录（GET /directory）**里是否出现了全部期望文件、
//   且每个文件的 size 与 GitHub asset 的精确字节数一致。
//   不再查询 /aria2/finished，也不依赖任何 API 返回的 status / code 作为成败判据。
//
// 重试策略（用户确认）：
//   图形验证码类失败（登录/取直链）→ 换新验证码最多 10 次，用尽后回退 PoW 最多 3 次
//   离线下载失败              → 提交+轮询最多 3 次
//   其他任何失败（网络/HTTP） → 最多 2 次尝试

import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV, RETRY, TIMING, LIMIT } from './config.mjs';

const BASE = ENV.HOST + '/api/v3';
const ORIGIN = ENV.HOST;
const HERE = dirname(fileURLToPath(import.meta.url));
const OCR_HELPER = join(HERE, 'ocr_helper.py');
const PY_BIN = process.platform === 'win32' ? 'python' : 'python3';
const CAPTCHA_PNG = join(tmpdir(), `h1-captcha-${process.pid}.png`);
const OCR_OUT = join(tmpdir(), `h1-ocr-${process.pid}.txt`);

// ---------- 会话状态 ----------
let cookie = ''; // "cloudreve-session=xxx"
let csrf = '';
let isLoggedIn = false;

export class H1Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'H1Error';
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function logMsg(log, msg) {
  if (typeof log === 'function') log(msg);
}

// ---------- 底层请求 ----------
function saveSetCookie(res) {
  const lines = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : res.headers.get('set-cookie')
      ? [res.headers.get('set-cookie')]
      : [];
  for (const line of lines) {
    const m = /^\s*([^=;]+)=([^;]*)/.exec(line);
    if (!m) continue;
    const name = m[1].trim().toLowerCase();
    const val = m[2].trim();
    // 只认 cloudreve-session（其它子域同名 cookie 会干扰会话）
    if (name === 'cloudreve-session') cookie = `cloudreve-session=${val}`;
  }
}

async function api(method, path, body) {
  const headers = { 'Accept': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (method !== 'GET') {
    headers['Origin'] = ORIGIN;
    headers['Referer'] = ORIGIN + '/';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  saveSetCookie(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { httpStatus: res.status, json, raw: text.slice(0, 300) };
}

// 写请求前先 GET /site/config 拿最新 CSRF token（实测该响应头必有 x-csrf-token）
async function apiWithToken(method, path, body) {
  const cf = await fetch(BASE + '/site/config', {
    headers: { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'manual',
  });
  saveSetCookie(cf);
  csrf = cf.headers.get('x-csrf-token') || '';
  if (!csrf) throw new H1Error('GET /site/config 未返回 x-csrf-token');
  return api(method, path, body);
}

// 其他任何失败：最多重试（再尝试）N-1 次，默认 RETRY.GENERIC_ATTEMPTS 次尝试
async function genericAttempts(fn, label, log, attempts = RETRY.GENERIC_ATTEMPTS) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts) logMsg(log, `  [${label}] 第${i}次失败（${e.message}），重试…`);
    }
  }
  throw lastErr;
}

// ---------- 验证码 OCR ----------
async function recognizeCaptcha(log) {
  const r = await fetch(BASE + '/site/captcha?_=' + Date.now(), {
    headers: { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'manual',
  });
  saveSetCookie(r);
  const j = await r.json();
  if (j.code !== 0) throw new H1Error('captcha 获取失败: ' + (j.msg || r.raw));
  const b64 = j.data.split(',')[1];
  writeFileSync(CAPTCHA_PNG, Buffer.from(b64, 'base64'));
  let code = '';
  try {
    // 结果写入临时文件读取，避免子进程 stdout 管道捕获受限
    if (existsSync(OCR_OUT)) unlinkSync(OCR_OUT);
    execFileSync(PY_BIN, [OCR_HELPER, CAPTCHA_PNG, OCR_OUT], { stdio: 'ignore' });
    code = existsSync(OCR_OUT) ? readFileSync(OCR_OUT, 'utf8').trim() : '';
  } catch (e) {
    logMsg(log, `  [OCR] 子进程失败：${e.message}`);
  } finally {
    if (existsSync(CAPTCHA_PNG)) unlinkSync(CAPTCHA_PNG);
    if (existsSync(OCR_OUT)) unlinkSync(OCR_OUT);
  }
  logMsg(log, `  [OCR] 识别结果：${code || '（空）'}`);
  return code; // 可能为空/长度≠4，由调用方判定
}

// ---------- PoW（cloudreve-pow-v1）----------
// 协议来源：前端 bundle 逆向 + 实测。求解用纯 WebCrypto（与前端 WebCrypto 回退路径同算法）。

const POW_PROTOCOL = 'cloudreve-pow-v1'; // challenge.protocol 的取值（小写，用于校验）
const POW_ALGORITHM = 'PBKDF2-SHA-256';
// ⚠ 密码域分隔串是**大驼峰** "Cloudreve-PoW/v1"，与上面小写的协议标识**不是同一个字符串**
// （对应前端 worker 里的 protocolDomain 字节数组，末尾含 0x00）。两者混用会导致求解永远失败。
const POW_DOMAIN_STRING = 'Cloudreve-PoW/v1';
const POW_DOMAIN = Uint8Array.from(
  [...POW_DOMAIN_STRING, '\0'].map((c) => c.charCodeAt(0)),
);

function b64urlToBytes(value) {
  let s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return new Uint8Array(Buffer.from(s, 'base64'));
}

// 取 PoW 挑战。注意：该响应是**扁平 JSON**（无 {code,data} 信封），不能按常规响应解析。
async function fetchPowChallenge(purpose) {
  const r = await fetch(
    `${BASE}/site/captcha/pow?purpose=${encodeURIComponent(purpose)}&_=${Date.now()}`,
    {
      headers: { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      redirect: 'manual',
    },
  );
  saveSetCookie(r);
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!j?.token) throw new H1Error(`PoW 挑战获取失败(HTTP ${r.status}): ${(j && (j.error || j.msg)) || text.slice(0, 120)}`);
  return j;
}

// 求解：逐 counter 试 PBKDF2-SHA256(password, salt||uint32_be(counter), iterations) == target
async function solvePow(challenge) {
  if (challenge.protocol !== POW_PROTOCOL || challenge.algorithm !== POW_ALGORITHM) {
    throw new H1Error(`PoW 协议不匹配：${challenge.protocol}/${challenge.algorithm}`);
  }
  const nonce = b64urlToBytes(challenge.nonce);
  const baseSalt = b64urlToBytes(challenge.salt);
  const target = b64urlToBytes(challenge.target);
  const iterations = Number(challenge.iterations);
  const counterLimit = Number(challenge.counterLimit);
  if (!nonce.length || !baseSalt.length || !target.length || !(iterations > 0) || !(counterLimit > 0)) {
    throw new H1Error('PoW 挑战字段非法');
  }
  const password = new Uint8Array(POW_DOMAIN.length + nonce.length);
  password.set(POW_DOMAIN, 0);
  password.set(nonce, POW_DOMAIN.length);
  const key = await webcrypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  for (let counter = 0; counter < counterLimit; counter += 1) {
    const salt = new Uint8Array(baseSalt.length + 4);
    salt.set(baseSalt, 0);
    new DataView(salt.buffer).setUint32(baseSalt.length, counter, false); // 大端
    const bits = new Uint8Array(await webcrypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      key,
      256,
    ));
    if (bits.length === target.length && bits.every((b, i) => b === target[i])) return counter;
  }
  return null; // counterLimit 内未找到（正常不会发生）
}

// 取挑战 → 求解 → 返回可直接提交的 powPayload 字符串
async function powPayloadFor(purpose, log) {
  const challenge = await fetchPowChallenge(purpose);
  const t0 = Date.now();
  const counter = await solvePow(challenge);
  const ms = Date.now() - t0;
  if (counter === null) throw new H1Error(`PoW 求解失败：counterLimit(${challenge.counterLimit}) 内未找到答案`);
  logMsg(log, `  [PoW] purpose=${purpose} → counter=${counter}（求解 ${(ms / 1000).toFixed(1)}s）`);
  return JSON.stringify({ token: challenge.token, counter });
}

// ---------- 验证失败 / 终态错误码分类 ----------
// 实测（2026-09-26，真实账号）：
//   40026 = 图形验证码校验失败（漏带 captchaCode 也报这个）
//   40027 = PoW 校验失败（counter 错误 / token purpose 不符 / powPayload 非法 JSON）
//   40020 = 账号或密码错误（真·终态）
//   40001 = 参数错误（如密码为空）（真·终态）
//   401   = 未登录/会话过期（真·终态，本脚本不自动重登）
// 两条验证通路会返回**不同**的码，故必须都算「验证失败」才能正确换新验证码/挑战重试。
const VERIFICATION_FAILED_CODES = new Set([40026, 40027]);
const TERMINAL_CODES = new Set([40020, 40001, 401]);

// 是否属于「验证没通过」→ 应换新验证码/挑战重试
function isVerificationFailure(r) {
  if (VERIFICATION_FAILED_CODES.has(r.json?.code)) return true;
  // 兜底：站点若改码但保留文案，仍能识别（40026/40027 的 msg 均为这句）
  return /verification failed/i.test(String(r.json?.msg || ''));
}

// 是否属于「重试也无意义」的终态错误（凭据错误、未登录等）
function isTerminalFailure(r) {
  return TERMINAL_CODES.has(r.json?.code);
}

// ---------- 验证（默认 OCR，用尽后回退 PoW）----------
// 两种验证方式共用同一套驱动逻辑，只有「取载荷」与「字段名」不同：
//   图形验证码 → 载荷 "ABCD"（长度须为 4，否则直接换新验证码不浪费请求）
//   PoW       → 载荷 '{"token":"...","counter":123}'
// 返回 { ok, response }；耗尽时抛 H1Error。
//
// 分类策略（为了"绝不能因为站点小改动就全线失败"）：
//   成功              → 返回
//   验证失败(40026/27) → 换新验证码/挑战重试（耗尽后进入 PoW 兜底阶段）
//   真·终态(40020/401…)→ 立即返回失败，日志给出明确原因（重试无意义，省掉无效等待）
//   其它未知错误       → 一并重试（宁可多试，也不因站点换了个新错误码就放弃 PoW 兜底）
async function verifyThenPost({ url, buildBody, purpose, label, log, isSuccess = (r) => r.json?.code === 0 }) {
  // 阶段 1：图形验证码，最多 RETRY.CAPTCHA_ATTEMPTS 次
  let lastDetail = '';
  for (let attempt = 1; attempt <= RETRY.CAPTCHA_ATTEMPTS; attempt += 1) {
    logMsg(log, `[${label}] 第 ${attempt}/${RETRY.CAPTCHA_ATTEMPTS} 次：图形验证码 + OCR`);
    let code = '';
    try {
      code = await recognizeCaptcha(log);
    } catch (e) {
      lastDetail = `验证码获取失败：${e.message}`;
      logMsg(log, `  [${label}] ${lastDetail}，换新验证码`);
      continue;
    }
    if (code.length !== 4) {
      lastDetail = `OCR 长度≠4（${code || '空'}）`;
      logMsg(log, `  [${label}] ${lastDetail}，换新验证码`);
      continue;
    }
    let r;
    try {
      r = await genericAttempts(
        () => apiWithToken('POST', url, buildBody({ captchaCode: code })),
        `${label} POST(OCR)`,
        log,
      );
    } catch (e) {
      lastDetail = `请求异常：${e.message}`;
      logMsg(log, `  [${label}] ${lastDetail}，换新验证码重试`);
      continue;
    }
    if (isSuccess(r)) {
      logMsg(log, `  [${label}] ✅ 图形验证码通过（第 ${attempt} 次）`);
      return { ok: true, response: r };
    }
    if (isTerminalFailure(r)) {
      lastDetail = `终态错误 code=${r.json?.code}（${r.json?.msg || ''}），重试无意义`;
      logMsg(log, `  [${label}] ❌ ${lastDetail}`);
      return { ok: false, response: r };
    }
    if (isVerificationFailure(r)) {
      lastDetail = `验证失败(${r.json?.code})（${code}）`;
      logMsg(log, `  [${label}] ${lastDetail}，换新验证码`);
    } else {
      // 未知错误码：不立即放弃，继续换新验证码重试（耗尽后仍会走 PoW 兜底）
      lastDetail = `未知错误 HTTP ${r.httpStatus} code=${r.json?.code} ${r.json?.msg || r.raw}`;
      logMsg(log, `  [${label}] ${lastDetail}，换新验证码重试`);
    }
  }

  // 阶段 2：图形验证码用尽 → 回退 PoW，最多 RETRY.POW_ATTEMPTS 次
  logMsg(log, `  [${label}] 图形验证码 ${RETRY.CAPTCHA_ATTEMPTS} 次均失败（${lastDetail}），回退 PoW`);
  for (let attempt = 1; attempt <= RETRY.POW_ATTEMPTS; attempt += 1) {
    logMsg(log, `[${label}] PoW 第 ${attempt}/${RETRY.POW_ATTEMPTS} 次：purpose=${purpose}`);
    let payload = '';
    try {
      payload = await powPayloadFor(purpose, log);
    } catch (e) {
      lastDetail = `PoW 取挑战/求解失败：${e.message}`;
      logMsg(log, `  [${label}] ${lastDetail}，换新挑战`);
      continue;
    }
    let r;
    try {
      r = await genericAttempts(
        () => apiWithToken('POST', url, buildBody({ powPayload: payload })),
        `${label} POST(PoW)`,
        log,
      );
    } catch (e) {
      lastDetail = `请求异常：${e.message}`;
      logMsg(log, `  [${label}] ${lastDetail}，换新挑战重试`);
      continue;
    }
    if (isSuccess(r)) {
      logMsg(log, `  [${label}] ✅ PoW 通过（第 ${attempt} 次）`);
      return { ok: true, response: r };
    }
    if (isTerminalFailure(r)) {
      lastDetail = `终态错误 code=${r.json?.code}（${r.json?.msg || ''}），重试无意义`;
      logMsg(log, `  [${label}] ❌ ${lastDetail}`);
      return { ok: false, response: r };
    }
    if (isVerificationFailure(r)) {
      lastDetail = `PoW 校验失败(${r.json?.code})`;
      logMsg(log, `  [${label}] ${lastDetail}，换新挑战`);
    } else {
      lastDetail = `未知错误 HTTP ${r.httpStatus} code=${r.json?.code} ${r.json?.msg || r.raw}`;
      logMsg(log, `  [${label}] ${lastDetail}，换新挑战重试`);
    }
  }
  throw new H1Error(
    `${label}失败：图形验证码 ${RETRY.CAPTCHA_ATTEMPTS} 次 + PoW ${RETRY.POW_ATTEMPTS} 次均未成功（${lastDetail}）`,
  );
}

// ---------- 登录（默认图形验证码 ≤10，用尽回退 PoW ≤3） ----------
export async function login(user, password, log) {
  isLoggedIn = false;
  const r = await verifyThenPost({
    url: '/user/session',
    buildBody: (extra) => ({ userName: user, Password: password, ...extra }),
    purpose: 'login',
    label: '登录',
    log,
  });
  if (!r.ok) {
    throw new H1Error(`登录失败：HTTP ${r.response.httpStatus} ${r.response.json?.msg || r.response.raw}`);
  }
  isLoggedIn = true;
  logMsg(log, '  [登录] 成功');
}

// ---------- 目录 ----------
// netPath：不带前导斜杠的完整路径，如 `foldcraftlauncher_cn_auto/0/1/3/2/8`
export async function listDir(netPath, log) {
  const pathForApi = netPath.split('/').map(encodeURIComponent).join('/');
  const r = await genericAttempts(() => api('GET', '/directory/' + pathForApi), `列目录 ${netPath}`, log);
  if (r.json?.code === 40016) return { exists: false, objects: [] }; // 目录不存在
  if (r.json?.code !== 0) throw new H1Error(`列目录失败(HTTP ${r.httpStatus}): ${r.json?.msg || r.raw}`);
  return { exists: true, objects: r.json.data?.objects || [], parent: r.json.data?.parent };
}

// 幂等创建目录（PUT /directory 会连同中间目录一起创建）
export async function createDir(netPath, log) {
  const found = await listDir(netPath, log);
  if (found.exists) return found;
  logMsg(log, `  [目录] 创建 /${netPath}`);
  const r = await genericAttempts(
    () => apiWithToken('PUT', '/directory', { path: '/' + netPath }),
    `建目录 ${netPath}`,
    log,
  );
  if (r.json?.code !== 0 && r.json?.code !== 40016) {
    // 40016 兜底：偶发竞态（刚创建完又查），视为已存在
    throw new H1Error(`建目录失败(HTTP ${r.httpStatus}): ${r.json?.msg || r.raw}`);
  }
  return listDir(netPath, log);
}

// ---------- 删除目录（Cloudreve DELETE /object，见 api-notes §5.2） ----------
// 目录进回收站（force:true 也不跳过，48h 自动清除）；需 CSRF，删除前先列目录拿目录自身 id
export async function deleteDir(netPath, log) {
  const found = await listDir(netPath, log);
  if (!found.exists) {
    logMsg(log, `  [删除] 目录已不存在，跳过：/${netPath}`);
    return false;
  }
  const dirId = found.parent;
  if (!dirId) throw new H1Error(`删除目录失败：未取得目录 id（/${netPath}）`);
  logMsg(log, `  [删除] 删除目录 /${netPath}（id=${dirId}）`);
  const r = await genericAttempts(
    () => apiWithToken('DELETE', '/object', { items: [], dirs: [dirId], force: true }),
    `删除目录 ${netPath}`,
    log,
  );
  if (r.json?.code !== 0) throw new H1Error(`删除目录失败(HTTP ${r.httpStatus}): ${r.json?.msg || r.raw}`);
  logMsg(log, `  [删除] ✅ 已删除 /${netPath}`);

  // 向上清理空父目录：逐级检查上级目录是否已无任何对象，空则一并删除（含 foldcraftlauncher_cn_auto 根），
  // 直到遇到非空目录或没有更上层为止；避免 keepLatest 清理后残留一串空目录
  const segments = netPath.split('/').filter(Boolean);
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const parentPath = segments.slice(0, depth).join('/');
    const parent = await listDir(parentPath, log);
    if (!parent.exists) continue; // 上级已被删，继续往上
    if ((parent.objects || []).length > 0) break; // 上级非空，停止清理
    const pid = parent.parent;
    if (!pid) break;
    logMsg(log, `  [删除] 空父目录 /${parentPath} 一并删除（id=${pid}）`);
    const pr = await genericAttempts(
      () => apiWithToken('DELETE', '/object', { items: [], dirs: [pid], force: true }),
      `删空父目录 ${parentPath}`,
      log,
    );
    if (pr.json?.code !== 0) {
      logMsg(log, `  [删除] ⚠ 空父目录删除失败(HTTP ${pr.httpStatus}): ${pr.json?.msg || pr.raw}（继续尝试更上层）`);
    }
  }
  return true;
}

// ---------- 离线下载 ----------
// 收集正在下载中的任务（GET /aria2/downloading），返回匹配 dst 的文件名集合。
// 仅用于「重试时跳过已在下载中的文件」，不参与成败判定。
async function collectDownloadingNames(dst, wantNames) {
  const dstNorm = dst.replace(/^\/+|\/+$/g, '') || '/';
  const names = new Set();
  try {
    const r = await api('GET', '/aria2/downloading');
    for (const t of r.json?.data || []) {
      const tDst = (t.dst || '').replace(/^\/+|\/+$/g, '') || '/';
      if (tDst === dstNorm) {
        const taskName = t.name || t.files?.[0]?.path || '';
        if (wantNames.includes(taskName)) names.add(taskName);
      }
    }
  } catch {
    // 拿不到就视为无下载中任务，按原逻辑提交
  }
  return names;
}

// urls: GitHub release asset 直链数组；wantFiles: [{ name, size }]，与 urls 一一对应
// 返回 Map<文件名, {id,size}>（取自目录，size 与期望精确相等）
// 成败只看 pollForFiles：目录里出现全部期望文件且 size 匹配
// 失败（提交或轮询超时）抛 H1Error
export async function offlineDownload(urls, netPath, wantFiles, log) {
  const dst = '/' + netPath; // 实测提交时 dst 带前导斜杠
  const wantNames = wantFiles.map((w) => w.name);
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY.DOWNLOAD_ATTEMPTS; attempt += 1) {
    logMsg(log, `  [离线下载] 第 ${attempt}/${RETRY.DOWNLOAD_ATTEMPTS} 次：准备处理 ${wantFiles.length} 个文件`);
    try {
      await createDir(netPath, log);

      // 1) 目录中已存在且 size 匹配 → 跳过提交
      const dirNow = await listDir(netPath, log);
      const existingOk = new Set();
      if (dirNow.exists) {
        const byName = new Map(
          dirNow.objects.filter((o) => o.type === 'file').map((o) => [o.name, o]),
        );
        for (const w of wantFiles) {
          const o = byName.get(w.name);
          if (o && Number(o.size) === Number(w.size)) existingOk.add(w.name);
        }
      }
      if (existingOk.size > 0) {
        logMsg(log, `  [离线下载] 目录已存在 ${existingOk.size} 个匹配文件，跳过提交：${[...existingOk].join(', ')}`);
      }

      // 2) 已在下载中的任务 → 跳过重复提交（避免 xxx(1)）
      const downloadingNames = await collectDownloadingNames(dst, wantNames);
      if (downloadingNames.size > 0) {
        logMsg(log, `  [离线下载] 发现 ${downloadingNames.size} 个文件已在下载中，跳过重复提交`);
      }

      // 3) 待提交列表（url ↔ file 成对，避免下标错位）
      const pending = [];
      for (let i = 0; i < wantFiles.length; i += 1) {
        const w = wantFiles[i];
        if (!existingOk.has(w.name) && !downloadingNames.has(w.name)) {
          pending.push({ url: urls[i], file: w });
        }
      }

      // 4) 分批提交：每批提交后轮询等待本批文件就绪，再提交下一批，
      //    确保任意时刻网盘并行任务数不超过 LIMIT.OFFLINE_BATCH
      if (pending.length > 0) {
        for (let i = 0; i < pending.length; i += LIMIT.OFFLINE_BATCH) {
          const batch = pending.slice(i, i + LIMIT.OFFLINE_BATCH);
          const batchNo = Math.floor(i / LIMIT.OFFLINE_BATCH) + 1;
          const totalBatches = Math.ceil(pending.length / LIMIT.OFFLINE_BATCH);
          logMsg(
            log,
            `  [离线下载] 提交第 ${batchNo}/${totalBatches} 批（${batch.length} 个）：${batch.map((b) => b.file.name).join(', ')}`,
          );
          const r = await genericAttempts(
            () =>
              apiWithToken('POST', '/aria2/url', {
                url: batch.map((b) => b.url),
                dst,
                preferred_node: 0,
              }),
            '提交 aria2',
            log,
          );
          // 不因返回 code!==0 直接失败：可能"任务已存在/重复/部分 URL 失败"，
          // 真实状态由随后的目录轮询决定
          const bad = (r.json?.data || []).filter((x) => x?.code !== 0);
          if (bad.length > 0) {
            logMsg(
              log,
              `  [离线下载] 第 ${batchNo} 批提交返回非零码 ${bad.length} 个（${bad
                .map((b) => b.msg || '')
                .filter(Boolean)
                .join('; ')}），以目录文件列表为准继续等待`,
            );
          }
          logMsg(log, `  [离线下载] 等待第 ${batchNo} 批文件就绪…`);
          await pollForFiles(netPath, batch.map((b) => b.file), log);
          logMsg(log, `  [离线下载] ✅ 第 ${batchNo} 批文件已就绪`);
        }
      } else {
        logMsg(log, `  [离线下载] 全部 ${wantFiles.length} 个文件已在目录或下载中，跳过提交，直接轮询`);
      }

      // 5) 最终全量确认（含之前已在下载的 + 本次各批新下载的）
      return await pollForFiles(netPath, wantFiles, log);
    } catch (e) {
      lastErr = e;
      logMsg(log, `  [离线下载] 第 ${attempt} 次失败：${e.message}`);
      if (attempt < RETRY.DOWNLOAD_ATTEMPTS) await sleep(3000); // 下次提交前稍等
    }
  }
  throw new H1Error(`离线下载失败：${RETRY.DOWNLOAD_ATTEMPTS} 次均未成功（${lastErr?.message || ''}）`);
}

// 轮询：唯一成功判据 —— 目录里出现全部期望文件，且 size 精确相等。
// 不再查询 /aria2/finished，也不依赖任何 API 的 status/code 作为成败判据。
// wantFiles: [{ name, size }]，返回 Map<文件名, {id,size}>
async function pollForFiles(netPath, wantFiles, log) {
  const total = wantFiles.length;
  const deadline = Date.now() + ENV.DOWNLOAD_TIMEOUT_MS;
  let lastMatched = -1;
  while (Date.now() < deadline) {
    let dir;
    try {
      dir = await listDir(netPath, log);
    } catch {
      dir = { exists: false, objects: [] }; // 轮询中的瞬时失败，继续等
    }
    if (dir.exists) {
      const byName = new Map();
      for (const o of dir.objects) {
        if (o.type === 'file') byName.set(o.name, o);
      }
      const matched = new Map();
      const mismatched = [];
      for (const w of wantFiles) {
        const o = byName.get(w.name);
        if (!o) continue;
        if (Number(o.size) === Number(w.size)) {
          matched.set(w.name, { id: o.id, size: o.size });
        } else {
          mismatched.push(`${w.name}(${o.size}≠${w.size})`);
        }
      }
      // 进度只在"已匹配数量"变化时打，避免每 5s 刷屏
      if (matched.size !== lastMatched) {
        logMsg(
          log,
          `  [离线下载] 轮询中：${matched.size}/${total} 个文件已就绪` +
            (mismatched.length ? `；size 不符：${mismatched.join(', ')}` : ''),
        );
        lastMatched = matched.size;
      }
      if (matched.size === total) return matched;
    }
    await sleep(TIMING.POLL_INTERVAL_MS);
  }
  throw new H1Error(
    `轮询超时(${Math.round(ENV.DOWNLOAD_TIMEOUT_MS / 1000)}s)：${netPath} 未出现全部期望文件（含 size 校验）`,
  );
}

// ---------- 批量取直链（默认图形验证码 ≤10，用尽回退 PoW ≤3） ----------
// fileIds: 文件 id 数组；返回 [{id,url,name}]
export async function getSources(fileIds, log) {
  const r = await verifyThenPost({
    url: '/file/source',
    buildBody: (extra) => ({ items: fileIds, ...extra }),
    purpose: 'direct_link',
    label: '取直链',
    log,
    // 直链额外要求：返回条数与请求一致（与改造前判据相同）
    isSuccess: (x) =>
      x.json?.code === 0 && Array.isArray(x.json.data) && x.json.data.length === fileIds.length,
  });
  if (!r.ok) {
    throw new H1Error(`取直链失败：HTTP ${r.response.httpStatus} ${r.response.json?.msg || r.response.raw}`);
  }
  logMsg(log, `  [取直链] 成功（${fileIds.length} 个文件）`);
  return r.response.json.data;
}

export function isAuthed() {
  return isLoggedIn;
}