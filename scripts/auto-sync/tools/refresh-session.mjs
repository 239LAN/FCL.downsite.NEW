// refresh-session.mjs — 从浏览器取出 huang1111 会话 cookie，方便更新 GitHub Secret
//
// ============================ 用途 ============================
//
// 站点把**登录**改成交互式验证（图形点选/输入字符）后，自动同步靠一份人工登录得到的会话
// cookie 续命（仓库 secret `H1111_SESSION`）。该 cookie **60 天**过期、不滑动续期。
//
// 回家时在浏览器里登录一次，跑本脚本，它会：
//   ① 从 Firefox 读出最新的 cloudreve-session
//   ② 显示它还剩多久（顺带确认这次登录是新鲜的）
//   ③ 把 cookie 值复制到剪贴板，并打印出来
// 然后你去 GitHub 仓库设置里粘贴覆盖 `H1111_SESSION` 即可。
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
import { copyFileSync, existsSync, readFileSync, unlinkSync, mkdtempSync } from 'node:fs';
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
    for (const s of ['', '-wal', '-shm']) {
      try { unlinkSync(tmp + s); } catch { /* 清理失败无妨 */ }
    }
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
  for (const p of profiles) {
    const v = readSessionFromProfile(p.dir);
    if (v) {
      cookie = v;
      source = `Firefox profile「${p.name}」${p.isDefault ? '（默认）' : ''}`;
      break;
    }
  }
  if (!cookie) {
    fail('所有 Firefox profile 里都没有 cloudreve-session。\n'
      + '   请先在 Firefox 里登录 https://pan.huang1111.cn（完成交互式验证），再重跑本脚本。');
  }
}

// ---- ② 报寿命，确认这份是新鲜的 ----
const info = sessionInfo(cookie);
console.log(`来源：${source}`);
console.log(`指纹：${maskSession(cookie)}`);
if (info.parseable) {
  console.log(`签发：${fmtUnixCST(info.issuedAt)}`);
  console.log(`到期：${fmtUnixCST(info.expiresAt)}（按实测 60 天有效期推算）`);
  console.log(`剩余：${fmtRemaining(info.secondsLeft)}`);
  if (!info.valid) {
    console.log('\n⚠ 这份会话已经过期了 —— 请先在浏览器里重新登录，再重跑本脚本。');
  } else if (info.band === null) {
    console.log('\n✅ 会话新鲜，有效期充裕。');
  }
} else {
  console.log(`⚠ 无法解析签发时间：${info.reason}`);
}

// ---- ③ 输出，供粘贴 ----
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
console.log('      若之前开过「会话临期」提醒 Issue，下次巡检会自动关闭它。\n');
