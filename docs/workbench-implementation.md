# 统一工作台实施记录

## 已确认需求

- 可接入更多开源 IDE；保留不同宿主的能力差异。
- 简单交付，不强求 EXE；组件在应用内按需安装。
- 插件、技能、MCP 集中管理，公共工具尽可能通用。
- AI 独立浏览器及用户浏览器控制。
- 多模拟器、多实例、真实安卓设备；开发、网络分析及逆向工具。
- Hermes 或可替换助理了解应用，代发、监工、停止任务；即时及长期委托。
- 不要求 IDE 间共享会话或多智能体协作。
- 自我迭代针对 pi/dsh 等支持定制的 IDE，不等于整个工作台自修改。
- 功能和可靠性优先，同时优化内存、CPU、延迟和后台消耗。

## 当前实现

- `config/runtimes.json`：内置运行时目录；前端页签、状态列表、启停规格、会话监控来源由它派生。
- `packages/runtime-core/registry.cjs`：自定义运行时持久保存、路径变量、依赖循环与端口校验；新网页 IDE 不需改前端。
- `paths.cjs`：`MCCA_HOME` 为程序目录、`MCCA_DATA_DIR` 为数据目录。开发默认继续使用原 config；不静默搬动凭据。
- `workbench.cjs`：本机 MCP Streamable HTTP 服务，令牌鉴权；stdio 转接让各宿主连接同一服务。任务与工具不在每个客户端重复启动。
- `tasks.cjs`：pi/Codex/Grok 会话任务的提交、检查、停止、持久状态、幂等 key 和可选期限；断线不判完成、不自动重发；idle 明确表示需核对结果。
- `browser.cjs`：按需启动的 AI 浏览器；独立 context、登录存储；连接已有本机 CDP 浏览器；页面明确归属；每会话串行操作；AX 快照、定位交互、iframe、截图、cookie、上传下载、网络元数据与阻断/mock。
- `browser-extension.cjs` + `packages/browser-extension`：Chrome/Edge MV3 本机扩展配对；用户明确允许标签页后，工作台可通过 debugger 控制该标签页，不需要日常浏览器重启到 CDP 端口；配对凭据与工作台令牌分离，可撤销，操作超时不自动重放。
- `android.cjs`：明确 device serial；每设备串行；ADB 基础操作和直接管道截图，不再经 sdcard 中转截图。
- `emulators.cjs`：雷电 `list2`、实例启动/停止/重启、创建/克隆/参数调整，以及 Android SDK AVD 启停；实例 ID、serial、窗口句柄和 PID 分开解析；生命周期操作由用户显式触发。
- `frida.cjs` / `frida-worker.py`：按需常驻 Python helper，真正 attach/load/unload/detach；有界 hook 事件队列。保留可用 Python 生态，不为去 Python 而重写。
- `install.cjs`：HTTPS + SHA-256、临时目录、ZIP 边界检查、失败不替换当前安装、保留上一版。Codex 内置官方版本地址和摘要；其他可登记 artifact。
- `supervisor.cjs`：失败重启退避；禁用未运行 IDE 的前端探测循环；Hermes 自动安装改为显式按需。
- pi、dsh patch、Codex app-server、Grok ACP 加入工作台 MCP；Hermes 通过工作台按钮写入配置并备份旧配置，新会话生效。
- dsh 使用原生 `session.*` RPC 接入统一任务提交、轮询、历史和停止；任务 key 绑定请求指纹，重用 key 发送不同内容会拒绝。
- `assistant-jobs.cjs` 接入 Hermes Dashboard 原生 cron jobs：长期委托带明确范围、稳定 key、静默通知策略和本地投递；创建传输异常不会自动重复创建。
- `scripts/build-portable.ps1`：建立不包含个人配置/会话的预览分发目录，包含 Node 和生产依赖；VBS 隐藏启动 PowerShell，打开网页工作台。
- `scripts/migrate-data.ps1`：显式复制数据快照，不删除源数据、不覆盖目标。

## 操作入口

主窗口的“工作台”页：IDE 与组件 / 任务与监工 / 浏览器 / 安卓设备 / 助理接入。

开发启动：`pnpm start`。测试：`pnpm test`、`pnpm smoke:workbench`。便携包：`pnpm dist:portable`。

新增工具配置保存在数据目录 `workbench/settings.json`。可在安卓页填入 ADB、带 Frida 的 Python、浏览器可执行文件路径。

## 交付边界

- 浏览器扩展目前按 Edge/Chrome 的开发者模式加载本地目录，覆盖配对、标签授权、快照、截图、导航、点击、填写和撤销控制；未发布商店安装包。
- 模拟器生命周期内置雷电和 Android SDK AVD，并支持注册其他品牌配方；真实设备能力取决于 ADB 授权、厂商驱动和设备权限。
- scrcpy、网络抓包和 APK 分析均为按需工具任务，任务输出会保留并报告 `finished`、`partial` 或失败状态；Frida 注入仍取决于目标设备上的 frida-server。
- dsh、pi、Codex、Grok、OpenHands ACP 和 Hermes 接入使用各自协议；OpenHands 模型供应商和 Hermes 调度器仍需用户配置并保持运行。
- 便携包是可复制的预览分发目录，运行时和生产依赖随包提供，IDE/组件继续在应用内按需安装，不携带用户凭据、会话或私有配置。
- 工作台不代替第三方 IDE 的许可证、官方账号、商店发布或所有版本兼容性认证。
## 验证

- 全量 Node 测试 116/116；新增 dsh、模拟器、浏览器扩展、Hermes 委托和配置异常测试。
- 真实 Edge 冒烟：门户 UI、自定义 IDE 页签、MCP 配置生成、AI 浏览器读取/填表/点击、跨会话 page 拒绝、个人浏览器断开后仍可用。
- 真实 Edge MV3 扩展冒烟：配对、明确标签页授权、AX 快照、填写/点击、截图、隔离、撤回控制后原页面继续可用。
- 真实 ADB 发现 emulator-5554，直接管道 PNG 截图成功。
- Frida 16.7.19 helper 真实枚举出模拟器设备；未对用户应用执行注入。
- Tauri `cargo check --offline` 通过（已有 PortalChild 未读取警告）。
- `scripts/smoke-portable-runtime.mjs`：最新便携包 `dist/mcca-20260926-012202` 在隔离 PATH 下通过 bundled Node、node-pty、pi 模型/会话 API 验证。

用户原始未提交文件已在 `%LOCALAPPDATA%/mcca/checkpoints/20260925-235542` 保存检查点，包含当时的 git 状态；未提交用户数据到 Git。
