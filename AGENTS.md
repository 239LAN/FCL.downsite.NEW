# AGENTS.md
## 不对劲

- TRAE_CN（网页端）会自动新建一个分支然后在每一次提交后自动同步到远端。
- TRAE_CN（客户端）内置记忆功能，文件在`C:\Users\XiaoluoFoxington\.trae-cn\memory\projects\-f-XiaoluoFoxington-Project-FCL-downsite-NEW--p2-7f0fb08beb6b0543e2e0\project_memory.md`。与此记忆文件不冲突。

## 修改这里
- **时效性**：这里的内容并非是绝对准确的，有的可能已过时或不使用。如发现需修改此文件以保持最新。
- **记录**：如果发现了用户的工作偏好、 硬性约束等有变化或更新，及时记录在文件中。

## 工作偏好
- **环境**：如果不知道当前所在的环境是DSH、TRAE_CN（客户端）还是TRAE_CN（网页端），直接问用户。
- **提问**：如果用户没有明确说明"不要问我问题""我睡觉去了"，遇到任何需要决策的事时直接向用户提问，不要擅自做决定。

## 经验教训
- DeepSeekHarness 的沙箱环境无法用 schannel 建立 TLS（报 `SEC_E_NO_CREDENTIALS`），git 推送需单次覆盖 `git -c http.sslbackend=openssl push`；用户本机终端不受影响，勿因此改动全局 git 配置。
- 用 `python -m http.server` 起本地服务验证前端改动时，浏览器会缓存 ES 模块，改动可能看似没生效（可 `fetch(url, {cache:'no-store'})` 判别）。换端口（新 origin，缓存为空）或强制刷新后才能得到真实结果；换端口会丢失该 origin 的 localStorage 语言偏好（`fdn-language` / `fdn-language-order`），需重新设置。
- 验证前端改动可用本机 Edge 无头模式截图：`msedge.exe --headless=new --user-data-dir=<临时目录> --window-size=W,H --screenshot=out.png <url>`。务必带独立 `--user-data-dir`，否则复用默认配置时会挂住不退出；要等页面异步渲染完就用 CDP（`--remote-debugging-port` + Node 内置 `WebSocket`）做 `Page.navigate` / `Runtime.evaluate` / `Page.captureScreenshot`，比 `--dump-dom`（管道下常拿不到输出）可靠。改 CSS 后必须用干净 profile，否则会读到旧的缓存样式而误判。
- 本站的常驻侧栏是 MDUI 抽屉：`css/mdui.patch.css` 在 `min-width:1024px` 下把它改成 **320px 宽**（不是 MDUI 默认的 240px），`z-index: 5000`，body 同时有对应 padding。任何 `position: fixed` 在视口右下角/左下角的元素都会被它整片盖住（实测查不出来是因为 `pointer-events: none` 会让元素从 `elementsFromPoint` 里消失），装饰性元素改为放进正文文档流更省事。
