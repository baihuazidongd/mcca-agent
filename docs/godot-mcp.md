# Godot MCP 接入

已从本机 Codex 配置导入 @coding-solo/godot-mcp 0.1.1（MIT），复制到
config/runtimes/godot-mcp。使用应用自己的 Node，不依赖 Codex 私有 Node 路径。
Godot 可执行文件沿用原配置，通过 config/mcp.json 的 GODOT_PATH 指定。

注册项使用 shared: true。门户按需启动一个 MCP 服务，通过工作台的
tools/list 和 tools/call 暴露 shared__godot__ 前缀的 14 个原生工具。
pi/dsh 不再重复启动这条共享记录；pi、dsh、Codex、Grok、OpenHands ACP
和已接入工作台的 Hermes 均通过 mcca-workbench 发现和调用它。
新增 IDE 需要接入工作台 MCP；已有会话若缓存工具列表，需要重载 MCP 或新建会话。

在“管理 → MCP”中，godot 显示“所有 IDE 共享”。该条目的开关全局生效。
编辑共享配置时保留 shared: true；禁用使用 disabled: true。
只有显式标记 shared 的服务经过统一转发，其余 MCP 沿用原先的 IDE 接入方式。

验证：node scripts/smoke-shared-godot.mjs
此检查通过工作台 stdio 与 pi 工具适配器读取 Godot 版本，不启动项目或修改场景。
本机返回 4.6.stable.official.89cea1439。其他 IDE 的模型对话未逐个发送付费请求。
