// run-preview.mjs — 在沙箱仓库里跑**未经修改**的 scripts/auto-sync/sync.mjs，产出完整预览。
//
// 步骤：
//   1. 把仓库里与小仓库无关的部分（media 等）排除，只复制跑同步所需的最小树到临时目录
//   2. git init + 首次提交，让 commitSoftware / push 走真实 git 命令
//   3. 装上网络桩，import 真实的 sync.mjs 并执行 main
//   4. 打印：run 日志、GITHUB_STEP_SUMMARY、真实产生的 git commit 正文
//
// ⚠ 临时预览工具，用完即删。

import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const sandbox = mkdtempSync(join(tmpdir(), 'autosync-preview-'));

// ---- 1) 造沙箱仓库：只复制同步需要的东西 ----
mkdirSync(join(sandbox, 'scripts'), { recursive: true });
cpSync(join(REPO, 'scripts', 'auto-sync'), join(sandbox, 'scripts', 'auto-sync'), { recursive: true });
cpSync(join(REPO, 'data'), join(sandbox, 'data'), { recursive: true });

const git = (args, opts = {}) => execFileSync('git', ['-C', sandbox, ...args], { stdio: 'pipe', ...opts });
git(['init', '-q', '-b', 'main']);
git(['-c', 'user.name=preview', '-c', 'user.email=preview@local', 'add', '-A']);
git(['-c', 'user.name=preview', '-c', 'user.email=preview@local', 'commit', '-q', '-m', 'baseline']);
// 造一个本地 bare 仓库当 origin，让真实的 push() 能走成功路径
const originBare = mkdtempSync(join(tmpdir(), 'autosync-origin-'));
execFileSync('git', ['init', '-q', '--bare', originBare], { stdio: 'pipe' });
git(['remote', 'add', 'origin', originBare]);

// ---- 2) 装桩 + 环境变量 ----
await import('./stub.mjs');
process.env.H1111_USER = 'preview-user';
process.env.H1111_PASSWORD = 'preview-pass';
process.env.H1111_HOST = 'https://pan.huang1111.cn';
process.env.TZ = 'Asia/Shanghai';
const summaryPath = join(sandbox, 'summary.md');
process.env.GITHUB_STEP_SUMMARY = summaryPath;

// ---- 3) 捕获 stdout，跑真实的 sync.mjs ----
const chunks = [];
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (s, ...rest) => { chunks.push(String(s)); return true; };

const realLog = console.log;
console.log = (...a) => { chunks.push(a.join(' ') + '\n'); };

// sync.mjs 只在「被 node 直接执行」时跑 main()（判据 import.meta.url === argv[1]）。
// 把 argv[1] 指向沙箱里的真实文件即可走真实入口。
//
// 难点：main() 结尾 process.exit()，而它是被 main().catch(...) 调用的、没人 await。
// 直接 throw 会变成未捕获异常。做法：process.exit 只记录退出码并**永久挂起**该调用链
// （返回一个 pending Promise 并 await 它），预览进程则靠 exited 信号继续走自己的收尾。
const syncPath = join(sandbox, 'scripts', 'auto-sync', 'sync.mjs');
process.argv[1] = syncPath;
let exitCode = null;
let resolveExit;
const exited = new Promise((r) => { resolveExit = r; });
const origExit = process.exit.bind(process);
process.exit = (code = 0) => {
  if (exitCode === null) { exitCode = code; resolveExit(code); }
  // 永久挂起：既不退出进程，也不抛异常
  return new Promise(() => {});
};

try {
  const syncUrl = new URL('file://' + syncPath.replace(/\\/g, '/'));
  await import(syncUrl.href);
  // 等 main() 走到 process.exit；超时兜底，避免真卡死时预览无输出
  await Promise.race([exited, new Promise((r) => setTimeout(r, 30000))]);
  // 给它一点时间把最后几行写进 chunks
  await new Promise((r) => setTimeout(r, 300));
} catch (e) {
  chunks.push(`\n[预览] 运行异常：${e.stack || e.message}\n`);
}
process.exit = origExit;
process.stdout.write = origWrite;
console.log = realLog;

// ---- 4) 输出 ----
const runLog = chunks.join('');

realLog('\n' + '='.repeat(78));
realLog('  ①  RUN 日志（GitHub Actions 里看到的就是这个）');
realLog('='.repeat(78));
realLog(runLog.replace(/^\n+/, ''));

realLog('\n' + '='.repeat(78));
realLog('  ②  GITHUB_STEP_SUMMARY（Actions 运行页顶部「Summary」）');
realLog('='.repeat(78));
realLog(existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '（未生成）');

realLog('\n' + '='.repeat(78));
realLog('  ③  真实产生的 git commit（主旨 + 正文）');
realLog('='.repeat(78));
try {
  // 用 NUL 分隔，避免正文里的空行干扰切分
  const raw = execFileSync('git', ['-C', sandbox, 'log', '--format=%B%x00', '-n', '10'], { encoding: 'utf8' });
  const commits = raw.split('\0').map((s) => s.trim()).filter(Boolean);
  const real = commits.filter((c) => /\[GHA\]/.test(c));
  if (!real.length) realLog('（没有产生新提交）');
  real.forEach((c, i) => {
    realLog(`———— 第 ${i + 1} 个提交 ————\n`);
    realLog(c);
    realLog('\n');
  });
} catch (e) {
  realLog('（读取 commit 失败：' + e.message + '）');
}

// ---- 5) 断言 ----
realLog('='.repeat(78));
realLog('  ④  校验');
realLog('='.repeat(78));
const checks = [];
// 逐条检查每个真实产生的提交（而不是只看最新一条）
let bodies = [];
try {
  const raw = execFileSync('git', ['-C', sandbox, 'log', '--format=%B%x00', '-n', '10'], { encoding: 'utf8' });
  bodies = raw.split('\0').map((s) => s.trim()).filter((s) => s && /\[GHA\]/.test(s));
} catch { /* 忽略 */ }

checks.push(['run 日志含树形缩进 ├─', /├─ /.test(runLog)]);
checks.push(['run 日志无 ::group:: 折叠', !/::group::/.test(runLog)]);
checks.push(['run 日志无行首时间戳', !/^\[\d{4}-\d{2}-\d{2}/m.test(runLog)]);
checks.push(['run 日志无末尾重打', !/--- 完整日志 ---/.test(runLog)]);
checks.push(['产生了 2 个软件的提交', bodies.length === 2]);
for (const b of bodies) {
  const id = (/资源 id=(\d+)/.exec(b) || [])[1] || '?';
  checks.push([`id=${id} 主旨以 [GHA] 开头`, /^\[GHA\] /.test(b)]);
  checks.push([`id=${id} 正文含资源 id 小节`, b.includes(`资源 id=${id}`)]);
  checks.push([`id=${id} 正文含直链`, /pan\.huang1111\.cn\/f\//.test(b)]);
  checks.push([`id=${id} 正文无时间戳前缀`, !/^\s*\[\d{4}-\d{2}-\d{2}/m.test(b)]);
  checks.push([`id=${id} 正文无阶段级噪声`, !/阶段 [123]/.test(b)]);
  checks.push([`id=${id} 正文无登录噪声`, !/求解中…|正常请求/.test(b)]);
  const otherIds = bodies.map((x) => (/资源 id=(\d+)/.exec(x) || [])[1]).filter((x) => x && x !== id);
  checks.push([`id=${id} 正文不含其他软件`, otherIds.every((o) => !b.includes(`资源 id=${o}`))]);
}
checks.push(['汇总含详细表头', /资源 id \| 仓库 \| 数据源最新/.test(readFileSync(summaryPath, 'utf8'))]);
for (const [name, ok] of checks) realLog(`${ok ? '✅' : '❌'} ${name}`);

realLog('\n沙箱：' + sandbox + '（保留以便你查看；不需要时可删）');
const failed = checks.filter(([, ok]) => !ok).length;
process.exitCode = failed ? 1 : 0;
