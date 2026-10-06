# huang1111 网盘 API 逆向解析（Cloudreve v3 定制版）

> 状态：**2026-10-07 起「登录」改成交互式验证（人眼点选/输入/拖滑块），无法自动化**；取直链不受影响。
> 自动同步因此改用「人工登录一次 + 复用会话 cookie（`H1111_SESSION`，60 天）」，见 §0.8。
>
> 历史：站点 2026-10-02 升级为 **captcha policy v2**（旧的「图形验证码 captchaCode」与「裸 PoW powPayload」两条通路作废），
> 现为「41700 挑战 → PoW → policy 许可 → permit 重发」两段式。
> 记录日期：2026-08-25（3.8.5 重测 2026-08-26；2026-08-28 全面复核并修订过时/错误项 + 扩展新端点；2026-09-26 新增 PoW 协议章节；2026-10-02 重写 §0.3 / §0.6 / §0.7 为 captcha policy v2；**2026-10-07 新增 §0.8 交互式验证与会话复用**）
> 来源：真实登录态会话实测 + 前端 JS bundle 分析（`pan.huang1111.cn/static/js/`，版本 `3.8.7`）
> 范围：仅收录已实测端点；"已失效/未实测"见 §9
> 复核：站点若再改验证机制，用项目外测试目录里的 `_probe-v2-*.mjs` 探针快速确认（路径与用法见 [`auto-sync-design.md`](auto-sync-design.md) 开头）。返回 `41709` 多半是协议头/版本变了。

---

## 0. 通用约定

### 0.1 Base URL

```
https://pan.huang1111.cn/api/v3
```

### 0.2 认证

- 全部 API 基于**会话 cookie**：`cloudreve-session`（`pan.huang1111.cn` 域）
- 未登录 / cookie 过期 → `code: 401`（"Login required"）
- 登录用户信息同时存于 `localStorage.user`（JSON），含 `id`、`user_name`、`nickname`、`group`

### 0.3 登录（账号密码 + captcha policy v2 验证 + CSRF）

> ⚠️ **2026-10-02 起验证协议换版**。下面这套流程是当前唯一可用路径；旧的 `captchaCode` / `powPayload` 字段已彻底失效。

**前置条件（两条都必须满足，否则必然失败）**

1. **所有请求**都要带请求头 `X-Cloudreve-Captcha-Protocol: 2`。
   缺失（或值为 `1`）→ 一律 HTTP 200 + `code: 41709`「Please update this page to use the new verification. / 请更新页面后使用新版验证。」
2. **必须携带全部 cookie**：`cloudreve-session` + `cloudreve_observer` + `cloudreve_send`。
   只带 `cloudreve-session` 时 `POST /site/captcha/policy` 恒返回 `41701`（实测，见下方对照表）。
   > 旧版本文档写的「`cloudreve_observer` 实测非必需」**已失效**。

**完整流程（挑战 → 许可）**

```
① POST /user/session（或 POST /file/source）
   带 X-Cloudreve-Captcha-Protocol: 2 + CSRF + 全部 cookie
   body: { userName, Password }        // 注意：不再有 captchaCode / powPayload

② 若需要验证 → HTTP 200 + code=41700，**policy 对象直接内嵌在响应 data 里**
   {
     "code": 41700,
     "data": {
       "id": "a1fc2e10…",                       // policy id，即后续的「许可」
       "purpose": "login",
       "required": { "interactive": 0, "pow": "compatible", "level": 0, "reason": "normal" },
       "revision": "a4588c6eadc3d0f9",
       "expires": 1790874379,
       "pow": { …PoW 挑战，见 §0.7… },           // 注意：token 已绑定该 policy.id
       "interactive_done": true,                // required.interactive=0 时直接为 true，无需滑块
       "pow_done": false,
       "ready": false
     },
     "msg": "Additional verification required. …"
   }

③ 解 PoW（算法与上一版一致，见 §0.7）→ 提交许可
   POST /api/v3/site/captcha/policy
   { "id": "<policy.id>", "pow_payload": "{\"token\":\"…\",\"counter\":123}" }
   → { "code": 0, "data": { …同结构…, "pow_done": true, "ready": true }, "msg": "" }
   ⚠ 字段名是 **`pow_payload`（下划线）**，值是 JSON.stringify 后的**字符串**；
     **不是** `powPayload`，**不是** `captchaCode`，**不是**嵌套对象。
   ⚠ 响应里的 `data.id` 与请求的 `id` **相同**（不轮换）。

④ 重发原请求，附加请求头 `X-Cloudreve-Captcha-Permit: <policy.id>`
   → 这才拿到真实业务结果（成功，或 40020 账号密码错误等终态码）
```

- 对应前端实现：webpack module 197 的 `ensure()`（`param` 注册 + `captchaParamsRef`）+ axios 响应拦截器对 `41700` 的自动重试（最多 2 次），拦截器会给重发请求补上 `X-Cloudreve-Captcha-Permit`
- 单独调用 `GET /site/captcha/pow?purpose=…` 仍返回 200 且带 `token`，但**该 token 未绑定 policy**，**不能**用于 `POST /site/captcha/policy` —— 必须用 41700 内嵌的 `data.pow`（实测见 §0.7 🔑）
- `interactive_done`/`pow_done` 都是 `required` 的**完成标记**，不是"要不要做"

**许可（permit）的生命周期（实测，2026-10-02）**

- **可复用**：同一 `policy.id` 作为 `X-Cloudreve-Captcha-Permit` 连续重发 3 次，均被接受（都进入业务层返回 `40020`/`40001`），**不是一次性的**
- **有时效**：policy 的 `expires`（实测签发后约 1200s）过期后需重新走验证链路
- ⚠️ 前端只在**单个请求**层面复用它（拦截器原地重发），**未实测跨 purpose 复用**（`login` 的许可拿去发 `/file/source`）。若要省 PoW 求解开销，需自行实测确认；`h1api.mjs` 采取保守策略，**每个 endpoint 各自走完整链路**
- ⚠️ **`POST /file/source` 的登录态校验发生在验证之前**：未登录时直接 `401 Login required`，根本不会回 `41700`。故测试验证链路时若拿到 `401`，应先确认会话是否有效，而不是去查验证协议

**cookie 对照表（实测，2026-10-02）**

| 携带的 cookie | `POST /site/captcha/policy` | `X-Cloudreve-Captcha-Permit` 重发 |
|---|---|---|
| 仅 `cloudreve-session` | `41701` 验证失败 | `41701` |
| 全量（session + observer + send） | `0`，`ready: true` | 成功进入业务层（实测拿到 `40020`） |

### 0.4 CSRF（3.8.5 新增，所有写请求必须）

- **`GET /site/config` 是唯一已确认的 `x-csrf-token` 响应头来源**；另有一条等价通道：浏览器会话 cookie 里的 `_csrf` cookie（两者取一即可）
- 写请求（POST/PUT/DELETE）需带 `X-CSRF-Token: <token>` 头，并附 `Origin` / `Referer`（`https://pan.huang1111.cn`）
- 实测 `GET /site/config` **不会**轮换 cookie/token；同一 token 可复用于多次写请求；但登录或验证链路轮换会话 cookie 后必须重取
- 漏带/带旧 token 的写请求 → `code: 40026`（Verification failed）

### 0.4b 请求头 `X-Cloudreve-Captcha-Protocol`（2026-10-02 新增，**所有请求必带**）

- 前端 axios 请求拦截器对**每个**请求无条件加上 `X-Cloudreve-Captcha-Protocol: 2`
- 缺失或值不为 `2`（实测 `1` 也不行）→ 一律 `code: 41709`「Please update this page to use the new verification. / 请更新页面后使用新版验证。」
- ⚠️ 这是旧脚本全线失败的直接原因：认证端点在缺此头时**根本不会进入验证流程**，无论提交什么验证字段都是 `41709`

### 0.5 响应信封（所有 API 统一）

```jsonc
{
  "code": 0,        // 0=成功；非 0 见 0.6
  "data": ...,      // 成功时的业务数据
  "msg": ""         // 错误时的消息
}
```

### 0.6 常见错误码（实测 + JS i18n）

| code | 含义 |
|---|---|
| 0 | 成功 |
| 401 | 未登录 / 会话过期 |
| -1 | 查询失败（如 `GET /aria2/task/{gid}` 无效 gid） |
| 404 | 对象不存在（如 `GET /object/property/{id}` 无效 id） |
| 40001 | 参数错误（Invalid input parameters），msg 常带缺失字段名 |
| 40007 | 当前用户组无权限执行该操作 |
| 40008 | 站点配置缺失/异常 |
| 40016 | 路径不存在 / 对象不存在（Path not exist / Object not exist） |
| 40020 | 账号或密码错误（Wrong password or email address）—— **真终态，重试无意义** |
| 40026 | 验证失败（Verification failed）：**旧版图形验证码**校验失败 / 会话轮换后用旧 cookie / 漏带或带旧 CSRF token。**2026-10-02 起该通路已作废**，仅在漏带 CSRF 时仍可能见到 |
| 40027 | 验证失败（Verification failed）：**旧版 PoW** 校验失败。**2026-10-02 起已作废**（PoW 改为走 `/site/captcha/policy`） |
| 41700 | **需要验证**：响应 `data` 内嵌 policy 对象（见 §0.3 ②） |
| 41701 | **许可提交被拒**：token 未绑定该 policy / counter 错误 / cookie 不全（见 §0.3 cookie 对照表） |
| 41702 | **限流/冷却**：`data.retry_after` 秒后重试 |
| 41703 | 需要验证但验证组件未就绪（前端语义） |
| 41704 | 用户取消验证（前端语义） |
| 41705 | 前一个验证请求尚未完成（前端语义） |
| 41706 | 验证挑战已过期 |
| 41708 | 验证尝试已耗尽 |
| 41709 | **协议版本不符**：缺 `X-Cloudreve-Captcha-Protocol: 2` 头（见 §0.4b） |
| 40058 | 分享 key 无效（`GET /share/info/{key}`、`GET /share/readme/{key}`） |

### 0.7 Proof-of-Work（PoW）验证 — `/site/captcha/pow` 与 `/site/captcha/policy`

> 2026-09-26 新增 PoW 章节；**2026-10-02 起 PoW 不再直接提交给业务端点**，而是先换取 policy 许可（见 §0.3）。
> 来源：前端 bundle（`main.*.chunk.js`、`cloudreve-pow.*.worker.js`）逆向 + 真实账号实测（登录、取直链均跑通）。

**① 取挑战（两种来源，务必分清）**

```
GET /api/v3/site/captcha/pow?purpose=<purpose>&_=<时间戳>     ← 独立挑战，**不能**直接用于 policy 提交
POST /api/v3/user/session 等任意需验证的请求 → 41700 响应 data.pow  ← **应使用这一份**
```

- `purpose` 取值（实测）：`login`（登录）、`direct_link`（取直链）
- ⚠️ `GET /site/captcha/pow` 响应是**扁平 JSON 对象**，**没有** `{code, data, msg}` 信封：

```jsonc
{
  "protocol": "cloudreve-pow-v1",
  "algorithm": "PBKDF2-SHA-256",
  "token": "eyJ2IjoxLCJwcm90b2NvbCI6...",   // JWT，提交时原样回传
  "nonce": "q6bdQDzkf6jaFECbK0YoZA",        // base64url，16 字节
  "salt": "nv14wYkFsM55cwFI4JbVwg",         // base64url，16 字节
  "target": "Y-wbeRlA1LoMr-rf5dEv4_3NJePyaVyHTrrihrnqm1E",  // base64url，32 字节
  "iterations": 3000,
  "counterLimit": 5000,
  "expiresAt": 1790450715,                   // Unix 秒
  "issuedAt": 1790449515,
  "serverTime": 1790449515,
  "profile": "compatible",
  "configurationRevision": "b827a24695c3477a2d12b3d9",
  "clientDiagnostic": true
}
```

**🔑 token 绑定（2026-10-02 实测，关键坑）**

两种来源的 JWT 载荷不同 —— 41700 内嵌的那份**多一个 `binding` claim**：

```jsonc
// 41700 内嵌：token 与 policy.id 绑定
{ "binding": "8fd60a506439af32…", "v": 1, "protocol": "cloudreve-pow-v1", … }
// 独立 GET：**无** binding
{ "v": 1, "protocol": "cloudreve-pow-v1", … }
```

对**全新未满足**的 policy 提交许可时（已排除"policy 已被满足"的干扰）：

| 提交用的 token | `POST /site/captcha/policy` |
|---|---|
| 41700 内嵌（含 `binding`） | `code: 0`，`ready: true` ✅ |
| 独立 GET 拿到（无 `binding`） | `41701` 验证失败 ❌ |

→ **必须用 41700 响应 `data.pow` 里的 token**，单独 GET 的 token 一律无效。

- 另有批量端点 `POST /site/captcha/pow/batch`（body `{purposes:[...]}`），**实测恒返回 `400 {"error":"challenge unavailable"}`**，不可用

**② 求解**（纯 WebCrypto 即可，无需 WASM；**算法自 2026-09-26 起未变**）

```
password = "Cloudreve-PoW/v1" || 0x00 || nonce            // 域分隔串 + 0x00 + nonce
for counter in 0 .. counterLimit-1:
    salt   = salt || uint32_be(counter)                    // 基础 salt 后追加 4 字节大端 counter
    digest = PBKDF2-SHA256(password, salt, iterations, 256 bit)
    if digest == target:  答案 = counter
```

- ⚠️ **易错点**：密码域分隔串是 **`Cloudreve-PoW/v1`（大驼峰）**，与 `challenge.protocol` 里的小写 `cloudreve-pow-v1` **不是同一个字符串**。混用会导致求解在 `counterLimit` 内永远找不到答案
- 前端另有 WASM SIMD 实现（`search4`，一次算 4 个 counter 用于加速），但**算法等价**，纯 JS/WebCrypto 结果一致

**③ 提交（换取许可，不是直接提交给业务端点）**

```jsonc
POST /api/v3/site/captcha/policy
{ "id": "<policy.id>", "pow_payload": "{\"token\":\"eyJ2...\",\"counter\":2606}" }
→ { "code": 0, "data": { …, "pow_done": true, "ready": true }, "msg": "" }
```

- ⚠️ 与旧版的**字段名差异**：旧版直接 POST 业务端点 + `powPayload`（驼峰）；新版 POST `/site/captcha/policy` + **`pow_payload`（下划线）**，值是 JSON 字符串
- 提交许可后**仍需**带 `X-Cloudreve-Captcha-Permit: <policy.id>` 重发原请求，才真正完成登录/取直链（见 §0.3 ④）
- 校验失败 → **`41701`**（注意与旧版的 `40026`/`40027` 不同，见 §0.6）
- **仅登录与取直链需要验证**；建目录/列目录/离线下载/删除等写请求仍只需 CSRF（实测全绿）

**验证失败码对照（实测，2026-10-02）**

| 场景 | code |
|---|---|
| 缺 `X-Cloudreve-Captcha-Protocol: 2` 头（或值不是 2） | `41709` |
| 需验证（拿到 policy） | `41700` |
| 许可提交被拒（token 未绑定 / counter 错 / cookie 不全） | `41701` |
| 限流/冷却（`data.retry_after` 秒后重试） | `41702` |
| 需要交互式验证但前端未就绪 | `41703` |
| 用户取消 / 验证未就绪 | `41704` / `41705` |
| 挑战已过期 / 已耗尽 | `41706` / `41708` |
| 账号或密码错误 | `40020`（终态） |
| 密码为空 | `40001`（终态） |
| 旧版图形验证码失败码（**已作废**） | `40026` |
| 旧版 PoW 校验失败码（**已作废**） | `40027` |

> ⚠️ 若调用方只把 `40026` 当"验证失败"，会漏掉新版全部 `417xx` 码 —— **这正是 2026-10-02 改造中踩到的坑**，见 §10。

---

### 0.8 交互式验证（2026-10-07 新增）—— 登录无法再自动化

> 来源：前端 bundle（`main.4af620e7.chunk.js` module 313 / 511525 / 521901…）+ 假凭据实测。
> 影响：**只有 `purpose=login` 受影响**；`direct_link` 经实测 `required.interactive=0`，仍只用 PoW。

**站点配置里新增的字段**

```jsonc
// GET /site/config → data
"captcha_policy": {
  "mode": "enforce",
  "overrides": {},                     // 可按 purpose 强制 interactive/combined，当前为空
  "purposes": ["login", "register", ..., "direct_link", ...],
  "send_interactive_first": true       // 2026-10-02 时不存在的新字段
}
"captcha_type": "pow", "pow_protocol": "cloudreve-pow-v1", "pow_fallback": true
```

前端判定「该 purpose 要不要交互式」的逻辑（module 313 `a()`，逆向所得）：

```js
overrides[purpose] === 'interactive' || 'combined'  → 要
否则若 overrides[purpose] 为空或 'recommended'      → 仅当 purpose 属于
   ['login','password_reset','email_change','password_change','register','share_report','send_report']
   才要（send_create 另按 send_interactive_first 判）
```

**登录下发的 policy（实测，假凭据）**

```jsonc
"required": { "interactive": 1, "pow": "", "level": 0, "reason": "normal" }
"interactive_done": false,  "pow_done": true,  "ready": false
//      ↑ 注意：pow 字段为空且 pow_done 已为 true —— 登录**不再下发 PoW**，只剩交互式这一道坎
```

**交互式题目结构（`policy.interactive`）**

```jsonc
{
  "version": 2,
  "id": "825477ffa6a842b33d284b37612cefc7",
  "kind": "click",          // 实测会随机切换：click（图形点选）/ text（输入字符）/ slide（滑块拖动）
  "level": 1,
  "scene":  "data:image/png;base64,…",  // 底图，320x240，约 40~90KB（内嵌，无需另外下载）
  "prompt": "data:image/png;base64,…",  // 提示图，144x64，约 1.6~2.3KB（要你找的字符）
  "width": 320, "height": 240,
  "count": 2,               // 需要点选/输入/拖动的数量（click/text 用；slide 见下）
  "expires": 1791313855
}
```

- 前端校验：`version===2 && id && kind ∈ ['click','text','slide']`
- 三种 kind 的提交体不同（`slide` 复用 `points`，取拖动终点）：
  - `click`：`{ points: [{x,y}, …], question_id: <interactive.id> }`（凑满 `count` 个即自动提交）
  - `text`：`{ text, question_id }`
  - `slide`：`{ points: [...], question_id }`（与 click 同形；前端用滑块组件产出坐标）
- **答案不下发**（已核对无 `dots`/`answer`/`points` 等字段）
- 提交仍走 `POST /site/captcha/policy`，但 body 不同：
  - `click`：`{ points: [{x,y}, …], question_id: <interactive.id> }`（凑满 `count` 个即自动提交）
  - `text`：`{ text, question_id }`
  - 坐标为**归一化 0~1**：`x = (clientX - rect.left) / rect.width`
- 判分：答错 → **`41701`**（"Verification failed. Please retry."，允许重试）；挑战过期 `41706`；尝试耗尽 `41708`

**为什么不做自动化破解**

试过「零模型 FFT 模板匹配」（`_probe-v3-match2.py`）：7 个字模里只有 3 个可信，
且最佳与次佳峰差极小（0.01~0.06），说明字符经过缩放/形变/干扰处理，纯模板匹配不稳。
而交互式验证是**有状态**的（对比旧图形验证码：无状态、每次换图、可零成本重试），
试错成本高且有 `41708` 耗尽风险 ⇒ 放弃。

**替代方案：复用会话 cookie（当前采用）**

实测结论（全部为 2026-10-07 本地验证）：

| 项 | 值 | 验证方式 |
|---|---|---|
| `cloudreve-session` 有效期 | **60 天**（`Max-Age=5184000`） | 响应头 + Firefox 库记录 + cookie 内嵌时间戳，三方吻合 |
| 是否滑动续期 | **否**（绝对过期） | 重复请求观察 Set-Cookie，服务端不再重签 |
| 是否绑定 User-Agent | **否** | 同一 cookie 用 5 种 UA（含无 UA / curl）请求 `/user/me` 均 `code=0` |
| 是否绑定来源 IP | **否** | 直连 vs 经代理（出口 IP 不同）均 `code=0` |
| 取直链是否要交互式 | **不要** | `direct_link` 的 `required={interactive:0, pow:"compatible"}` |
| 需要哪些 cookie | **只需 `cloudreve-session`** | 只带它即可走完 PoW → policy → permit 拿到直链 |
| `cloudreve_observer`（仅 1 天） | **无需保存** | 由 41700 响应自动下发，cookieJar 吸收即可 |

**cookie 值的结构**（用于离线推算到期时间，不必联网）

```
base64url( "<签发 Unix 秒>|<载荷>|<24 字节 HMAC>" )
```

⚠️ cookie **不含**过期时间 —— 有效期是服务端配置。
故到期时间 = 内嵌签发时间 + 60 天常量（该常量可用 `H1111_SESSION_TTL` 覆盖，站点改时长时不必改代码）。

**⚠️ 关于「必须全量 cookie」的更正（2026-10-07）**

§0.3 的 cookie 对照表（只有 session → `41701`）描述的是**手工构造请求、且不接收 41700 下发的 cookie** 的情形。
本仓库脚本用 cookieJar 自动吸收每次响应下发的 cookie，**只提供 `cloudreve-session` 即可跑通全链路**（已端到端实测）。
两者不矛盾：区别在于「是否吸收 41700 响应下发的 `cloudreve_observer`」。

---

## 1. 用户

### 1.1 用户信息 — `GET /user/me`

```
GET /api/v3/user/me
```

需登录。实测响应（2026-08-28）：

```jsonc
{
  "code": 0,
  "data": {
    "id": 100001,
    "user_name": "XiaoluoFoxington",
    "nickname": "...",
    "group": { "id": 3, "name": "VIP2", "allowShare": true }
  },
  "msg": ""
}
```

- 未登录 → `code: 401`
- 与已失效的 `GET /me`（404）不同，这是当前有效端点

### 1.2 存储空间 — `GET /user/storage`

```
GET /api/v3/user/storage
```

实测响应：

```jsonc
{
  "code": 0,
  "data": { "used": 130668774476, "free": 620950502324, "total": 751619276800, "recycled": 15762 },
  "msg": ""
}
```

- 单位字节；`recycled` 为回收站占用

### 1.3 账号设置 — `GET /user/setting`

```
GET /api/v3/user/setting
```

返回账号设置全量 JSON（头像、主题、语言、登录保护等）。

### 1.4 可用存储策略 — `GET /user/setting/policies`

```
GET /api/v3/user/setting/policies
```

返回当前账号可用的存储策略列表（数组，元素含 `id`、`name`）。实测返回 `[{"name":"自建存储SC4","id":"A3xh9"}]`。

### 1.5 其他用户类端点（仅 JS 发现，未深入实测）

| 端点 | 说明 |
|---|---|
| `GET /user/setting/nodes` | 可用下载节点（实测 `40007` 无权限） |
| `GET /user/setting/tasks?page=N` | 下载节点任务列表（需 `page` 参数） |
| `GET /user/storage` | 存储空间（见 §1.2） |
| `PATCH /user/setting/nick` | 改昵称（body `{nick}`） |
| `PATCH /user/setting/language` | 改语言 |
| `PATCH /user/setting/homepage` | 改默认首页 |
| `POST /user/setting/password/change` | 改密码 |
| `GET /user/activate/{id}` | 激活账号 |
| `POST /user/2fa` / `PATCH /user/setting/2fa` | 两步验证 |
| `GET /user/setting/policies` | 可用存储策略（见 §1.4） |

---

## 2. 目录

### 2.1 列目录 — `GET /directory/{路径}`

```
GET /api/v3/directory/{路径}
```

- 根目录：`/api/v3/directory/`（路径为空）
- 路径**不要**以 `/` 开头（`directory//xxx` 会 40016）
- 路径中的特殊字符（空格、中文）不需要手动编码，直接拼接即可；前导空格等极端情况需 `encodeURIComponent` 整段编码

实测响应：

```jsonc
{
  "code": 0,
  "data": {
    "parent": "ZqDKk8UX",           // 目录自身 id（删除目录时用，见 §4.1）
    "objects": [
      {
        "id": "ZqDKk8UX",           // 文件/目录唯一 id（取直链用，见 §3.1）
        "name": "FCL",              // 名称
        "path": "/foldcraftlauncher_cn/FCL",  // 完整路径
        "thumb": false,
        "size": 0,                  // 文件字节数；目录为 0
        "type": "dir",              // "dir" | "file"
        "date": "2026-01-01T01:05:18+08:00",
        "create_date": "2025-05-22T22:08:57+08:00",
        "source_enabled": false     // 是否支持生成直链（关键字段，见 §8）
      }
    ],
    "policy": {                     // 当前目录所属存储策略
      "id": "wVXuQ",
      "name": "V2直链空间（单文件上限2G）",
      "type": "remote",
      "max_size": 2147483648,       // 单文件上限 2GB
      "file_type": null
    }
  },
  "msg": ""
}
```

要点：

- `source_enabled`：只有 `true` 的文件才能取直链。直链空间（如 V2 直链空间）的文件通常为 `true`；SCx 自建存储通常为 `false`
- `policy.max_size` 即当前空间单文件上限，可用于直链前置校验

### 2.2 创建目录 — `PUT /directory`

```
PUT /api/v3/directory
Content-Type: application/json

{ "path": "/foldcraftlauncher_cn_auto/0/2026/8/26/v1.3.2.8" }
```

- ⚠️ 是 **PUT** 不是 POST（`POST /directory` 实测 404）
- ⚠️ 写请求需带 CSRF（见 §0.4）
- 请求体只需 `path`（目标目录完整路径，会连同中间目录一起创建）
- 删除目录用的 id = 创建后 `GET /directory/{路径}` 的 `.data.parent`

---

## 3. 文件操作

### 3.1 批量取直链 — `POST /file/source`

```
POST /api/v3/file/source
Content-Type: application/json
X-Cloudreve-Captcha-Protocol: 2

{
  "items": ["zdobenu1"]        // 文件 id 数组（来自 §2.1 的 objects[].id）
}
```

- 头部必需：`X-Cloudreve-Captcha-Protocol: 2`（见 §0.4b）+ `X-CSRF-Token`（见 §0.4）
- ⚠️ **`items` 是文件 id 数组，不是路径**
- ⚠️ **接口本身需要登录态**（未登录 → `code: 401`）；生成的直链 URL（`/f/{code}/{name}`）才是公共可访问、无需登录的
- ⚠️ **登录态校验先于验证**：未登录时直接 `401`，**不会**返回 `41700`（实测）
- ⚠️ **2026-10-02 起验证走 captcha policy v2**（`purpose=direct_link`），**不再有 `captchaCode`/`powPayload` 字段**：
  - 已登录状态下直接 POST 会得到 `code: 41700` + 内嵌 policy，需按 §0.3 ②~④ 换取许可后带 `X-Cloudreve-Captcha-Permit` 重发
  - 实测 `required.interactive = 0`（无需滑块），故可全自动完成
- 首次会话轮换后需重新 `GET /site/config` 取 CSRF

实测响应：

```jsonc
{
  "code": 0,
  "data": [
    {
      "id": "zdobenu1",                          // 文件 id（回显）
      "url": "https://pan.huang1111.cn/f/z2mwtE/FCL-release-1.3.2.7-arm64-v8a.apk",
      "short_url": "https://pan.huang1111.cn/f/z2mwtE",   // 短链（2026-09-26 实测新增字段）
      "name": "FCL-release-1.3.2.7-arm64-v8a.apk",
      "parent": 4610440            // 文件父级数字 id（用途不明）
    }
  ],
  "msg": ""
}
```

- 返回**不含 size**；文件大小走 §2.1 `GET /directory` 的 `objects[].size`
- 一次可批量传多个文件 id（实测 VIP2 的 `sourceBatch` 上限为 10000）；返回顺序与 `items` 一致
- **`url` 与 `short_url` 二者等价**（2026-09-26 实测 + 站长确认）：`short_url` 就是 `url` 去掉末尾 `/{文件名}` 段，指向同一文件、可互换使用，**无功能差异，只是少了名字**
  - 实测两者都 302/206 到同一个 `download-sc{1..N}.huang1111.cn/api/v3/slave/source/{...}` 后端地址
  - 站端 JS 使用 `url`（完整形式）；本站 `h1api.mjs` 亦只消费 `url`，故该字段新增对本站**零影响**
- **`url` 是长期有效的公共直链**：
  - 无需登录即可访问（302 正常）
  - 302 重定向到真实下载服务器：`https://download-sc{1..N}.huang1111.cn/api/v3/slave/source/{...}?sign=...`（多节点负载均衡，实测曾命中 sc1 与 sc4；签名带时间戳，但入口 `/f/` URL 长期有效）
  - 实测 2026-04 上传的文件直链，2026-08 仍可访问

### 3.2 创建占位文件 — `POST /file/create`

```
POST /api/v3/file/create
Content-Type: application/json

{ "path": "/目标目录/文件名" }
```

- `path` 为**含文件名的完整路径**（最后一段即文件名），仅此一个字段生效；额外的 `name` / `size` 字段会被**忽略**（实测传 `{path, name:"x", size:1024}` 仍按 path 末尾命名、size 显示为 0）
- 占位文件创建后**会显示在目录列表中**（`type:"file"`、`size:0`、`source_enabled` 随存储策略），但内容为空，需后续上传/写入实际内容
- 同名文件已存在 → `40001`（"placeholder file already exist"）
- 需 CSRF

### 3.3 对象操作（重命名/复制/移动）

对象操作的请求体统一为 `src` 结构（`{dirs:[目录id], items:[文件id]}`），实测均通过（2026-08-28）：

| 端点 | 请求体（实测） | 说明 |
|---|---|---|
| `POST /object/rename` | `{action:"rename", src:{dirs,items}, new_name}` | 重命名（实测成功） |
| `POST /object/copy` | `{src_dir, src:{dirs,items}, dst, conflict_action:"rename"}` | 复制到目标目录；`conflict_action` 冲突策略（"rename" 自动改名） |
| `PATCH /object` | `{action:"move", src_dir, src:{dirs,items}, dst}` | 移动对象到目标目录（实测成功） |
| `GET /object/property/{id}` | — | 对象属性（无效 id → `code: 404`） |

- 复制/移动以 `src_dir`（源目录完整路径）+ `src`（选中对象 id 集合）定位源，`dst` 为目标目录路径
- ⚠️ 注意：`POST /object/rename` **不是** `{id,name}` 结构（那种结构会 `40001`）

### 3.4 批量打包下载 — `POST /file/archive`

```
POST /api/v3/file/archive
Content-Type: application/json

{ "items": [文件id], "dirs": [目录id] }
```

- 打包选中的文件/目录为归档并返回下载地址（分享页用 `POST /share/archive/{key}`）
- 需 CSRF

---

## 4. 删除与回收站

### 4.1 删除文件/目录 — `DELETE /object`

```
DELETE /api/v3/object
Content-Type: application/json

{
  "items": ["O37jlEhz"],     // 文件 id 数组
  "dirs": [],                // 目录 id 数组（删除目录时用，必须传 id 不能传名称）
  "force": true,             // 实测：并不能跳过回收站，删除后仍进回收站（48h 自动清除）
  "unlink": false            // 彻底删除开关（未深究，保持 false）
}
```

实测响应：`{ "code": 0, "data": null, "msg": "" }`

要点：

- `items` 传**文件 id**，`dirs` 传**目录 id**（目录 id 来自 §2.1 的 `.data.parent` 或列表里的 `id`）；`dirs` 传名称 → `40016`
- ⚠️ 每次 DELETE 前必须重取 CSRF（漏带/旧 token → `40026`）
- `force:true` 实测**不绕过回收站**：文件仍出现在回收站（48 小时后自动清除），符合"不留永久垃圾"预期

### 4.2 回收站

```
GET    /api/v3/recycle              → 回收站条目列表
PATCH  /api/v3/recycle              → 恢复条目（body: {items:[id...]}）
DELETE /api/v3/recycle              → 永久删除条目（body: {items:[id...]}）
PATCH  /api/v3/recycle/all          → 全部恢复
DELETE /api/v3/recycle/all          → 清空回收站（body: {items:[id...]}）
```

- `GET /recycle` 返回条目数组，元素含 `id`、`root_id`、`type`、`name`、`original_path`、`purge_status` 等（`purge_status: "ready"` 表示待清除）
- 恢复/清空等操作需 CSRF

---

## 5. 离线下载（aria2）

### 5.1 URL 离线下载 — `POST /aria2/url`

```
POST /api/v3/aria2/url
Content-Type: application/json

{
  "url": ["https://github.com/FCL-Team/FoldCraftLauncher/releases/download/1.3.2.8/FCL-release-1.3.2.8-armeabi-v7a.apk"],
  "dst": "/foldcraftlauncher_cn_auto/0/2026/8/26/v1.3.2.8",
  "preferred_node": 0
}
```

- `url`：**字符串数组**，可一次提交多个 URL（数组元素会逐个建任务）
- `dst`：目标目录完整路径。⚠️ **目录必须已存在**——不存在时实测返回 `code: 40016`，**不会自动创建**（2026-08-28 实测）。必须先 `PUT /directory` 建目录（§2.2）再提交
- `preferred_node`：`0` = 自动选择节点；实测不传/传 0 均成功
- ⚠️ 提交 POST 需带 CSRF 头；**不需要验证码**（验证码只用于登录和 `/file/source`）
- 下载的**文件名 = URL 最后一段路径名**
- 并行上限：VIP2 年付 6（3.8.5 更新后升至 8）；超出会排队或失败（未实测超限行为）

实测响应（**不含 gid**）：

```jsonc
{
  "code": 0,
  "data": [
    { "code": 0, "msg": "" }        // 每个 URL 一个结果；code 非 0 表示该任务提交失败
  ],
  "msg": ""
}
```

### 5.2 下载中 — `GET /aria2/downloading`

```
GET /api/v3/aria2/downloading
```

无任务时返回 `{ "code": 0, "data": [], "msg": "" }`；有任务时 `data` 为任务对象数组（结构见 §5.8）。

### 5.3 已完成/历史 — `GET /aria2/finished`

```
GET /api/v3/aria2/finished?page=1
```

- `page`：从 1 开始，每页 10 条（`data.length >= 10` 时继续翻页）

### 5.4 任务详情 — `GET /aria2/task/{gid}`

```
GET /api/v3/aria2/task/{gid}
```

- gid 无效 → `code: -1`（"Failed to query download details"）

### 5.5 删除任务 — `DELETE /aria2/task/{gid}`

```
DELETE /api/v3/aria2/task/{gid}
```

需 CSRF。

### 5.6 选择任务文件 — `PUT /aria2/select/{gid}`

```
PUT /api/v3/aria2/select/{gid}
Content-Type: application/json

{ "indexes": ["1"] }
```

需 CSRF（`indexes` 为文件序号数组，见 §5.8 `files[].index`）。

### 5.7 磁力/种子离线下载 — `POST /aria2/torrent/{torrentId}`

```
POST /api/v3/aria2/torrent/{torrentId}
Content-Type: application/json

{ "dst": "/", "preferred_node": 0 }
```

- `torrentId` 为网盘内已上传种子文件的对象 id（无效 id → `40001` "Failed to parse object ID"）；需 CSRF

### 5.8 任务对象结构（实测）

```jsonc
{
  "name": "README.md",                          // 文件名
  "gid": "6f492401808422ca",                    // aria2 任务 gid（提交响应里没有，只能反查）
  "status": 4,                                  // 状态码：1=排队/等待中, 2=下载中, 4=完成, 5=失败/错误
  "dst": "/foldcraftlauncher_cn",               // 下载到的目录
  "error": "",                                  // 失败原因（空=无）
  "total": 6166,                                // 总字节数
  "files": [
    {
      "index": "1",
      "path": "README.md",                      // 文件相对路径
      "length": "6166",
      "completedLength": "6166",
      "selected": "true",
      "uris": [
        { "uri": "https://raw.githubusercontent.com/...", "status": "used" },
        { "uri": "...", "status": "waiting" }   // 同一 URL 的重试副本
      ]
    }
  ],
  "task_status": 4,
  "task_error": "",
  "create": "2026-08-25T14:13:23+08:00",
  "update": "2026-08-25T14:13:36+08:00",
  "node": "专用离线下载节点"
}
```

- **任务完成判定**：`status === 4` 且 `error === ''` 且 `files[0].completedLength === files[0].length`
- 下载完成后文件出现在 `dst` 目录下，文件名 = `files[0].path`；可拼出完整路径供 §2.1 定位文件 id

### 5.9 提交后如何拿到 gid

提交 `/aria2/url` 后**没有 gid**，轮询两种信号取其一：

1. **看目录**：`GET /directory/<dst>`，`objects[]` 里出现目标文件名 → 下载完成，`objects[0].id` 即文件 id
2. **看 finished**：`GET /aria2/finished?page=1`，按 `dst` + `files[0].path` 匹配本任务 → `gid` 反查成功，同时读 `status`/`error` 判断成败

判定规则：先查 finished（`status === 5` 且文件名匹配 → 判失败），再查目录（出现文件 → 判成功），两处都查到才算闭环（防止 finished 页暂未刷新导致误判）。轮询间隔/超时由调用方自行决定。

---

## 6. 分享

| 端点 | 请求体 | 说明 |
|---|---|---|
| `POST /share` | `{sessions:[对象id], type, password, downloads, expire, expire_mode, score, preview}` | 创建分享。`type` 分享类型、`password` 提取码（空=无）、`downloads` 下载次数限制（-1=不限）、`expire` 过期时间戳/`expire_mode` 过期模式、`score` 积分、`preview` 是否允许预览。实测 `{items:[id]}` 这种简化结构会 `40001` "Source resource cannot be empty"，需 `sessions` 字段 |
| `GET /share/info/{key}` | — | 分享信息（key 无效 → `code: 40058`） |
| `GET /share/readme/{key}?path=/路径` | — | 分享目录的 README 文本（key 无效 → `code: 40058`） |
| `GET /share/search` | — | 分享搜索（需 `page` 参数） |
| `POST /share/save/{key}` | `{path:"/目标路径"}` | 保存分享内容到自己的网盘（结构来自 JS） |
| `POST /share/archive/{key}` | `{items:[文件id], dirs:[目录id], path}` | 分享页批量打包下载（返回下载地址） |
| `POST /share/report/{key}` | `{des, reason, email?}` | 举报分享（`reason` 数字枚举；站点开启验证码时需带验证码） |
| `PATCH /share/` / `DELETE /share/` | — | 修改 / 删除分享（需 CSRF） |

---

## 7. 其他可用端点

| 端点 | 说明 |
|---|---|
| `GET /webdav/accounts` | WebDAV 账号列表（返回 `{accounts, folders}`） |
| `GET /vas/product` | 当前生效的增值套餐（如 VIP2 年付） |
| `GET /vas/activity` | 活动列表（数组） |
| `GET /site/config` | 站点配置 + CSRF 来源（见 §0.4）；含 `captcha_policy` / `captcha_type` / `pow_protocol` / `pow_fallback` |
| `GET /site/captcha` | 图形验证码。**仍返回 200 + PNG，但 2026-10-02 起后端已不接受其校验结果**（已作废，勿用） |
| `POST /site/captcha/policy` | 提交 PoW 换取验证许可（见 §0.3 ③）；无 `{code,data}` 信封以外形式的 GET（`GET` → 404） |
| `POST /tag/filter` | 创建标签（body `{expression,name,color,icon}`） |
| `POST /tag/link` | 给路径打标签（body `{path,name}`） |
| `DELETE /tag/{id}` | 删除标签 |
| `POST /support/tickets` | 提交支持工单 |
| `GET /support/unread` | 未读工单数 |
| `GET /toolbox/config` | 工具箱配置 |

---

## 8. 直链前置条件

| 条件 | 说明 |
|---|---|
| 文件所在存储策略 | 必须在**直链空间**（如 V2 直链空间），SCx 自建存储不支持直链 |
| 单文件大小 | ≤ 会员直链上限（VIP2 年付 = 2GB） |
| 用户组权限 | `group.allowShare`（分享/直链权限） |

`source_enabled` 字段可直接判断：`true` 才能取直链。

---

## 9. 已失效 / 未实测端点

以下端点经实测**已失效**或**仅从 JS 发现未实测**，使用时需自行验证：

| 端点 | 实测结果 |
|---|---|
| `GET /me` | **404**（已失效；用户信息用 `GET /user/me`） |
| `GET /file/search/{关键词}` | **404**（已失效；目录搜索疑似不存在） |
| `GET /share/list/{shareKey}` | **301**（路径已变更；分享信息用 `GET /share/info/{key}`） |
| `GET /share/preview/{key}` | **404**（已失效；README 用 `GET /share/readme/{key}`） |
| `POST /file/upload` | 未在本站验证（Cloudreve 标准上传会话） |
| `GET /source` | **有效但需 `page` 参数**（直链记录；不传 → `40001` "Page too short"） |
| `GET /share/search` | **有效但需 `page` 参数**（分享搜索；不传 → `40001` "Page cannot be empty"） |
| `POST /file/compress` | 实测 `40007` 无权限（VIP2 对当前存储不可用），结构与前端一致 `{items,name,dst}` |
| `POST /file/decompress` | 实测 `40007` 无权限（同上），结构 `{id,dst}` |
| `DELETE /file/upload` | 清理全部上传会话（需 CSRF，未验证） |

---

## 10. 踩坑记录

| 坑 | 现象 | 解决 |
|---|---|---|
| **aria2 的 dst 目录不存在** | `POST /aria2/url` → `40016`（**不会自动创建**，2026-08-28 实测） | 提交前先 `PUT /directory` 建目录（§2.2），再提交 |
| **items 传路径** | `POST /file/source {items:["/路径"]}` → 40001 | items 必须是**文件 id** |
| **POST /directory** | 404 | 创建目录是 **`PUT /directory`**，body 只传 `{path}`（§2.2） |
| **DELETE /object/{id}** | 404 | 删除是 **`DELETE /object`**，body 传 `{items:[文件id], dirs:[目录id]}`（§4.1） |
| **dirs 传目录名** | `40016` | `dirs` 必须传**目录 id**（来自 §2.1 `.data.parent`） |
| **目录路径多前导斜杠** | `directory//xxx` → `40016` | 路径去前导 `/` |
| **file/source 漏验证码/CSRF** | `40026` 类 | 新版需 `X-Cloudreve-Captcha-Protocol: 2` + `X-CSRF-Token` + 许可证（§3.1、§0.3） |
| **（2026-10-02 主坑）全线 `41709`「请更新页面后使用新版验证」** | 无论怎么改验证字段都是 41709，PoW 解得再对也没用 | 请求缺 **`X-Cloudreve-Captcha-Protocol: 2`** 头。站点换成了 captcha policy v2，认证端点在缺此头时**根本不进入验证流程**（§0.4b） |
| **`GET /site/captcha` 还能出图，但图形验证码永远过不了** | 提交 `captchaCode` 只回 `41700`，OCR 再准也没用 | 图形验证码通路**已被后端下线**；该端点仅剩出图能力。只能用 PoW（§0.3） |
| **`POST /site/captcha/policy` 恒 `41701`** | counter 解对了、token 也是 41700 内嵌的，仍验证失败 | **cookie 不全**：必须带 `cloudreve-session` + `cloudreve_observer` + `cloudreve_send`。旧文档「observer 非必需」已失效（§0.3 cookie 对照表） |
| **提交许可换成独立 GET 的 PoW token** | `41701` | 41700 内嵌 token 含 `binding` claim（绑定 policy.id），独立 `GET /site/captcha/pow` 的**没有**。必须用 41700 的 `data.pow`（§0.7 🔑） |
| **许可字段名写成 `powPayload`** | `41701` | 新版是 **`pow_payload`（下划线）**，且提交到 `/site/captcha/policy` 而**不是**业务端点（§0.7 ③） |
| **拿到许可后不加重发头** | 仍然 `41700` | 必须带 **`X-Cloudreve-Captcha-Permit: <policy.id>`** 重发原请求才生效（§0.3 ④） |
| **把"需要验证"当成"账号密码错"** | 误判为凭据问题反复排查 | `41700` 是「需要验证」的正向信号；真正的凭据错误是 `40020`，只会在**带许可重发**后出现 |
| **PoW 求解永远找不到答案** | `counterLimit` 内无一命中 | 密码域分隔串是**大驼峰 `Cloudreve-PoW/v1`**，不是 `challenge.protocol` 的小写 `cloudreve-pow-v1`（§0.7 ②） |
| **PoW 求解慢/像卡死** | 单次数十秒无输出 | 算法未变，但求解是**单线程**逐 counter 试算，`counterLimit` 上限 5000，最坏需遍历完整区间。实现选型上 `webcrypto.subtle.deriveBits` 快于 `crypto.pbkdf2Sync`，手写 HMAC 循环慢一个数量级（勿用）（§0.7 ②） |
| **把 PoW 挑战响应当常规响应解析** | 取不到 `data`，字段全是 undefined | `/site/captcha/pow` 返回**扁平 JSON**，无 `{code,data,msg}` 信封；但 41700 内嵌的 `data.pow` 是**常规信封内**的（§0.7 ①） |
| **DELETE 漏 CSRF** | `40026` | 每次写请求前 GET `/site/config` 重取 token（§0.4） |
| **force:true 想跳过回收站** | 文件仍进回收站 | 接受"进回收站 48h 后自动清除"，或按需处理回收站（§4.2） |
