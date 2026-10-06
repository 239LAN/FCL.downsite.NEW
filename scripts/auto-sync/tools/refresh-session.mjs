// refresh-session.mjs — 从浏览器取出 huang1111 会话 cookie，方便更新 GitHub Secret
//
// ============================ 用途 ============================
//
// 站点把**登录**改成交互式验证（图形点选/输入/拖滑块）后，自动同步靠一份人工登录得到的会话
// cookie 续命（仓库 secret `H1111_SESSION`）。该 cookie **60 天**过期、不滑动续期。
//
// 回家时在浏览器里登录一次，跑本脚本，它会：
//   ① 逐个扫描 Firefox profile，读出 cloudreve-session
//   ② **实测验活**（GET /user/me），挑出「确实是登录态」的那一份 —— 见下方 ⚠
//   ③ 显示它还剩多久，并把值复制到剪贴板
// 然后你去 GitHub 仓库设置里粘贴覆盖 `H1111_SESSION` 即可。
//
// ⚠⚠ 为什么必须实测验活（实测教训，2026-10-07）：
//   站点对**匿名访问**也会签发 cloudreve-session，而且**每次请求都换新的**
//   （连续三次匿名请求 /site/config，内嵌时间戳持续前进）。
//   因此「cookie 存在」「cookie 很新」都**不能**说明已登录 ——
//   光看时间戳会把匿名 cookie 当成健康登录态，粘进 secret 后定时任务全部 401，
//   而日志却显示「剩余 60 天，健康」。本脚本因此直接问服务端，未登录就报错拒绝输出。
//
// 用法（在仓库根目录）：
//   node scripts/auto-sync/tools/refresh-session.mjs
//   node scripts/auto-sync/tools/refresh-session.mjs --cookie "cloudreve-session=xxx"   # 手动给值
//   node scripts/auto-sync/tools/refresh-session.mjs --no-copy                          # 不碰剪贴板
//
// ⚠ 只读浏览器数据库（复制副本后查询，不动原文件）。
//   值会**完整打印**（这是给你复制的），但不会写入任何文件、不会上传到任何地方。
//
// 注：原本还想过用 PAT 自动写 secret，但那要求实现 libsodium sealed box 加密，
//     为此手写密码学不划算（且验证成本高于收益）。手动粘贴一次 1 分钟，够用。

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, readFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { sessionInfo, maskSession, fmtUnixCST, fmtRemaining } from '../session.mjs';

const SECRET_NAME = 'H1111_SESSION';
const argv = process.argv.slice(2);
const argVal = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const NO_COPY = argv.includes('--no-copy');
const MANUAL = argVal('--cookie');

function fail(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1); }

/**
 * 列出 Firefox profile。
 * 与站点相关的 cookie 可能存在任一 profile 里，故全部扫描（实测只有 dev-edition 那个有）。
 */
function listFirefoxProfiles() {
  const appdata = process.env.APPDATA;
  if (!appdata) return [];
  const iniPath = join(appdata, 'Mozilla', 'Firefox', 'profiles.ini');
  if (!existsSync(iniPath)) return [];
  const ini = readFileSync(iniPath, 'utf8');
  const out = [];
  for (const s of ini.split(/^\[/m).slice(1)) {
    if (!/^Profile\d+\]/.test(s)) continue;
    const get = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(s)?.[1]?.trim();
    const p = get('Path');
    if (!p) continue;
    out.push({
      name: get('Name') || p,
      dir: get('IsRelative') === '0' ? p : join(appdata, 'Mozilla', 'Firefox', p),
      isDefault: get('Default') === '1',
    });
  }
  return out;
}

/**
 * 从某个 profile 读出会话 cookie。
 *
 * ⚠ 必须把 cookies.sqlite 连同 -wal / -shm 一起复制：
 *   Firefox 运行时用 WAL 模式，最近的写入还在 -wal 里；
 *   只复制主库会读到**过期数据**（实测因此把刚登录的会话误判成无效）。
 */
function readSessionFromProfile(profileDir) {
  const dbPath = join(profileDir, 'cookies.sqlite');
  if (!existsSync(dbPath)) return null;
  const dir = mkdtempSync(join(tmpdir(), 'h1refresh-'));
  const tmp = join(dir, 'cookies.sqlite');
  for (const s of ['', '-wal', '-shm']) {
    if (existsSync(dbPath + s)) copyFileSync(dbPath + s, tmp + s);
  }
  try {
    const d = new DatabaseSync(tmp, { readOnly: true });
    const row = d.prepare(
      `SELECT value FROM moz_cookies
       WHERE name='cloudreve-session' AND host LIKE '%huang1111%'
       ORDER BY LENGTH(path) DESC LIMIT 1`,
    ).get();
    d.close();
    return row?.value || null;
  } catch {
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
  }
}

/**
 * 实际打一次 GET /user/me，确认这份 cookie **真的是登录态**。
 *
 * ⚠⚠ 为什么必须验活（实测教训）：
 *   站点对**匿名访问**也会签发 cloudreve-session，而且每次都换新的
 *   （连续三次匿名请求，内嵌时间戳持续前进）。
 *   所以「cookie 签发时间很新」**完全不能**说明「已登录」——
 *   光看时间戳会把一个匿名 cookie 当成健康的登录态，用户粘进 secret 后
 *   定时任务全部 401，而日志还显示「剩余 60 天，健康」。
 *   这是最危险的一类静默失败，故此处直接问服务端。
 *
 * @returns {Promise<{ok:boolean, who?:string, reason?:string}>}
 */
async function verifySession(value) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch('https://pan.huang1111.cn/api/v3/user/me', {
      headers: {
        Accept: 'application/json',
        'X-Cloudreve-Captcha-Protocol': '2', // 缺此头会得到 41709，与登录态无关
        Cookie: `cloudreve-session=${value}`,
      },
      redirect: 'manual',
      signal: ac.signal,
    });
    const json = await res.json().catch(() => null);
    if (json?.code === 0) {
      return { ok: true, who: json.data?.nickname || json.data?.user_name || '' };
    }
    if (json?.code === 401) {
      return { ok: false, reason: '服务端返回 401（这份 cookie 是**匿名**的，不是登录态）' };
    }
    return { ok: false, reason: `服务端返回 code=${json?.code} ${json?.msg || ''}` };
  } catch (e) {
    return { ok: false, reason: `请求失败：${e.name === 'AbortError' ? '超时' : e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 把文本放进剪贴板（Windows）。失败不影响主流程。 */
function copyToClipboard(text) {
  try {
    // 用 clip.exe 而非 Set-Clipboard，避免依赖 PowerShell 的可用性
    const p = execFileSync('clip.exe', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    return p === undefined || true;
  } catch {
    return false;
  }
}

console.log('huang1111 会话 cookie 提取工具\n');

// ---- ① 取 cookie ----
let cookie = '';
let source = '';
if (MANUAL) {
  cookie = MANUAL.replace(/^\s*cloudreve-session\s*=\s*/i, '').trim();
  source = '命令行 --cookie';
} else {
  const profiles = listFirefoxProfiles();
  if (!profiles.length) {
    fail('没找到 Firefox。请确认装过 Firefox，或用 --cookie "cloudreve-session=…" 手动提供。');
  }
  // 逐个 profile 取 cookie **并实测验活**，优先选「确实是登录态」的那一个。
  // ⚠ 不能只取第一个有 cookie 的 profile：匿名访问也会留下 cookie，
  //   而用户真正登录的可能是另一个 profile（本机就有 3 个 profile）。
  const candidates = [];
  console.log('逐个检查 Firefox profile（每个都会实测验活）：');
  for (const p of profiles) {
    const v = readSessionFromProfile(p.dir);
    if (!v) {
      console.log(`  ·  ${p.name}：无 huang1111 cookie`);
      continue;
    }
    const r = await verifySession(v);
    console.log(`  ${r.ok ? '✅' : '❌'} ${p.name}${p.isDefault ? '（默认）' : ''}：`
      + (r.ok ? `已登录（${r.who}）` : r.reason));
    candidates.push({ ...p, value: v, verify: r });
  }
  const good = candidates.find((x) => x.verify.ok);
  if (good) {
    cookie = good.value;
    source = `Firefox profile「${good.name}」${good.isDefault ? '（默认）' : ''}`;
  } else if (candidates.length) {
    // 有 cookie 但都不是登录态 —— 这正是「匿名 cookie」陷阱，必须明确阻断
    console.log();
    fail('找到 cookie，但**没有一个是有效登录态**：\n'
      + candidates.map((c) => `     · ${c.name}：${c.verify.reason}`).join('\n') + '\n\n'
      + '   ⚠ 站点对匿名访问也会签发 cloudreve-session，所以「cookie 很新」不代表已登录。\n'
      + '   请在浏览器里**真正登录** https://pan.huang1111.cn（完成交互式验证，\n'
      + '   确认页面右上角显示你的用户名），然后再重跑本脚本。');
  } else {
    fail('所有 Firefox profile 里都没有 cloudreve-session。\n'
      + '   请先在 Firefox 里登录 https://pan.huang1111.cn（完成交互式验证），再重跑本脚本。');
  }
}

// ---- ② 实测验活：确认这份 cookie 真的是登录态 ----
// ⚠ 这一步是必需的，理由见 checkSession 的注释（匿名访问也会签发新 cookie）。
const live = await verifySession(cookie);
if (!live.ok) {
  fail(`该 cookie 不是有效登录态：${live.reason}\n`
    + '   请在浏览器里真正登录后再试（确认页面右上角显示用户名）。\n'
    + '   ⚠ 注意：站点对匿名访问也会签发 cloudreve-session，所以不能只看 cookie 是否存在/是否新鲜。');
}

// ---- ③ 报寿命 ----
const info = sessionInfo(cookie);
console.log(`\n来源：${source}`);
console.log(`指纹：${maskSession(cookie)}`);
console.log(`验活：✅ 服务端确认已登录${live.who ? `（${live.who}）` : ''}`);
if (info.parseable) {
  console.log(`签发：${fmtUnixCST(info.issuedAt)}`);
  console.log(`到期：${fmtUnixCST(info.expiresAt)}（按实测 60 天有效期推算）`);
  console.log(`剩余：${fmtRemaining(info.secondsLeft)}`);
  if (!info.valid) {
    console.log('\n⚠ 这份会话按推算已过期 —— 但服务端仍认它，请以服务端为准。');
  }
} else {
  console.log(`⚠ 无法解析签发时间：${info.reason}（不影响使用，只是算不出到期日）`);
}

// ---- ④ 输出，供粘贴 ----
console.log(`\n${'='.repeat(64)}`);
console.log(`把它粘贴到 GitHub → 仓库 Settings → Secrets and variables → Actions`);
console.log(`→ 更新 secret  ${SECRET_NAME}`);
console.log('='.repeat(64));
console.log(cookie);
console.log('='.repeat(64));

if (!NO_COPY) {
  const ok = copyToClipboard(cookie);
  console.log(ok
    ? '\n✅ 已复制到剪贴板，直接去 GitHub 粘贴即可。'
    : '\n⚠ 复制到剪贴板失败，请手动选中上面那一行复制。');
}

console.log('\n提示：更新后跑一次 Actions（线路1自动同步 → Run workflow）确认能登录；');
console.log('      若之前开过「会话临期」通知 Issue，下次巡检会自动关闭它。\n');
