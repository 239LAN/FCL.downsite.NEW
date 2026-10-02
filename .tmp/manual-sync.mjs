// manual-sync.mjs — 线路1 本地交互式手动同步（临时工具，放在 .tmp/，不参与 GHA）
//
// 与 GHA 的关系：复用 scripts/auto-sync 的正式实现，逻辑完全同源 ——
//   · h1api.mjs  → 登录 / captcha policy v2 验证链路 / 离线下载 / 取直链
//   · sync.mjs   → syncVersion / updateIndex / verifySyncedData / pruneSoftware / commitSoftware / push
// 与 GHA 唯一的区别：版本候选由你在 Release 列表中手动选择，而非按 index.json 基线自动判定。
//
// 用法：node .tmp/manual-sync.mjs
// 流程：仓库地址 → huang1111 账号密码 →（未收录仓库时补充参数）→ 列出 Release 供选择
//       → 已同步版本询问「强制重跑 / 跳过」→ 选择 git 操作 → 确认 → 登录并同步
//
// 说明：
//   · 凭据只驻留内存，不落盘；可选环境变量 GITHUB_TOKEN 可提高 GitHub API 限额
//   · 未收录仓库的补充参数仅本次运行使用，不写入 softwares.json
//   · 同步完成后的 git 操作三选一：a=提交+推送（完整 GHA 流程）/ c=仅本地提交 / n=不提交

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';

import * as h1 from '../scripts/auto-sync/h1api.mjs';
import {
  ctx, ROOT, SOFTWARES,
  parseDataSourceIndex, versionKnown, versionFromTag, compareVersionsDescending, fetchReleases,
} from '../scripts/auto-sync/lib.mjs';
import {
  syncVersion, updateIndex, verifySyncedData, pruneSoftware, commitSoftware, push,
} from '../scripts/auto-sync/sync.mjs';

// ============================ 交互输入 ============================
const input = process.stdin;
const output = process.stdout;

class InputEnded extends Error {
  constructor(message = '交互输入已结束（stdin 已关闭）') {
    super(message);
    this.name = 'InputEnded';
  }
}

emitKeypressEvents(input);
// 兜底：无论以何种方式退出，都恢复终端模式
process.on('exit', () => {
  try { if (input.isTTY) input.setRawMode(false); } catch { /* ignore */ }
});

// 非 TTY（管道/重定向）：一次性读完 stdin，按行排队弹出
let pipeQueue = null;
async function nextPipeLine() {
  if (!pipeQueue) {
    input.setEncoding('utf8');
    let raw = '';
    for await (const chunk of input) raw += chunk;
    pipeQueue = raw.split(/\r?\n/);
    if (pipeQueue.length && pipeQueue[pipeQueue.length - 1] === '') pipeQueue.pop();
  }
  return pipeQueue.length ? pipeQueue.shift() : null;
}

// TTY：raw 模式逐键读取，支持掩码（密码）、退格、Ctrl+C
function readLineTTY(prompt, mask) {
  return new Promise((resolve) => {
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    let buf = '';
    const onKey = (str, key) => {
      if (key?.ctrl && key?.name === 'c') {
        cleanup();
        output.write('\n');
        console.log('已取消（Ctrl+C）');
        process.exit(130);
      } else if (key?.name === 'return' || key?.name === 'enter') {
        cleanup();
        output.write('\n');
        resolve(buf);
      } else if (key?.name === 'backspace') {
        if (buf.length) {
          buf = buf.slice(0, -1);
          output.write('\b \b');
        }
      } else if (str && str >= ' ' && !key?.ctrl && !key?.meta && key?.name !== 'escape') {
        buf += str;
        output.write(mask ? '*' : str);
      }
    };
    const cleanup = () => {
      input.removeListener('keypress', onKey);
      input.setRawMode(false);
      input.pause();
    };
    input.on('keypress', onKey);
  });
}

// 读取一行；非 TTY 时输入耗尽抛 InputEnded
async function readLine(prompt, { mask = false } = {}) {
  if (!input.isTTY) {
    output.write(prompt);
    const line = await nextPipeLine();
    output.write(line === null ? '（输入结束）\n' : '（非交互输入）\n');
    if (line === null) throw new InputEnded();
    return line;
  }
  return readLineTTY(prompt, mask);
}

// 读取一个非空文本；def 非 null 时允许空回车取默认值（def 可为空串）
async function askText(prompt, { mask = false, def = null, validate = null } = {}) {
  for (;;) {
    const line = await readLine(prompt, { mask });
    const v = mask ? line : line.trim(); // mask（密码）保留原样：首尾空格可能是密码的一部分
    if (v === '') {
      if (def !== null) return def;
      console.log('  ⚠ 不能为空，请重新输入');
      continue;
    }
    if (validate && !validate(v)) {
      console.log('  ⚠ 输入无效，请重新输入');
      continue;
    }
    return v;
  }
}

// ============================ 小工具 ============================
// 显示宽度（CJK 记 2 列），用于表格对齐
function dispWidth(s) {
  let w = 0;
  for (const c of String(s)) w += /[\u1100-\uFFE6]/.test(c) ? 2 : 1;
  return w;
}
const padEndW = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dispWidth(s)));
function truncateW(s, n) {
  const str = String(s);
  const cw = (c) => (/[\u1100-\uFFE6]/.test(c) ? 2 : 1);
  let w = 0;
  let out = '';
  for (const c of str) {
    if (w + cw(c) > n) {
      // 需要截断：回退到 n-3 宽再加 ASCII 省略号，保证结果宽度不超过 n（终端对 … 的渲染宽度不一致）
      let out2 = '';
      let w2 = 0;
      for (const c2 of str) {
        if (w2 + cw(c2) > n - 3) break;
        w2 += cw(c2);
        out2 += c2;
      }
      return out2 + '...';
    }
    w += cw(c);
    out += c;
  }
  return out;
}

// Release 发布时间 → UTC+8 展示串
function fmtDateCST(iso) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 项目根相对路径（统一正斜杠）
const rel = (p) => p.slice(ROOT.length).replace(/\\/g, '/').replace(/^\//, '');

// 仓库地址解析：接受 owner/repo、https://github.com/owner/repo(/…)、git@github.com:owner/repo.git
function parseRepo(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i.exec(s);
  if (m) return `${m[1]}/${m[2].replace(/\.git$/i, '')}`;
  const m2 = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (m2) return `${m2[1]}/${m2[2].replace(/\.git$/i, '')}`;
  return null;
}

// ============================ 配置匹配 / 询问 ============================
function findSoftware(repo) {
  const lower = repo.toLowerCase();
  return SOFTWARES.find((s) => String(s.githubRepo).toLowerCase() === lower) || null;
}

// 未收录仓库：交互补充本次运行参数（不写回 softwares.json）
async function askSoftwareConfig(repo) {
  console.log(`ℹ 仓库 ${repo} 未在 softwares.json 收录，请补充本次同步参数（仅本次运行使用，不写入配置文件）`);
  const idRaw = await askText('  站内软件 id（对应 data/down/{id}）：', { validate: (v) => /^\d+$/.test(v) });
  const filterRaw = await askText('  资产过滤正则（回车默认 \\.apk$；输入 - 表示不过滤全部资产）：', {
    def: '\\.apk$',
    validate: (v) => {
      if (v === '-') return true;
      try { new RegExp(v); return true; } catch { return false; }
    },
  });
  const mode = await askText('  输出模式（arch=按架构出条目 / name=按文件名出条目；回车默认 name）：', {
    def: 'name',
    validate: (v) => v === 'arch' || v === 'name',
  });
  let archNames = [];
  let fallbackArch = null;
  if (mode === 'arch') {
    for (;;) {
      const archRaw = await askText('  架构列表（逗号分隔，如 all,arm64-v8a；可回车留空）：', { def: '' });
      archNames = archRaw ? archRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
      const fb = await askText('  fallback 架构（无法识别的 .apk 归入此架构；可回车留空）：', { def: '' });
      fallbackArch = fb || null;
      if (archNames.length || fallbackArch) break;
      console.log('  ⚠ arch 模式至少需要「架构列表」或「fallback 架构」其一，请重填');
    }
  }
  const keepRaw = await askText('  keepLatest（保留最新 N 个版本，0=不清理；回车默认 0）：', {
    def: '0',
    validate: (v) => /^\d+$/.test(v),
  });
  return {
    softwareId: Number(idRaw),
    githubRepo: repo,
    assetFilter: filterRaw === '-' ? null : filterRaw,
    mode,
    archNames,
    fallbackArch,
    keepLatest: Number(keepRaw),
    includePrerelease: false,
  };
}

// ============================ Release 列表 ============================
// 拉取全部非 draft Release（含 prerelease，展示时标 [pre]），逐条计算版本名 / 资产匹配数 / 已同步状态
async function fetchReleaseRows(repo, sw, entries) {
  console.log(`\n正在拉取 GitHub Releases：${repo} …`);
  const releases = await fetchReleases(repo, true);
  const filterRe = sw.assetFilter ? new RegExp(sw.assetFilter) : null;
  const rows = [];
  const seen = new Set();
  for (const r of releases) {
    const version = versionFromTag(r.tag_name);
    if (seen.has(version)) continue; // 归一化后重名（如 v1.0 与 "v1.0"）只保留第一个
    seen.add(version);
    const all = r.assets || [];
    const matched = filterRe ? all.filter((a) => filterRe.test(a.name || '')) : all;
    rows.push({
      release: r,
      version,
      prerelease: !!r.prerelease,
      assetsMatched: matched.length,
      assetsTotal: all.length,
      known: versionKnown(entries, version),
    });
  }
  return rows;
}

function printReleaseTable(rows) {
  console.log('');
  console.log('  ' + padEndW('序号', 6) + padEndW('Tag', 30) + padEndW('标题', 38) + padEndW('发布时间(UTC+8)', 18) + padEndW('匹配资产', 10) + '状态');
  console.log('  ' + '-'.repeat(110));
  rows.forEach((row, i) => {
    const tag = truncateW(String(row.release.tag_name) + (row.prerelease ? ' [pre]' : ''), 28);
    const title = truncateW(row.release.name || '—', 36);
    const assets = `${row.assetsMatched}/${row.assetsTotal} 个`;
    const state = row.known ? '✅ 已同步' : '🆕 未同步';
    console.log(
      `  ${padEndW(String(i + 1), 6)}${padEndW(tag, 30)}${padEndW(title, 38)}${padEndW(fmtDateCST(row.release.published_at), 18)}${padEndW(assets, 10)}${state}`,
    );
  });
  console.log('');
}

// 选择输入解析：支持 1 / 1,3 / 2-4 / all / q
function parseSelection(text, max) {
  const t = String(text || '').trim().toLowerCase();
  if (t === 'q' || t === 'quit' || t === 'exit') return { quit: true, items: [] };
  if (t === 'all' || t === 'a' || t === '*') {
    return { quit: false, items: Array.from({ length: max }, (_, i) => i + 1) };
  }
  const out = new Set();
  for (const part of t.split(/[,，\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-~]\s*(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > max || a > b) return null;
    for (let i = a; i <= b; i += 1) out.add(i);
  }
  return out.size ? { quit: false, items: [...out].sort((x, y) => x - y) } : null;
}

async function askSelection(max) {
  for (;;) {
    let line;
    try {
      line = await readLine('请选择要同步的 Release（如 1,3-5；all=全部；q=退出）：');
    } catch (e) {
      if (e instanceof InputEnded) return { quit: true, items: [] };
      throw e;
    }
    const sel = parseSelection(line, max);
    if (sel) return sel;
    console.log('  ⚠ 输入无效：示例 1、1,3、2-4、all、q');
  }
}

// ============================ 执行同步（复用 GHA 逻辑） ============================
const GIT_MODE_TEXT = {
  a: '提交 + 推送（完整 GHA 流程）',
  c: '仅本地提交（不推送）',
  n: '不提交（只写文件）',
};

async function runSync({ sw, entries, todo, gitMode, user, password }) {
  console.log('\n==== 登录 huang1111 ====');
  try {
    await h1.login(user, password, (m) => ctx.log(m));
  } catch (e) {
    console.log('❌ 登录失败：' + e.message);
    process.exitCode = 1;
    return;
  }

  // 与 GHA 相同：拦截 ctx.log，本软件这段日志作为 commit body
  const swLog = [];
  const origLog = ctx.log.bind(ctx);
  ctx.log = (msg) => { swLog.push(msg); origLog(msg); };

  let failed = false;
  const synced = [];
  try {
    for (const item of todo) {
      console.log(`\n══ 版本 ${item.version} ══`);
      try {
        const result = await syncVersion(sw, item.version, item.release);
        if (result) synced.push(result);
        else ctx.log(`  ⚠ 版本 ${item.version} 无可用资产，跳过`);
      } catch (e) {
        failed = true;
        ctx.log(`  ❌ 版本 ${item.version} 同步失败（按重试策略耗尽仍失败）：${e.message}`);
      }
    }

    if (!synced.length) {
      ctx.log('（本次无成功同步的版本，不更新 index.json）');
    } else {
      mkdirSync(join(ROOT, 'data', 'down', String(sw.softwareId)), { recursive: true });
      const indexPath = updateIndex(sw.softwareId, entries, synced);
      ctx.log(`    ✅ 已更新 ${rel(indexPath)}（+${synced.length} 个版本）`);
      verifySyncedData(sw, synced);
      await pruneSoftware(sw);

      if (gitMode === 'n') {
        console.log('\nℹ 未提交（按选择 n）。数据文件已写入，可自行 git add / commit。');
      } else {
        const versionList = synced.map((s) => s.version).sort(compareVersionsDescending).join('&');
        ctx.log(`    提交版本列表：${versionList}`);
        const committed = commitSoftware(sw.softwareId, versionList, swLog);
        if (committed && gitMode === 'a') {
          console.log('\n==== 推送远程 ====');
          push();
        } else if (committed) {
          console.log('\nℹ 已本地提交（未推送）。需要时可手动 git push。');
        }
      }
    }
  } catch (e) {
    failed = true;
    ctx.log(`❌ ${e.message}`);
  } finally {
    ctx.log = origLog;
  }

  console.log('\n==== 完成 ====');
  if (failed) {
    console.log('⚠ 存在失败项，详见上方日志。');
    process.exitCode = 1;
  } else if (synced.length) {
    console.log(`✅ 成功同步 ${synced.length} 个版本：${synced.map((s) => s.version).join('、')}`);
  }
}

// ============================ 主流程 ============================
async function main() {
  console.log('==================================================');
  console.log(' 线路1 本地交互式手动同步（复用 GHA 正式逻辑）');
  console.log('==================================================');
  console.log('提示：Ctrl+C 随时取消；可选环境变量 GITHUB_TOKEN 提高 GitHub API 限额\n');

  // 1) 仓库地址
  let repo = null;
  for (;;) {
    const s = await askText('请输入 GitHub 仓库（owner/repo 或仓库 URL）：');
    repo = parseRepo(s);
    if (repo) break;
    console.log('  ⚠ 无法解析，示例：FCL-Team/FoldCraftLauncher 或 https://github.com/FCL-Team/FoldCraftLauncher');
  }
  console.log(`→ 仓库：${repo}`);

  // 2) huang1111 凭据
  const user = await askText('请输入 huang1111 账号：');
  const password = await askText('请输入 huang1111 密码（输入不回显）：', { mask: true });

  // 3) 软件配置（匹配 softwares.json，未收录则补充参数）
  let sw = findSoftware(repo);
  if (sw) {
    console.log(`ℹ 已收录：softwareId=${sw.softwareId}，mode=${sw.mode}${sw.assetFilter ? `，assetFilter=${sw.assetFilter}` : '，不过滤资产'}${sw.keepLatest ? `，keepLatest=${sw.keepLatest}` : ''}`);
  } else {
    sw = await askSoftwareConfig(repo);
  }

  // 4) 数据源基线（data/down/{id}/index.json）
  let entries = [];
  try {
    entries = parseDataSourceIndex(sw.softwareId).entries;
    console.log(`数据源基线：data/down/${sw.softwareId}/index.json 读取成功（${entries.length} 个条目）`);
  } catch (e) {
    console.log(`⚠ 读取 data/down/${sw.softwareId}/index.json 失败：${e.message}（按空基线处理）`);
  }

  // 5) 拉取并展示 Release 列表
  let rows;
  try {
    rows = await fetchReleaseRows(repo, sw, entries);
  } catch (e) {
    console.log('❌ 拉取 GitHub Releases 失败：' + e.message);
    process.exitCode = 1;
    return;
  }
  if (!rows.length) {
    console.log('该仓库没有可选 Release（draft / tag 不含数字的会被排除）');
    return;
  }
  printReleaseTable(rows);
  console.log(`共 ${rows.length} 个 Release；[pre] 为预发布；「已同步」按 index.json 判定。`);

  // 6) 选择
  const sel = await askSelection(rows.length);
  if (sel.quit) {
    console.log('已取消');
    return;
  }
  const chosen = sel.items.map((i) => rows[i - 1]);

  // 7) 已同步版本 → 询问强制重跑 / 跳过
  for (const item of chosen) {
    if (!item.known) continue;
    let ans = '';
    try {
      ans = await readLine(`  版本 ${item.version} 已同步过：[f] 强制重跑 / [s] 跳过（回车默认跳过）：`);
    } catch (e) {
      if (!(e instanceof InputEnded)) throw e;
    }
    item.force = /^f/i.test(ans.trim());
  }
  const todo = chosen.filter((x) => !x.known || x.force);
  const skipped = chosen.length - todo.length;
  if (!todo.length) {
    console.log('\n所选版本全部跳过（均已同步过），无事可做。');
    return;
  }

  // 8) git 操作
  console.log('\n同步完成后的 git 操作（GHA 完整流程 = 分软件提交 + push）：');
  console.log('  a) 提交 + 推送');
  console.log('  c) 仅本地提交（不推送）');
  console.log('  n) 不提交（只写 data/down 文件）');
  let gitMode = '';
  try {
    gitMode = (await readLine('请选择（回车默认 a）：')).trim().toLowerCase();
  } catch (e) {
    if (!(e instanceof InputEnded)) throw e;
  }
  if (!['a', 'c', 'n'].includes(gitMode)) gitMode = 'a';

  // 9) 摘要确认
  console.log('\n================ 执行计划 ================');
  console.log(` 仓库      ：${repo}`);
  console.log(` 软件 id   ：${sw.softwareId}（${sw.mode} 模式${sw.assetFilter ? `，资产过滤 ${sw.assetFilter}` : '，不过滤资产'}）`);
  console.log(` 待同步版本：${todo.map((t) => t.version + (t.force ? '（强制重跑）' : '')).join('、')}`);
  if (skipped) console.log(` 跳过版本  ：${skipped} 个（已同步）`);
  console.log(` git 操作  ：${GIT_MODE_TEXT[gitMode]}`);
  console.log(` 登录账号  ：${user}（登录需解 PoW，可能耗时数十秒）`);
  console.log('==========================================');
  let confirm = '';
  try {
    confirm = await readLine('回车开始同步；输入 n 取消：');
  } catch (e) {
    if (!(e instanceof InputEnded)) throw e;
    confirm = 'n';
  }
  if (/^n/i.test(confirm.trim())) {
    console.log('已取消');
    return;
  }

  // 10) 执行
  await runSync({ sw, entries, todo, gitMode, user, password });
}

main().catch((e) => {
  if (e instanceof InputEnded) {
    console.log('\n已取消：输入结束');
    process.exitCode = 1;
    return;
  }
  console.error('\n❌ 脚本异常：' + (e.stack || e.message));
  process.exitCode = 1;
});