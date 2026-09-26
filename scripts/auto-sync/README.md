# 线路1 自动同步（auto-sync）

把「GitHub Releases → huang1111 网盘离线下载 → 直链 → 站端 `data/down` JSON → 提交」全链路自动化，跑在 GitHub Actions 上。站端前端无需改动（下载节点按 `nextUrl` 惰性加载，对目录结构透明）。

> 详细设计见 [`docs/auto-sync-design.md`](../../docs/auto-sync-design.md)，API 实测依据见 [`docs/huang1111-api-notes.md`](../../docs/huang1111-api-notes.md)。
> 本目录内 `.mjs` 为 Node 原生 ESM（无需 npm install），`.py` 为 OCR 子进程助手。各文件的职责以其文件头注释为准。

## 职责速览

- `sync.mjs`：主流程（检测 → 离线下载 → 直链 → 写 JSON → 分软件提交 → push）
- `probe.mjs`：预探测（只读，无候选时跳过 sync job）
- `lib.mjs`：纯函数与共享状态
- `h1api.mjs`：huang1111 API 封装（含 PoW 求解）
- `config.mjs`：环境变量与常量（**改配置看这里**）
- `softwares.json`：软件映射表（**有哪些软件看这里**）
- `ocr_helper.py`：验证码 OCR 子进程助手

## 触发

- **定时**：由工作流的 `schedule` 决定（cron 按 UTC 编写，时间点见 `.github/workflows/auto-sync.yml`）
- **手动**：GitHub 仓库 Actions 页 → `线路1自动同步` → `Run workflow`（可临时改时间/直接验证）

## 凭据（Secrets）

仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 说明 |
|---|---|
| `H1111_USER` | huang1111 登录账号 |
| `H1111_PASSWORD` | huang1111 登录密码 |
| `OCR_PKG_NAME` | 验证码 OCR 依赖的 pip 包名 |
| `OCR_CLS_NAME` | 验证码 OCR 依赖的类名 |

凭据只存 GitHub，脚本只从环境变量读取，仓库内永不落盘。

## 本地手动运行（调试用）

```powershell
# 只跑预探测（不读凭据、不动网盘）
node scripts/auto-sync/probe.mjs

# 完整同步（需要凭据）
$env:H1111_USER = '你的账号'
$env:H1111_PASSWORD = '你的密码'
node scripts/auto-sync/sync.mjs
```

可用的环境变量、默认值与重试常量统一在 [`config.mjs`](config.mjs) 中定义，以其为准。

## 数据结构（站内 `data/down/{id}/`）

- **自动生成（新格式）**：`auto/{年}/{月}/{日}/{版本名}.json` —— 年月日取 Release 发布时间转 UTC+8（不补零）；版本名保留 tag 原样（含前导 `v`/`V`），空白与非法文件名字符归一为 `_`。网盘侧对应 `foldcraftlauncher_cn_auto/{id}/{年}/{月}/{日}/{版本名}/`。
- **旧格式（历史保留，不再写入）**：`{段}/{段}/.../{段}.json`（由版本号按 `.` 拆段而来），解析器对旧格式保持兼容，新旧条目可共存。
- **手动条目**：index.json 中无版本路径的条目原样透传，永远排在版本条目之前。
- index.json 的版本条目按版本降序；`default: true` 标记自动只保留在最新版本上。

## 双 job 架构

```
probe job（轻量，必跑）──读取 GitHub Releases + 本地 index.json 基线──► 输出 needs_sync
                                                                        │
                                        needs_sync == 'true' ───────────┘
                                                  ▼
                       sync job（重量，按需）──登录 → 离线下载 → 直链 → 写 JSON → 提交 → push
```

- 无候选时 probe job 输出 `needs_sync=false`，**sync job 完全不启动**（省掉 Python/Node/OCR 安装 + 全部网盘操作）
- 凭据只在 sync job 中使用，probe job 不读凭据
- 异常时 probe 默认输出 `needs_sync=true`（宁可多跑一次，也不遗漏）

## 检测逻辑

1. 读 `data/down/{id}/index.json` 找**数据源内最新版本**
2. 数据源**没有**版本 → 只取 GitHub Release 最新一个
3. 数据源**有**版本 → 落后 Release 多少版本，把落后的**全部**下载（旧的先处理）

## 重试策略

各场景的重试次数与超时以 [`config.mjs`](config.mjs) 的常量（`RETRY` / `TIMING` / `LIMIT` 等）为准。

**登录与取直链的验证方式**（2026-09-26 起站点 `captcha_type = "pow"`，但后端**同时保留图形验证码通路**）：

1. 默认走**图形验证码 + OCR**，最多 `RETRY.CAPTCHA_ATTEMPTS`（10）次，每次换新验证码
2. 用尽后**自动回退 PoW**，最多 `RETRY.POW_ATTEMPTS`（3）次，每次换新挑战（见 [`docs/huang1111-api-notes.md`](../../docs/huang1111-api-notes.md) §0.7）

实测成功率：图形验证码 3/6（受 OCR 准确率限制）、PoW 6/6。两条路都耗尽才判定失败。

任一步耗尽后：该版本跳过（不写 JSON），其余版本继续；存在失败项时进程以非 0 退出，GHA 显示红色即告警，下次运行自动补。

## 提交格式（每软件一个 commit）

```
[GHA] 新增：内容：数据源：资源id-{id}：{版本1&版本2&...}呜~
（空行）
{本次该软件的详细日志}
```

- 主题以 `[GHA]` 开头，与 `updata-verInfo.yml` 的防重入判断兼容，不会互相触发

## OCR 依赖安装

OCR 依赖的**包名与类名都只存仓库 Secret，代码内不出现任何明文**（防止网盘站长扫描仓库后针对性升级验证码）：

- 仓库 Secrets 需配置 `OCR_PKG_NAME` 与 `OCR_CLS_NAME`（见「凭据」一节）
- GHA workflow 安装步骤注入包名后 `pip install`
- `ocr_helper.py` 运行时从同名环境变量读取，未提供则直接报错退出，无内置回退
- 本地开发需先 `export OCR_PKG_NAME=... OCR_CLS_NAME=...` 再运行

> ⚠️ 注意：本目录的 `ocr_helper.py` 是**新版**（收 `<png> [输出文件]` 两个参数 + 从环境变量读包名/类名）。
> 项目外的测试目录 `C:\Users\XiaoluoFoxington\huang1111-api-test` 里另有一份**旧版**（只收 1 个参数、只写 stdout、硬编码OCR导入）。
> 两者互不通用：拿旧版配合新调用方（传输出文件路径）会静默返回空串。排查 OCR 问题时先确认用的是哪一份。
> 若本站 OCR 通路长期可用，「图形验证码 + OCR」为主，「PoW」为兜底（见「重试策略」）。

## 新增/维护软件

1. 打开 [`softwares.json`](softwares.json)，按现有条目格式追加一行（各字段含义见字段名本身与 [`docs/auto-sync-design.md`](../../docs/auto-sync-design.md)）。
2. 确认 `githubRepo`、`mode`（`arch` 按架构出条目 / `name` 按文件名出条目）、资产过滤与兜底架构。
3. 特殊结构（子目录 wrapper、name+children 内联、共存版手动条目等）初版**不纳入**，index.json 手动条目原样透传。

## 故障排查

| 现象 | 原因/处理 |
|---|---|
| Actions 运行失败（红色） | 查看该次运行日志：登录失败 / 某版本下载失败 / 直链失败，均会输出中文原因；下次运行自动重试 |
| 某版本一直失败 | 本地手动跑一次看完整日志；常见：GitHub 资产命名变化（改 `softwares.json`）、验证码与 PoW 双双耗尽（偶发，重跑） |
| index.json 顺序乱了 | 手动条目永远排在版本条目之前，版本条目按版本降序；确认数据源 JSON 未被外部改动破坏 |
| OCR 报错 | 检查是否注入了 `OCR_PKG_NAME` / `OCR_CLS_NAME` 两个 Secret（漏配时助手会报错退出） |
| 日志里出现「图形验证码 10 次均失败…回退 PoW」 | 正常兜底行为，不是故障；说明本次 OCR 一直没识别对，PoW 接住了 |

## 已知边界

- 软件映射见 [`softwares.json`](softwares.json)；其余软件待后续扩展映射表
- 单次运行中途若会话过期（401）不做自动重登（下次运行重新登录）；其余均在约定重试策略内自动恢复
- 自动版本条目带 `size` 字段（前端 `formatBytes` 显示），手动旧条目无 `size` 不影响
