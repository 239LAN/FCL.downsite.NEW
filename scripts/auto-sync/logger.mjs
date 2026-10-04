// logger.mjs — 线路1 自动同步统一日志（sync.mjs / probe.mjs / manual-sync.mjs 共用）
//
// 设计约定：
//   · 不打印时间戳：GitHub Actions 自带每行上报时间，本地也不需要逐行时间
//   · 缩进由作用域层级自动生成（每级 2 空格），调用方不再手拼前导空格
//   · GHA 下自动输出折叠分组（::group:: / ::endgroup::）与注解（::error:: / ::warning::）；
//     控制指令只走控制台、不进内容流，所以绝不会混进 commit 正文
//   · beginCapture()/endCapture() 收集指定范围内的正文行（含缩进）供 commit 正文使用，
//     不再"运行结束再把整份日志重放一遍"
//   · GITHUB_STEP_SUMMARY 汇总行单独收集，结束时一次性落盘
//
// 层级示例：
//   ▶ 阶段 2：登录并同步
//     ▸ 软件 id=0（FCL-Team/FoldCraftLauncher）
//       ▸ 版本 1.0.5
//         [离线下载] 提交第 1/1 批（3 个）：...
//         ✅ 已写 data/down/0/auto/2026/10/5/1.0.5.json
//       ✅ 已更新 data/down/0/index.json（+1 个版本）
//       ✅ 已提交：[GHA] 新增：...

import { ENV } from './config.mjs';

const INDENT = '  '; // 每级缩进

const state = {
  depth: 0,
  captures: [], // 活跃采集器：Array<{ base: number, bucket: string[] }>
  summary: [],  // GITHUB_STEP_SUMMARY markdown 行
  timers: new Map(),
};

const indentAt = (depth, text) => (text ? INDENT.repeat(depth) + text : '');

// 采集时按"采集起点"为 0 级重新缩进，保证 commit 正文首行不携带无谓前导缩进
function pushCapture(text) {
  for (const cap of state.captures) {
    cap.bucket.push(indentAt(Math.max(0, state.depth - cap.base), text));
  }
}

// 正文行：控制台输出 + 进入当前所有采集器
function emit(text) {
  console.log(indentAt(state.depth, text));
  pushCapture(text);
  return text;
}

// GHA 控制指令：只走控制台，绝不进入采集器（因此不会混进 commit 正文）
function command(cmd) {
  if (ENV.IS_GHA) console.log(cmd);
}

// ::error:: / ::warning:: 的消息需按 GHA 规则转义
const escapeAnnotation = (msg) =>
  String(msg).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

// 打开一个作用域。GHA 下用折叠组承载标题，避免标题在日志里重复两遍；
// 本地直接打印标题行。两种模式下采集器都能拿到标题行，保证 commit 正文结构完整。
function openScope(marker, title) {
  const label = `${marker} ${title}`;
  if (ENV.IS_GHA) {
    console.log(`::group::${label}`);
    pushCapture(label);
  } else {
    emit(label);
  }
  state.depth += 1;
}

function closeScope() {
  if (state.depth > 0) state.depth -= 1;
  command('::endgroup::');
}

export const logger = {
  // ---------- 作用域 ----------
  phase(title) { openScope('▶', title); },
  scope(title) { openScope('▸', title); },
  endScope() { closeScope(); },

  // ---------- 正文 ----------
  banner(title) { return emit(`━━━ ${title} ━━━`); },
  log(msg) { return emit(String(msg)); },
  ok(msg) { return emit(`✅ ${msg}`); },
  warn(msg) { command(`::warning::${escapeAnnotation(msg)}`); return emit(`⚠ ${msg}`); },
  error(msg) { command(`::error::${escapeAnnotation(msg)}`); return emit(`❌ ${msg}`); },
  fail(msg) { return emit(`❌ ${msg}`); },
  blank() { return emit(''); },

  // ---------- 计时（返回毫秒） ----------
  start(name) { state.timers.set(name, Date.now()); },
  end(name) {
    const t0 = state.timers.get(name);
    state.timers.delete(name);
    return t0 == null ? 0 : Date.now() - t0;
  },

  // ---------- 汇总页（GITHUB_STEP_SUMMARY） ----------
  sum(text) { state.summary.push(String(text)); },
  async flushSummary() {
    const p = process.env.GITHUB_STEP_SUMMARY;
    if (!p || !state.summary.length) return;
    const { appendFileSync } = await import('node:fs');
    appendFileSync(p, state.summary.join('\n') + '\n');
  },

  // ---------- 采集（commit 正文） ----------
  // 返回一个"实时"数组：调用方在需要时（如提交前）即可取用当前已收集的正文行
  beginCapture() {
    const bucket = [];
    state.captures.push({ base: state.depth, bucket });
    return bucket;
  },
  endCapture() {
    return state.captures.pop()?.bucket || [];
  },
};

export default logger;
