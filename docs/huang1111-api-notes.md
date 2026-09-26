# huang1111 网盘 API 逆向解析（Cloudreve v3 定制版）

> 状态：站点已切换 `captcha_type = "pow"`（PoW 上线），**图形验证码通路后端仍然保留**，两条路均可用于登录/取直链；2026-09-26 实测复核通过
> 记录日期：2026-08-25（3.8.5 重测 2026-08-26；2026-08-28 全面复核并修订过时/错误项 + 扩展新端点；**2026-09-26 新增 PoW 协议章节，修订 §0.3 / §3.1 的验证方式**）
> 来源：真实登录态会话实测 + 前端 JS bundle 分析（`pan.huang1111.cn/static/js/`）
> 范围：仅收录已实测端点；"已失效/未实测"见 §9

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

### 0.3 登录（账号密码 + 验证码/PoW + CSRF）

登录**必须**先取验证码（或 PoW 挑战）再 POST，且所有写请求都要带 CSRF 头（见 §0.4）。完整流程：

```
① GET  /site/captcha?_=<时间戳>      → 图形验证码：data: "data:image/png;base64,..." + Set-Cookie 会话
   GET  /site/captcha/pow?purpose=login → PoW 挑战（见 §0.7）
② GET  /site/config                  → 响应头 x-csrf-token（用于下面 POST）
③ POST /user/session                 → body {userName, Password, captchaCode} 或 {userName, Password, powPayload}
```

- **验证方式二选一**（2026-09-26 起站点 `captcha_type = "pow"`，但**后端两条通路都保留**，`pow_fallback: true`）：
  - **图形验证码**：4 位字符 PNG（base64 in `data`）。识别结果需 `.upper()` + 过滤非 ASCII 字母数字，长度必须为 4，否则重取重试
  - **PoW**：见 §0.7，实测 6/6 成功率；图形验证码受 OCR 准确率限制，实测 3/6
- 两种方式的**提交字段名不同**：
  - 图形验证码 → `captchaCode: "ABCD"`
  - PoW → `powPayload: '{"token":"...","counter":123}'`（JSON 字符串）
- **失败重试**：`code: 40026`（Verification failed）多为验证码识别错误或 PoW 校验失败，重试时重新 GET 新验证码/新挑战（图形验证码一次性，且 GET captcha 可能**轮换会话 cookie**——必须用新 cookie 重新 GET /site/config 拿新 CSRF，再 POST）
- 登录成功响应 `data.user_name` / `nickname` / `group` 可确认身份等级

> `scripts/auto-sync/h1api.mjs` 的策略：默认图形验证码（最多 10 次），用尽后自动回退 PoW（最多 3 次）。

### 0.4 CSRF（3.8.5 新增，所有写请求必须）

- **`GET /site/config` 是唯一已确认的 `x-csrf-token` 响应头来源**；另有一条等价通道：浏览器会话 cookie 里的 `_csrf` cookie（两者取一即可）
- 写请求（POST/PUT/DELETE）需带 `X-CSRF-Token: <token>` 头，并附 `Origin` / `Referer`（`https://pan.huang1111.cn`）
- 实测 `GET /site/config` **不会**轮换 cookie/token；同一 token 可复用于多次写请求；但登录或 GET captcha 轮换会话 cookie 后必须重取
- 漏带/带旧 token 的写请求 → `code: 40026`（Verification failed）

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
| 40026 | 验证失败（Verification failed）：**图形验证码**校验失败 / 会话轮换后用旧 cookie / 漏带或带旧 CSRF token / 完全不带验证字段 |
| 40027 | 验证失败（Verification failed）：**PoW** 校验失败 —— counter 错误、token 的 purpose 不符、`powPayload` 非法。msg 文案与 40026 相同，**只能靠 code 区分** |
| 40058 | 分享 key 无效（`GET /share/info/{key}`、`GET /share/readme/{key}`） |

### 0.7 Proof-of-Work（PoW）验证 — `/site/captcha/pow`

> 2026-09-26 新增。站点 `site_config` 已切换为 `captcha_type = "pow"`、`pow_protocol = "cloudreve-pow-v1"`。
> 来源：前端 bundle（`main.*.chunk.js`、`cloudreve-pow.*.worker.js`）逆向 + 真实账号实测（登录、取直链均跑通）。

**① 取挑战**

```
GET /api/v3/site/captcha/pow?purpose=<purpose>&_=<时间戳>
```

- `purpose` 取值（实测）：`login`（登录）、`direct_link`（取直链）
- ⚠️ 响应是**扁平 JSON 对象**，**没有** `{code, data, msg}` 信封：

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

- 该响应会下发 `cloudreve_observer` cookie，但**实测非必需**：只带 `cloudreve-session` 提交同样成功
- 另有批量端点 `POST /site/captcha/pow/batch`（body `{purposes:[...]}`），**实测恒返回 `400 {"error":"challenge unavailable"}`**，不可用

**② 求解**（纯 WebCrypto 即可，无需 WASM）

```
password = "Cloudreve-PoW/v1" || 0x00 || nonce            // 域分隔串 + 0x00 + nonce
for counter in 0 .. counterLimit-1:
    salt   = salt || uint32_be(counter)                    // 基础 salt 后追加 4 字节大端 counter
    digest = PBKDF2-SHA256(password, salt, iterations, 256 bit)
    if digest == target:  答案 = counter
```

- ⚠️ **易错点**：密码域分隔串是 **`Cloudreve-PoW/v1`（大驼峰）**，与 `challenge.protocol` 里的小写 `cloudreve-pow-v1` **不是同一个字符串**。混用会导致求解在 `counterLimit` 内永远找不到答案
- 前端另有 WASM SIMD 实现（`search4`，一次算 4 个 counter 用于加速），但**算法等价**，纯 JS/WebCrypto 结果一致
- 实测求解耗时 **6.8~12.5s**；`counterLimit` 5000、有效期 1200s，余量充足

**③ 提交**

```jsonc
// 登录
POST /api/v3/user/session
{ "userName": "...", "Password": "...", "powPayload": "{\"token\":\"eyJ2...\",\"counter\":2606}" }

// 取直链
POST /api/v3/file/source
{ "items": ["文件id"], "powPayload": "{\"token\":\"eyJ2...\",\"counter\":2606}" }
```

- ⚠️ 字段名是 **`powPayload`**，值是 `JSON.stringify({token, counter})` 后的**字符串**（不是嵌套对象）
- 仍需 CSRF 头（见 §0.4）
- 校验失败 → **`code: 40027`**（注意与图形验证码的 `40026` **不同**，见 §0.6）
- **仅登录与取直链需要 PoW**；建目录/列目录/离线下载/删除等写请求仍只需 CSRF（2026-09-26 实测全绿）

**验证失败码对照（实测，2026-09-26）**

| 场景 | code |
|---|---|
| 图形验证码错误 / 不带任何验证字段 | `40026` |
| PoW counter 错误 | `40027` |
| PoW token 的 purpose 不符（如用 login 的 token 取直链） | `40027` |
| `powPayload` 非法 JSON | `40027` |
| 账号或密码错误 | `40020`（终态） |
| 密码为空 | `40001`（终态） |

> ⚠️ 若调用方只把 `40026` 当"验证失败"，PoW 的 `40027` 会被误判成"未知错误"而放弃重试 —— **这正是改造中踩到的坑**，见 §10。

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

{
  "items": ["zdobenu1"],        // 文件 id 数组（来自 §2.1 的 objects[].id）
  "captchaCode": "XXXX"         // 图形验证码；或改用 "powPayload": '{"token":"...","counter":N}'
}
```

- 头部必需：`X-CSRF-Token`（见 §0.4）
- ⚠️ **`items` 是文件 id 数组，不是路径**
- ⚠️ **接口本身需要登录态**（未登录 → `code: 401`）；生成的直链 URL（`/f/{code}/{name}`）才是公共可访问、无需登录的
- ⚠️ 3.8.5 起需带验证码；**2026-09-26 起站点默认 PoW**，两种方式实测**均可用**：
  - 图形验证码：`captchaCode`（大写 + 过滤非字母数字，期望长度 4）—— 实测 3/6（受 OCR 准确率限制）
  - PoW：`powPayload`（见 §0.7，`purpose=direct_link`）—— 实测 6/6
  - 两者均**一次性**：每次校验（无论对错）后即作废，**同码/同 token 重试必败**（40026）；失败只能换新的
- 若 session 在登录后被轮换过，需先重取 captcha/挑战 + 重新 `GET /site/config`

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
| `GET /site/config` | 站点配置 + CSRF 来源（见 §0.4） |
| `GET /site/captcha` | 图形验证码（见 §0.3） |
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
| **file/source 漏验证码/CSRF** | `40026` 类 | 需 `captchaCode`（图形验证码）或 `powPayload`（PoW）+ `X-CSRF-Token`（§3.1） |
| **file/source 验证码一次性 + OCR 误读** | 偶发 `40026`；**同码重试必败** | 失败**换新验证码**重试（上限 10 次）；OCR 长度≠4 直接换图。或改用 PoW（§0.7） |
| **PoW 求解永远找不到答案** | `counterLimit` 内无一命中 | 密码域分隔串是**大驼峰 `Cloudreve-PoW/v1`**，不是 `challenge.protocol` 的小写 `cloudreve-pow-v1`（§0.7 ②） |
| **PoW 提交报 40026** | 明明解出了正确 counter | 字段名必须是 `powPayload`，且值为 `JSON.stringify({token,counter})` **字符串**（不是 `captchaCode`、不是嵌套对象） |
| **PoW 失败却当成"未知错误"直接放弃** | PoW 校验失败返回 **`40027`**，不是 `40026` | 判断"验证是否失败"必须同时覆盖 `40026` 与 `40027`，否则 PoW 一次失败就再也不会换新挑战重试（§0.6 对照表） |
| **PoW token 用错 purpose** | 用 `purpose=login` 的 token 去 `POST /file/source` → `40027` | 登录用 `login`，取直链用 `direct_link`；两者 token 不通用 |
| **把 PoW 挑战响应当常规响应解析** | 取不到 `data`，字段全是 undefined | `/site/captcha/pow` 返回**扁平 JSON**，无 `{code,data,msg}` 信封（§0.7 ①） |
| **DELETE 漏 CSRF** | `40026` | 每次写请求前 GET `/site/config` 重取 token（§0.4） |
| **force:true 想跳过回收站** | 文件仍进回收站 | 接受"进回收站 48h 后自动清除"，或按需处理回收站（§4.2） |
