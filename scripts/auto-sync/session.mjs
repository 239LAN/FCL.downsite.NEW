// session.mjs — huang1111 会话 cookie 的解析与生命周期判定（2026-10-07 新增）
//
// ============================ 为什么需要这个 ============================
//
// 站点自 2026-10-07 起把 **登录** 改成交互式验证（policy.interactive.kind ∈ {click,text,slide}，
// 要求人眼在图形里点选/输入/拖动）。密码登录因此**无法自动化**，而自动同步必须无人值守。
//
// 实测确认的可行方案：**人工登录一次 → 复用会话 cookie**。其成立依据（全部为本地实测）：
//   · 取直链 purpose=direct_link 的 required.interactive = 0，**仍只需 PoW**（登录才要交互式）
//   · 只带 cloudreve-session 即可走完 PoW → policy → permit 全链路拿到直链
//     （cloudreve_observer 由 41700 响应自动补发，无需手工保存，尽管它自身只有 1 天寿命）
//   · 会话**不绑定 User-Agent**（无 UA / curl / Linux Chrome 均可认证）
//   · 会话**不绑定来源 IP**（换代理出口后依然有效）
//   · cloudreve-session 的 Max-Age = 5184000s = **60 天**，且**不滑动续期**（绝对过期）
//
// 于是本模块提供：从 cookie 值解出签发/到期时间、剩余天数与「临期档位」，
// 供 sync.mjs（每次运行打印到期时间）与 check-session.mjs（临期开 Issue）共用，
// 避免两处各算一遍导致口径漂移。
//
// ============================ cookie 结构 ============================
//
// Cloudreve 用 gorilla/securecookie，值为 base64url( 签发时间戳 | 载荷 | HMAC )：
//
//   MTc5MTMxMjczNXxOd3dBTkVK…            ← 整串
//   └─ base64 解码 ─→ "1791312735|NwwANFVIVFdBQzdR…|<24 字节 HMAC>"
//                      └──────────┘
//                       签发 Unix 秒
//
// 故**不需要联网**即可推出到期时间。这对 GHA 很重要：check-session.mjs 能在
// 不登录、不碰网盘的前提下判断会话还剩多久。

/** 会话 cookie 名（Cloudreve 固定用这个名字） */
export const SESSION_COOKIE_NAME = 'cloudreve-session';

/**
 * 会话有效期（秒）。
 *
 * ⚠⚠ 这是**实测得到的常量，不是从 cookie 里读出来的**。
 *
 * cookie 值只内嵌「签发时间」，**不含过期时间** —— 有效期是服务端配置。
 * 本值来源（2026-10-07 三方交叉验证，三者完全吻合）：
 *   · 实测响应头 `Set-Cookie: … Max-Age=5184000`
 *   · cookie 内嵌签发时间戳 → Firefox 数据库记录的到期时间，差值 5184001 秒
 *   · 两者换算均为 60.0000 天
 *
 * ⇒ 因此存在一个**固有风险**：若站点调整会话时长，本常量就会算错，
 *   可能把已失效的会话报成「健康」。两道防线：
 *     ① check-session.mjs 除了离线推算，还会**实际打一次 GET /user/me** 验证会话真伪
 *     ② 可用环境变量 `H1111_SESSION_TTL` 临时覆盖本值（站点改时长时不必改代码）
 */
const TTL_OVERRIDE = Number(process.env.H1111_SESSION_TTL);
export const SESSION_TTL_SECONDS =
  Number.isFinite(TTL_OVERRIDE) && TTL_OVERRIDE > 0 ? TTL_OVERRIDE : 5_184_000;

/** 临期档位（天）：剩余天数落到哪一档就提醒哪一档。0 表示已过期。 */
export const SESSION_BANDS = [30, 10, 1];

/**
 * 清洗用户提供的会话值，容忍常见的「复制粘贴脏值」。
 *
 * ⚠ 为什么必须做（实测 2026-10-07）：
 *   从浏览器 DevTools 复制 cookie 时，最常见的失误是**连名字一起复制**
 *   （`cloudreve-session=MTc5…`），其次是带引号、尾随换行、前后空格。
 *   这些脏值直接当 cookie 用会构造出畸形请求 → 服务端 401，
 *   而脚本只会报「会话已失效」—— 用户根本想不到是自己多粘了 18 个字符。
 *   （实测：`cloudreve-session=<值>` 与 `cloudreve-session = <值>` 均会 401。）
 *
 * 处理：
 *   · 去掉首尾空白（含 \r \n \t）
 *   · 去掉 `cloudreve-session=` / `cloudreve-session = ` 前缀（不区分大小写）
 *   · 去掉成对的引号（单/双）
 *   · 若形如 `a=b; c=d`，取 cloudreve-session 那一段；否则取第一段
 *
 * @param {string} value 原始值
 * @returns {string} 清洗后的值（可能是空串）
 */
export function normalizeSession(value) {
  let s = String(value ?? '').trim();
  if (!s) return '';

  // 形如 "cloudreve-session=xxx; other=yyy" → 优先挑出 cloudreve-session 段
  if (s.includes(';')) {
    const parts = s.split(';').map((x) => x.trim()).filter(Boolean);
    const hit = parts.find((p) => /^cloudreve-session\s*=/i.test(p));
    if (hit) s = hit;
    else if (parts.length) s = parts[0];
  }

  // 剥掉 `cloudreve-session=` / `cloudreve-session = ` 前缀
  s = s.replace(/^cloudreve-session\s*=\s*/i, '').trim();

  // 剥掉成对引号（DevTools 里"复制值"有时带引号）
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"'))
    || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * 从会话 cookie 值里解出**签发时间**（Unix 秒）。
 *
 * 结构见文件头：base64url → `"<签发秒>|<载荷>|<HMAC>"`。
 * 解不出时返回 null（值损坏 / 被截断 / 根本不是这个 cookie）。
 */
export function decodeSessionIssuedAt(value) {
  const raw = normalizeSession(value);
  if (!raw) return null;
  // 长度下限：真实值是 base64(10位时间戳 + '|' + 载荷 + '|' + 24字节HMAC)，编码后远超此数。
  // 太短的值必然是坏的（实测：截断到 20 字符的 base64 仍能"解出"一个合理时间戳，
  // 若不拦就会把损坏的 cookie 报成健康 —— 正是最该避免的静默失败）。
  if (raw.length < 60) return null;
  try {
    let s = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const buf = Buffer.from(s, 'base64');
    const sep = buf.indexOf(0x7c); // '|'
    if (sep <= 0) return null;
    // 结构完整性：真值形如 "<ts>|<载荷>|<HMAC>"，必须恰好有两段分隔，
    // 且载荷/HMAC 非空。截断的值往往只解出很短的一段，这里一并挡掉。
    const second = buf.indexOf(0x7c, sep + 1);
    if (second <= sep + 1 || second >= buf.length - 1) return null;
    const ts = Number(buf.subarray(0, sep).toString('latin1'));
    // 时间戳必须是 10 位十进制（2010-01-01 ~ 2100-01-01）
    if (!Number.isFinite(ts) || ts < 1_262_304_000 || ts > 4_102_444_800) return null;
    return ts;
  } catch {
    return null;
  }
}

/**
 * 会话整体状态。
 *
 * @param {string} value 会话 cookie 值（H1111_SESSION 的内容）
 * @param {{ now?: number }} [opts] now 为毫秒时间戳，默认 Date.now()；测试时可注入
 * @returns {{
 *   present: boolean,        // 是否提供了值
 *   parseable: boolean,      // 值能否解出签发时间
 *   valid: boolean,          // 现在是否还没过期
 *   issuedAt: number|null,   // Unix 秒
 *   expiresAt: number|null,  // Unix 秒
 *   secondsLeft: number|null,
 *   daysLeft: number|null,
 *   band: 30|10|1|0|null,    // 临期档位；0=已过期，null=还早（>30 天）
 *   reason: string,          // 不可用时的原因，可直接进日志
 * }}
 */
export function sessionInfo(value, opts = {}) {
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const raw = normalizeSession(value);
  if (!raw) {
    return {
      present: false, parseable: false, valid: false,
      issuedAt: null, expiresAt: null, secondsLeft: null, daysLeft: null, band: null,
      reason: '未提供会话 cookie',
    };
  }
  const issuedAt = decodeSessionIssuedAt(raw);
  if (!issuedAt) {
    return {
      present: true, parseable: false, valid: false,
      issuedAt: null, expiresAt: null, secondsLeft: null, daysLeft: null, band: null,
      reason: '无法解析签发时间（cookie 值可能不完整或已损坏）',
    };
  }
  const expiresAt = issuedAt + SESSION_TTL_SECONDS;
  const secondsLeft = expiresAt - Math.floor(nowMs / 1000);
  const daysLeft = secondsLeft / 86400;
  let band = null;
  if (secondsLeft <= 0) band = 0;
  // ⚠ 必须从**最小**档位往上找，取最紧的那一档。
  //   若按 SESSION_BANDS = [30,10,1] 的顺序往下找，剩 9 天会先命中 30 档就返回，
  //   把「只剩 9 天」报成「还有 30 天」，让人误判紧急程度（实测踩过）。
  else for (const b of [...SESSION_BANDS].sort((x, y) => x - y)) {
    if (daysLeft <= b) { band = b; break; }
  }

  return {
    present: true, parseable: true, valid: secondsLeft > 0,
    issuedAt, expiresAt, secondsLeft, daysLeft, band,
    reason: secondsLeft > 0 ? '' : '会话已过期，需重新人工登录',
  };
}

/** 只显示首尾各若干字符，便于在日志里指认是哪一份 cookie 而不泄露完整值。 */
export function maskSession(value) {
  const s = normalizeSession(value);
  if (!s) return '（空）';
  if (s.length <= 16) return `${s.slice(0, 4)}…（共 ${s.length} 字符）`;
  return `${s.slice(0, 6)}…${s.slice(-6)}（共 ${s.length} 字符）`;
}

/** Unix 秒 → `YYYY-MM-DD HH:mm`（UTC+8），用于日志与 Issue 正文。 */
export function fmtUnixCST(sec) {
  // ⚠ 必须先挡 null/undefined：Number(null) === 0 且 isFinite(0) 为真，
  //   否则「无签发时间」会被格式化成 1970-01-01，看起来像个正常日期（实测踩过）。
  if (sec === null || sec === undefined) return '（未知）';
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '（未知）';
  const d = new Date((n + 8 * 3600) * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 剩余时长的中文描述（如「59.9 天」「3.4 小时」「已过期 2.1 天」）。 */
export function fmtRemaining(secondsLeft) {
  const n = Number(secondsLeft);
  if (!Number.isFinite(n)) return '（未知）';
  const abs = Math.abs(n);
  const text = abs >= 86400 ? `${(abs / 86400).toFixed(1)} 天`
    : abs >= 3600 ? `${(abs / 3600).toFixed(1)} 小时`
      : `${Math.max(0, Math.round(abs / 60))} 分钟`;
  return n >= 0 ? text : `已过期 ${text}`;
}
