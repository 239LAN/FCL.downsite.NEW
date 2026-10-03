# AGENTS.md

> **先读全局规则：`C:\Users\XiaoluoFoxington\GLOBAL_AGENTS.md`。**
> 那里放的是跨工作区通用、且各工作区都会重复用到的内容——**代理怎么用、沙箱的 TLS/文件权限限制、浏览器偏好**等。
> 本文件只写本项目特有的东西，不重复全局内容。
>
> **优先级：本文件 ＞ 全局规则 ＞ Agent 自己的默认习惯。**
> 两者冲突时以本文件为准（它更具体）；但工具调用报错信息等硬性约束永远优先于任何规则文件。

## 注意

- TRAE_CN（网页端）会自动新建一个分支然后在每一次提交后自动同步到远端。
- TRAE_CN（客户端）内置记忆功能，文件在`C:\Users\XiaoluoFoxington\.trae-cn\memory\projects\-f-XiaoluoFoxington-Project-FCL-downsite-NEW--p2-7f0fb08beb6b0543e2e0\project_memory.md`。与此记忆文件不冲突。
