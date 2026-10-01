// config.mjs — 线路1 自动同步：环境变量与全局常量
// 仅从环境变量读凭据（GHA secret 注入 / 本地手动 export），仓库内不落任何凭据。

export const ENV = {
  // 网盘 API（默认线上源，测试可覆盖）
  HOST: (process.env.H1111_HOST || 'https://pan.huang1111.cn').replace(/\/+$/, ''),
  USER: process.env.H1111_USER || '',
  PASSWORD: process.env.H1111_PASSWORD || '',
  // GitHub 相关（GHA 自动注入；本地运行时可不带）
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || '',
  GITHUB_REF_NAME: process.env.GITHUB_REF_NAME || '',
  IS_GHA: process.env.GITHUB_ACTIONS === 'true',
  // 单个版本的离线下载轮询上限（毫秒），可按需覆盖
  DOWNLOAD_TIMEOUT_MS: Number(process.env.AUTO_SYNC_DOWNLOAD_TIMEOUT_MS || 2 * 60 * 1000),
};

// 重试策略
// 说明（2026-10-02 起，站点已改为 captcha policy v2，旧的「图形验证码/裸 PoW」两条路全部作废）：
//   验证流程变为一次「挑战 → 许可」链路：正常请求 → 41700 拿 policy → 解 PoW
//   → POST /site/captcha/policy 换许可 → 带 X-Cloudreve-Captcha-Permit 重发原请求。
//   因此不再有「换新验证码 10 次」「回退 PoW 3 次」的分阶段重试，改为**整条链路按次重试**。
//   详情见 h1api.mjs 文件头与 docs/huang1111-api-notes.md §0.3 / §0.7。
export const RETRY = {
  VERIFY_ATTEMPTS: 3,     // 完整验证链路（41700 → PoW → policy → permit 重发）：最多 3 次，
                          // 每次换新 policy/挑战（41701 许可被拒、挑战过期等都在此重走）
  POW_SOLVE_TIMEOUT_MS: Number(process.env.AUTO_SYNC_POW_TIMEOUT_MS || 150 * 1000),
                          // 单次 PoW 求解硬超时。求解为单线程逐 counter 试算（counterLimit 上限 5000），
                          // 耗时随答案位置浮动，需留足余量；同时受挑战自身 expiresAt（约 1200s）约束，两者取小。
  DOWNLOAD_ATTEMPTS: 3,   // 离线下载失败：整段「提交+轮询」最多 3 次
  GENERIC_ATTEMPTS: 2,    // 其他任何失败（网络/接口异常）：最多 2 次
};

export const TIMING = {
  POLL_INTERVAL_MS: 5000,          // 离线下载轮询间隔
  POW_PROGRESS_INTERVAL_MS: 5000,  // PoW 求解进度日志间隔（单线程首次求解可能要几十秒，避免以为卡死）
  COOLDOWN_DEFAULT_MS: 5000,       // 41702 限流未给 retry_after 时的默认退避
};

// 批量提交上限（huang1111 对离线下载任务数有限制，需分批提交）
export const LIMIT = {
  OFFLINE_BATCH: 5, // 离线下载每批提交的 URL 数
};
