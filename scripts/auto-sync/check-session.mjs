// check-session.mjs — 会话 cookie 有效期巡检（在 probe job 中运行，不登录、不碰网盘）
// 运行：node scripts/auto-sync/check-session.mjs
//
// 背景：站点把登录改成交互式验证后，自动同步靠「人工登录一次拿到的会话 cookie」续命。
// 该 cookie **绝对 60 天过期、不滑动续期**，而用户住校期间无法人工干预。
// 因此必须有人在临期时提醒他 —— 本脚本就是这个提醒器。
//
// 行为：
//   · 每次都把剩余天数写进 run 日志与汇总页（成功运行也能看到寿命）
//   · 剩余天数进入 30 / 10 / 1 天档位，或**已过期**时 → 开一个 GitHub Issue
//     （GitHub 会把 Issue 通知发到邮箱，人在学校也收得到）
//   · 同一档位**只开一次**：靠 Issue 标题里带的到期日去重，避免每天刷屏
//   · 会话恢复正常后，自动关掉仍未关闭的提醒 Issue
//
// 本脚本**不读**账号密码、不发任何网盘请求（到期时间直接由 cookie 内嵌时间戳推出，见 session.mjs）。
//
// 需要环境变量：
//   H1111_SESSION   —— 会话 cookie 值（GHA secret 注入）
//   GITHUB_TOKEN    —— 由 GHA 自动注入；开/关 Issue 需要 issues: write 权限
//   GITHUB_REPOSITORY —— 由 GHA 自动注入（owner/repo 形式）

import { ENV } from './config.mjs';
import { Logger, errText, fmtDur } from './logger.mjs';
import {
  sessionInfo, maskSession, fmtUnixCST, fmtRemaining, SESSION_BANDS,
} from './session.mjs';

const log = new Logger({ rootTitle: '线路1 会话巡检' });
const t0 = Date.now();
const API = 'https://api.github.com';
const TOKEN = ENV.GITHUB_TOKEN;
const REPO = ENV.GITHUB_REPOSITORY;

const ISSUE_MARKER = '<!-- auto-sync-session-watchdog -->';
const ISSUE_LABEL = 'auto-sync/session';

async function ghApi(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, raw: text };
}

/**
 * 实际打一次 GET /user/me，验证会话到底还活着没有。
 *
 * 为什么不能只靠离线推算：到期时间是「内嵌签发时间 + 硬编码的 60 天常量」算出来的。
 * 站点若改了会话时长（或提前作废会话），离线推算会给出**错误的乐观结论** ——
 * 这是最糟的静默失败。所以这里直接问服务端，拿到权威答案。
 *
 * 本请求是**只读**的（GET /user/me），不改动网盘任何数据，也不消耗验证挑战。
 *
 * @returns {Promise<{ok:boolean, code:number|string, who?:string, reason?:string}>}
 */
async function liveCheck() {
  const headers = {
    Accept: 'application/json',
    'X-Cloudreve-Captcha-Protocol': '2', // 缺此头会得到 41709，与登录态无关
    Cookie: `cloudreve-session=${ENV.SESSION}`,
  };
  // 超时保护：巡检不该把 probe job 拖住
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(ENV.HOST + '/api/v3/user/me', { headers, redirect: 'manual', signal: ac.signal });
    const json = await res.json().catch(() => null);
    const code = json?.code;
    if (code === 0) {
      return { ok: true, code, who: json?.data?.nickname || json?.data?.user_name || '' };
    }
    if (code === 401) {
      return { ok: false, code, reason: '服务端返回 401（登录态无效/已过期）' };
    }
    return { ok: false, code, reason: `服务端返回 code=${code} ${json?.msg || ''}` };
  } catch (e) {
    // 网络异常不等于会话失效 —— 区分开，避免误报「请重新登录」
    return { ok: false, code: 'ERR', reason: `请求失败：${e.name === 'AbortError' ? '超时' : e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// 找出本脚本开过的、仍处于打开状态的 Issue
async function findOpenIssues() {
  if (!TOKEN || !REPO) return [];
  const r = await ghApi('GET', `/repos/${REPO}/issues?state=open&per_page=100&creator=github-actions[bot]`);
  if (r.status !== 200 || !Array.isArray(r.json)) return [];
  return r.json.filter((i) => typeof i.body === 'string' && i.body.includes(ISSUE_MARKER));
}

function issueTitle(expiresAt) {
  return `线路1自动同步：huang1111 会话 cookie 即将过期（到期 ${fmtUnixCST(expiresAt)}）`;
}

function issueBody(info, { expired = false, live = null } = {}) {
  const liveText = !live ? '（未验活）'
    : live.ok ? `✅ 服务端验活通过${live.who ? `（${live.who}）` : ''}`
      : `❌ ${live.reason}`;
  return [
    ISSUE_MARKER,
    '',
    expired
      ? '## ❌ huang1111 会话 cookie 已失效'
      : `## ⚠️ huang1111 会话 cookie 即将过期（剩余 ${fmtRemaining(info.secondsLeft)}）`,
    '',
    '线路1 自动同步依赖一份**人工登录**得到的会话 cookie（`H1111_SESSION`）。',
    '站点自 2026-10 起把登录改成了交互式图形验证，脚本无法自动登录，只能靠这份 cookie。',
    '',
    '| 项目 | 值 |',
    '|---|---|',
    `| 服务端验活 | ${liveText} |`,
    `| 会话签发时间 | ${fmtUnixCST(info.issuedAt)} |`,
    `| **到期时间** | **${fmtUnixCST(info.expiresAt)}**（按 60 天常量推算） |`,
    `| 剩余 | ${fmtRemaining(info.secondsLeft)} |`,
    `| cookie 指纹 | \`${maskSession(ENV.SESSION)}\` |`,
    '',
    '> 「到期时间」是由 cookie 内嵌的签发时间 + 实测的 60 天有效期常量算出来的，',
    '> **不是** cookie 里写明的字段。故上表第 1 行的「服务端验活」才是权威结论。',
    '',
    '### 怎么解决',
    '',
    '回家后在装了 Firefox 且已登录网盘的机器上执行（详见 `scripts/auto-sync/README.md`）：',
    '',
    '```powershell',
    'node scripts/auto-sync/tools/refresh-session.mjs',
    '```',
    '',
    '该命令会读取浏览器里的新会话并自动更新仓库 secret，之后本 Issue 会被自动关闭。',
    '',
    '> 本 Issue 由 `scripts/auto-sync/check-session.mjs` 自动创建。',
    '> 同一份会话只提醒一次；会话更新后会**自动关闭**。',
  ].join('\n');
}

async function ensureLabel() {
  if (!TOKEN || !REPO) return;
  // 404 = 标签不存在 → 创建；403/422 等一律忽略（没权限就退化成无标签 Issue，不影响提醒）
  const r = await ghApi('GET', `/repos/${REPO}/labels/${encodeURIComponent(ISSUE_LABEL)}`);
  if (r.status === 404) {
    await ghApi('POST', `/repos/${REPO}/labels`, {
      name: ISSUE_LABEL, color: 'd4c5f9', description: '线路1自动同步：会话 cookie 巡检',
    });
  }
}

async function closeIssue(n, why) {
  await ghApi('POST', `/repos/${REPO}/issues/${n}/comments`, { body: why });
  await ghApi('PATCH', `/repos/${REPO}/issues/${n}`, { state: 'closed', state_reason: 'completed' });
}

/**
 * 创建一条提醒 Issue（带去重）。
 *
 * 去重键是**标题**：同一份会话算出的到期时间恒定 → 标题恒定 → 每天巡检不会重复开。
 * 换了新会话（到期时间变）或未配置会话 → 标题不同 → 会另开一条。
 *
 * @returns {Promise<'created'|'duplicate'|'failed'|'no-permission'>}
 */
async function raiseIssue({ title, body, phase, known = null }) {
  let openIssues = known;
  let ghError = '';
  if (openIssues === null) {
    try {
      openIssues = await findOpenIssues();
    } catch (e) {
      ghError = errText(e);
      openIssues = [];
    }
  }
  if (!TOKEN || !REPO) ghError = ghError || '未设置 GITHUB_TOKEN / GITHUB_REPOSITORY';

  if (ghError) {
    // 拿不到 Issue 通道就退化成 GHA 注解：宁可只在运行页可见，也不要静默
    phase.warn(`⚠ 无法使用 Issue 通道（${ghError}）—— 已在运行页发出注解`);
    return 'no-permission';
  }

  const dup = openIssues.find((i) => i.title === title);
  if (dup) {
    phase.line(`已有未关闭的同类提醒（#${dup.number}），不重复创建`);
    return 'duplicate';
  }

  try {
    await ensureLabel();
    const r = await ghApi('POST', `/repos/${REPO}/issues`, { title, body, labels: [ISSUE_LABEL] });
    if (r.status === 201) {
      phase.line(`📮 已创建提醒 Issue #${r.json.number}`);
      return 'created';
    }
    phase.warn(`⚠ 创建 Issue 失败：HTTP ${r.status} ${r.json?.message || ''}`);
    return 'failed';
  } catch (e) {
    phase.warn(`⚠ 创建 Issue 异常：${errText(e)}`);
    return 'failed';
  }
}

// 未配置会话时的标题（也用于「无需重登」判定与恢复时自动关闭）
const NO_SESSION_TITLE = '线路1自动同步：未配置 H1111_SESSION，自动同步无法登录';

async function main() {
  const phase = log.child('会话有效期检查');
  const info = sessionInfo(ENV.SESSION);

  // ---- 情况 A：压根没配会话（回退到密码，或配置缺失）----
  // ⚠ 这一支**必须也开 Issue**：没配会话 = 同步必然失败（登录被交互式验证挡住），
  //   而这恰恰是无人值守期间最危险的静默失败。只在运行页打警告是不够的 ——
  //   人不在电脑前，看不到运行页。
  if (!info.present) {
    phase.line('未配置 H1111_SESSION（同步脚本会回退到账号密码登录，而站点已启用交互式验证 → 预计失败）');
    const result = await raiseIssue({
      title: NO_SESSION_TITLE,
      body: [
        ISSUE_MARKER,
        '',
        '## ❌ 未配置 `H1111_SESSION`，线路1自动同步无法登录',
        '',
        '站点自 2026-10 起把**登录**改成了交互式图形验证（人眼点选/输入/拖滑块），',
        '脚本无法自动登录，**必须**提供一份人工登录得到的会话 cookie。',
        '',
        '当前仓库 secret 里没有 `H1111_SESSION`，同步脚本会回退到账号密码登录 ——',
        '而那条路已被交互式验证挡住，**必定失败**，所有软件都不会同步。',
        '',
        '### 怎么解决',
        '',
        '在家里的电脑上（已登录网盘的 Firefox）：',
        '',
        '```powershell',
        'node scripts/auto-sync/tools/refresh-session.mjs',
        '```',
        '',
        '把输出的值粘到 **Settings → Secrets and variables → Actions → `H1111_SESSION`**。',
        '配置正确后本 Issue 会在下次巡检时**自动关闭**。',
        '',
        '> 详见 `scripts/auto-sync/README.md`「会话 cookie」一节。',
        '> 本 Issue 由 `scripts/auto-sync/check-session.mjs` 自动创建。',
      ].join('\n'),
      phase,
    });
    log.annotate('error', '线路1会话巡检：未配置 H1111_SESSION —— 自动同步必定失败，请立即配置');
    log.summary([
      '### 线路1 会话巡检',
      '',
      '| 项目 | 值 |',
      '|---|---|',
      '| 状态 | ❌ **未配置 `H1111_SESSION`** |',
      '| 影响 | 同步脚本回退到账号密码登录，而站点已启用交互式验证 → **必定失败** |',
      `| 提醒 Issue | ${result === 'created' ? '已创建' : result === 'duplicate' ? '已存在（未重复创建）' : '创建失败，见运行日志'} |`,
      '| 处理 | 按 `scripts/auto-sync/README.md`「会话 cookie」配置 |',
      '',
    ]);
    phase.close('❌ 未配置会话 cookie', { kind: 'fail' });
    log.flushSummary();
    process.exit(0); // 巡检本身不算失败，不阻断 probe（否则连同步机会都没了）
  }

  // ---- 汇报（无论健康与否都打印，符合「成功运行也输出过期时间」）----
  phase.line(`cookie：${maskSession(ENV.SESSION)}`);
  phase.line(`签发于 ${fmtUnixCST(info.issuedAt)}｜到期于 ${fmtUnixCST(info.expiresAt)}（按 60 天常量推算）`);
  phase.line(`剩余 ${fmtRemaining(info.secondsLeft)}`);

  if (!info.parseable) {
    phase.close(`⚠️ 无法解析会话：${info.reason}`, { kind: 'warn' });
    log.annotate('warning', `线路1会话巡检：无法解析 H1111_SESSION —— ${info.reason}`);
    // 也必须写汇总页：否则 GHA 概览里这一格是空的，看不出到底出了什么事
    log.summary([
      '### 线路1 会话巡检',
      '',
      '| 项目 | 值 |',
      '|---|---|',
      `| 状态 | ⚠️ **无法解析 \`H1111_SESSION\`** |`,
      `| 原因 | ${info.reason} |`,
      `| cookie 指纹 | \`${maskSession(ENV.SESSION)}\` |`,
      '',
      '> 会话值可能被截断、包含多余空白，或不是 `cloudreve-session` 的值。',
      '> 请用 `node scripts/auto-sync/tools/refresh-session.mjs` 重新提取并**完整**粘贴。',
      '',
    ]);
    log.flushSummary();
    process.exit(0);
  }

  // ---- 实际验活：不信任离线推算，直接问服务端 ----
  // 这一步能抓住「站点改了会话时长 / 提前作废会话」这类离线推算看不出来的情况。
  const live = await liveCheck();
  phase.line(live.ok
    ? `服务端验活：✅ 会话有效${live.who ? `（${live.who}）` : ''}`
    : `服务端验活：❌ ${live.reason}`);

  // 冲突处理：离线说「还早」但服务端说「无效」→ 以服务端为准（且要告警说明推算失准）
  const ttlSuspect = !live.ok && live.code === 401 && info.valid;
  if (ttlSuspect) {
    phase.warn('⚠ 离线推算显示未到期，但服务端已拒绝该会话 —— 站点可能调整了会话时长，');
    phase.warn('  请以实际失效为准；若确认站点改了时长，用 H1111_SESSION_TTL 覆盖（秒）或改 session.mjs 常量。');
  }
  // 网络异常（非 401）不该判定会话失效，避免误报让人白跑一趟
  const networkOnly = !live.ok && live.code === 'ERR';

  // ---- 决定是否需要开 Issue ----
  // 触发条件（任一）：
  //   · 离线推算进入 30/10/1 天档位
  //   · 服务端验活明确失败（401）
  const liveDead = live.ok === false && live.code === 401;
  const needAlert = info.band !== null || liveDead;
  // 「是不是已经彻底不能用了」——服务端说 401 就算算出来还没到期，也以服务端为准
  const expired = info.band === 0 || liveDead;
  const level = expired ? 'expired'
    : info.band === 1 ? '1'
      : info.band === 10 ? '10' : '30';

  let openIssues = [];
  let ghError = '';
  try {
    openIssues = await findOpenIssues();
  } catch (e) {
    ghError = errText(e);
  }

  if (needAlert) {
    const title = issueTitle(info.expiresAt);
    const body = issueBody(info, { expired, live });
    await raiseIssue({ title, body, phase, known: ghError ? [] : openIssues });

    const msg = expired
      ? '线路1会话巡检：会话 cookie 已失效！自动同步将失败，请更新 H1111_SESSION'
      : `线路1会话巡检：会话 cookie 剩余 ${fmtRemaining(info.secondsLeft)}（${level} 天档），请及时更新 H1111_SESSION`;
    log.annotate(expired ? 'error' : 'warning', msg);
    phase.close(
      expired ? '❌ 会话已失效' : `⚠️ 会话临期（剩余 ${fmtRemaining(info.secondsLeft)}）`,
      { kind: expired ? 'fail' : 'warn' },
    );
  } else {
    // 健康：顺手关闭历史提醒（含此前「未配置会话」那条 —— 配置补齐后它也该关掉）
    phase.line('✅ 会话有效期充裕（> 30 天）');
    if (openIssues.length && !ghError) {
      for (const i of openIssues) {
        try {
          const why = i.title === NO_SESSION_TITLE
            ? '✅ 已配置 H1111_SESSION，登录恢复正常，本提醒自动关闭。'
            : '✅ 会话 cookie 已更新，有效期恢复充裕，本提醒自动关闭。';
          await closeIssue(i.number, why);
          phase.line(`已关闭历史提醒 Issue #${i.number}`);
        } catch (e) {
          phase.warn(`⚠ 关闭 Issue #${i.number} 失败：${errText(e)}`);
        }
      }
    }
    phase.close('✅ 会话健康', { body: false });
  }

  // ---- 汇总页 ----
  const bandText = needAlert
    ? (expired ? '❌ 已失效' : `⚠️ 临期（${level} 天档）`)
    : '✅ 健康';
  const liveText = live.ok ? '✅ 通过' : `❌ ${live.reason}`;
  log.summary([
    '### 线路1 会话巡检',
    '',
    '| 项目 | 值 |',
    '|---|---|',
    `| 状态 | ${bandText} |`,
    `| 服务端验活 | ${liveText} |`,
    `| 签发时间 | ${fmtUnixCST(info.issuedAt)} |`,
    `| 到期时间（推算） | ${fmtUnixCST(info.expiresAt)} |`,
    `| 剩余 | ${fmtRemaining(info.secondsLeft)} |`,
    `| 提醒档位 | ${SESSION_BANDS.join(' / ')} 天（及已失效） |`,
    '',
    '> 到期时间 = cookie 内嵌签发时间 + 实测的 60 天常量（cookie 本身不含过期时间）。',
    '> 权威结论以「服务端验活」为准。',
    '',
  ]);

  if (!needAlert) {
    log.annotate('notice', `线路1会话巡检：会话健康，剩余 ${fmtRemaining(info.secondsLeft)}`);
  }
  log.line(`巡检结束：${bandText}｜用时 ${fmtDur(Date.now() - t0)}`);
  log.flushSummary();
  process.exit(0);
}

main().catch((e) => {
  const msg = errText(e);
  process.stderr.write(`会话巡检异常：${e.stack || msg}\n`);
  log.annotate('warning', `线路1会话巡检异常（不影响同步）：${msg}`);
  log.flushSummary();
  process.exit(0); // 巡检绝不阻断 probe
});
