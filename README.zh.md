# pi-dsh-bridge

让 DeepSeek Harness（dsh）与 pi 并排跑在**同一套插件库、同一份 MCP 注册表、同一个
技能目录**上——不改动任何一个运行时的源码。

## 这是什么

两个 agent 运行时都从 npm 安装：DeepSeek Harness（`@deepseek-ai/dsh`）和 pi
（`@earendil-works/pi-coding-agent`）。两者各有自己的扩展机制、工具 schema 和插件发现
方式，所以为其中一个写的工具在另一个里不能直接用。

本项目在两者之间放了一层很小的中性契约。插件作者只面对一套 API——
`packages/plugin-sdk`——再由两个适配器把这套 API 翻译进各自的运行时：

- `packages/pi-adapter` 把插件注册成 pi 的 extension。
- `packages/dsh-adapter` 把插件注册成 dsh 的 Cordis bundle。

两个运行时都没有打补丁、没有 fork。dsh 通过它自己的 profile 补丁层加一个生成的
`--patch` 覆盖层挂载，因此升级 dsh 不会和这里的东西冲突。

实际效果是：能力只写一次，两个 agent 里都出现。同一个 `plugins/` 目录同时喂给两者，
同一份 `config/mcp.json` 注册表被两者读取，同一个 `skills/` 目录对两者可见。没有任何
按运行时重复的东西，两者也不可能在工具名或 MCP 服务器参数上悄悄分叉——那些只有一个
来源。

围绕这个内核，项目还带一个监管进程和两个 Web 界面：

| 组件 | 作用 | 默认端口 |
| --- | --- | --- |
| `packages/portal` | 启动、停止、监管子进程；提供管理界面 | 3470 |
| `packages/pi-web` | pi 会话的 Web UI：聊天、模型与服务商设置、思考强度 | 3458 |
| dsh | DeepSeek Harness 的 Web UI | 3081 |
| canvas（可选） | 本机生图服务，作为标签页内嵌 | 8188 |

portal 的界面有四个标签：dsh、pi、画布、管理。进程的启停和按 agent 的插件开关都在
「管理」标签里。

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`（见 `package.json` 的 `engines`）
- pnpm（仓库通过 `packageManager` 锁定 `pnpm@11.9.0`）

发布包**只含源码**，不含 `node_modules`，也不含构建产物，所以依赖是在安装时按当前
机器解析的。预装的目录树本来也无法通用：安装会挑选平台相关的产物，另外可选的 Tauri
桌面壳需要 Rust 工具链，这不是能靠打包替代的。

可选的 Tauri 桌面壳（`desktop/`）额外需要 Rust 工具链。项目其余部分都不需要 Rust，
没有它 portal 也能完整地在浏览器里使用。

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 从提交的模板生成配置
pnpm run setup

# 3. 启动 portal
pnpm start
```

然后打开 <http://127.0.0.1:3470/>。dsh 和 pi 在「管理」标签里手动启动，不会自动拉起。

Windows 上 `start.cmd` 会一次做完这三步；macOS 和 Linux 上用 `start.sh`：

```bash
./start.sh
```

两个启动器都会跳过安装（若 `node_modules` 已存在）和跳过生成（若 `config/mcp.json`
已存在），因此可以反复运行。

`package.json` 里的其它脚本：

| 脚本 | 作用 |
| --- | --- |
| `pnpm run setup` | 从提交的模板重新生成 `config/` |
| `pnpm start` | 启动 portal |
| `pnpm run portal` | 直接启动 portal，不经启动器 |
| `pnpm run pi-web` | 只启动 pi 的 Web UI |
| `pnpm run build` | 构建 `plugin-sdk` 与 `plugin-host` |
| `pnpm test` | 跑测试套件 |
| `pnpm run test:pi-web` | 跑 pi-web 的测试套件 |

## 配置

`config/` 目录里同时有提交的模板和生成出来的文件。这么分是因为有些配置必须写成检出
目录的绝对路径，而一份 clone 不应该带上别人机器的路径。

提交进仓库的模板与共享状态：

| 路径 | 用途 |
| --- | --- |
| `config/mcp.example.json` | 共享 MCP 注册表的模板 |
| `config/hot-plugins.example.json` | dsh 宿主插件清单的模板 |
| `config/plugins.json` | 按 agent 的插件启用状态 |
| `config/client-plugins.json` | 客户端插件开关 |
| `dsh/profiles/web/package.json` | dsh profile：bundle 与 profile 依赖 |
| `dsh/profiles/web/cordis.patch.template.yml` | dsh 挂载层的模板 |

由 `pnpm run setup` 生成（并已被 gitignore）：

| 路径 | 生成来源 |
| --- | --- |
| `config/mcp.json` | `config/mcp.example.json` |
| `config/hot-plugins.json` | `config/hot-plugins.example.json` |
| `config/dsh-mcp.patch.yml` | `config/mcp.json`，经 `scripts/gen-dsh-mcp-patch.mjs` |
| `config/dsh-home/profiles/web/package.json` | `dsh/profiles/web/package.json` |
| `config/dsh-home/profiles/web/cordis.patch.yml` | `dsh/profiles/web/cordis.patch.template.yml` |

模板里用 `{{ROOT}}` 表示检出目录的绝对路径，由 `scripts/bootstrap.mjs` 替换。每次运行
都会从模板整体重写这些生成文件，所以直接改生成文件的修改不会被保留。

`config/plugins.json` 是「agent → 插件名 → 是否启用」的映射：

```json
{
  "ds": { "hello-tool": true },
  "pi": { "hello-tool": true }
}
```

`ds` 指 dsh，`pi` 指 pi。某个 agent 的映射里没有的插件，对该 agent 即视为禁用。

### MCP 注册表与环境变量占位

注册表是一个 JSON 数组，每一项是一个 MCP 服务器，两个运行时读的是同一份：

```json
[
  {
    "serverName": "everything",
    "transport": "stdio",
    "command": "node",
    "args": ["{{ROOT}}/mcp/everything/server.mjs"],
    "description": "Demo MCP server: echo, add, now."
  }
]
```

`transport` 为 `"stdio"`（配 `command`、`args`，可选 `env`）或 `"sse"`（配 `url`，可选
`headers`）。条目会原样交给 pi；每个服务器的工具以 `mcp__<serverName>__<tool>` 暴露给
pi，所以示例服务器的 `echo` 工具对外是 `mcp__everything__echo`。

值里可以引用环境变量：

```json
{
  "serverName": "example",
  "transport": "stdio",
  "command": "${USERPROFILE}/tools/example/run.exe",
  "args": ["--cache", "${XDG_CACHE_HOME:-/tmp/example-cache}"],
  "env": { "EXAMPLE_TOKEN_FILE": "${HOME}/.example/token" }
}
```

- `${VAR}` 解析为 `VAR` 的值。
- `${VAR:-fallback}` 在 `VAR` 未设置或为空时解析为 `fallback`。
- 变量未设置且没有 fallback 时，占位符**原样保留**。看得见的 `${...}` 比用一个空命令
  把子进程拉起来要好排查。
- 展开发生在**连接服务器时**，而不是读注册表时。`stdio` 下作用于 `command`、`args` 的
  每一项、`env` 的每个值；`sse` 下作用于 `url` 和 `headers` 的每个值。这个区别是有意的：
  portal 每次切换启用状态都会重写 `config/mcp.json`，更早展开会把本机路径写回文件。
- 只认 POSIX 写法。`%VAR%` 不会被展开，也没有转义出字面量 `${...}` 的语法；确实需要这
  些字符原样的条目，只能用别的方式写。

### dsh 侧的 MCP 行

dsh 通过它自己的 `@deepseek-ai/dsh-mcp-client` 行消费 MCP 服务器，所以
`config/dsh-mcp.patch.yml` 是从 `config/mcp.json` 生成的，而不是手工维护：每个服务器
生成一行，两个运行时因此对服务器名和参数保持一致。给某个条目设 `"dsh": false` 可以让它
不出现在该生成文件里，同时仍对 pi 可用。

## 写一个插件

一个插件是 `plugins/` 下的一个目录，含一个 `manifest.json` 和一个入口模块。入口导出一个
接收中性 API 的工厂函数：

```js
// plugins/hello-tool/index.mjs
export default function helloTool(api) {
  api.registerTool({
    name: "hello",
    description: "根据传入的名字返回一句中文问候。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "要问候的名字。" },
      },
      required: ["name"],
    },
    async execute(args, ctx) {
      const name = typeof args?.name === "string" ? args.name : "世界";
      return {
        content: [{ type: "text", text: `你好，${name}！` }],
        details: { agent: ctx?.agent },
      };
    },
  });
}
```

manifest 声明插件是什么、能在哪里跑：

```json
{
  "name": "hello-tool",
  "version": "1.0.0",
  "kind": "tool",
  "targets": ["ds", "pi"],
  "description": "示例工具插件：根据名字返回一句中文问候（共享库最简样例）。",
  "entry": "index.mjs"
}
```

| 字段 | 含义 |
| --- | --- |
| `name` | 插件 id，也是 `config/plugins.json` 里的键 |
| `version` | 自由格式的版本串 |
| `kind` | 取值之一：`tool`、`command`、`mcp`、`skill`、`ui` |
| `targets` | `["ds"]`、`["pi"]` 或两者。省略或为空表示两者都支持 |
| `description` | 在管理界面里展示 |
| `entry` | 相对插件目录的入口模块，默认依次找 `index.mjs`、`index.js`、`index.cjs`、`index.ts` |

API 上每个注册方法都返回一个 disposer，宿主会自动追踪：

| 方法 | 注册什么 |
| --- | --- |
| `api.registerTool(def)` | 工具，含 `name`、`description`、`parameters`（JSON Schema）和异步 `execute(args, ctx)` |
| `api.registerCommand(name, def)` | 斜杠风格命令，含 `description` 和 `handler(args, ctx)` |
| `api.registerMcpServer(cfg)` | 一个 MCP 服务器，格式见上一节 |
| `api.registerSkill(skill)` | 技能，含 `name`、`description` 和 Markdown 正文 `body` |
| `api.registerUi(def)` | 浏览器侧扩展，含 `name`、`title`、`slot` 和 `entry` |
| `api.on(event, handler)` | 事件监听：`session_start`、`session_end`、`input`、`turn_end` |

因为 disposer 被追踪，插件可以热卸载：卸载时按注册的逆序执行。工厂函数也可以额外返回
一个函数，用于 disposer 覆盖不到的清理。

插件由 `packages/plugin-host` 发现：它扫描共享目录，按 `targets` 和启用状态过滤，用对应
agent 的适配器加载每个入口，并隔离失败——一个插件抛错不会影响其它插件加载。

技能是工厂模式的例外：`kind: "skill"` 的插件提供一个 `SKILL.md`，共享的 `skills/` 目录由
两个运行时各自直接挂载。格式见 `skills/hello-skill/SKILL.md`。

## 架构

`packages/plugin-sdk` 是契约本身。它定义 manifest、六个注册方法和 disposer 规则，别的
什么都没有。插件只依赖这一个包。

`packages/plugin-host` 与运行时无关。它负责发现插件并驱动其生命周期，但从不直接和 dsh
或 pi 打交道——每个适配器交给它一个 `PluginApiImpl`，由后者知道如何按原生方式注册。

`packages/pi-adapter` 与 `packages/dsh-adapter` 各实现一次这个接口。

`packages/pi-mcp` 是给 pi 用的 MCP 客户端。`packages/portal` 与 `packages/pi-web` 分别是
监管进程和两个 Web 界面。

各部分的组合方式——包括 dsh 挂载层如何工作、为什么改插件不需要重启 dsh——见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 故障排查

**`[start] configuration is not generated yet`** —— 先 `pnpm install`，再
`pnpm run setup`。`scripts/bootstrap.mjs` 在运行前会检查两个运行时依赖是否就位，不满足
就带提示退出，因为它写出的配置指向检出目录里的路径。

**`pnpm run setup` 报 `missing template`** —— `config/` 或 `dsh/` 下某个提交的模板被移动
或删除了。该脚本只从这两个位置读模板。

**dsh 首次启动报缺模块** —— dsh 需要 `config/dsh-home` 下自己的 profile，`pnpm run setup`
会连同 profile 的 `package.json` 一起建好。dsh 在启动时**不会**解析该 profile 的依赖；
它们通过 dsh 的 `plugin` 子命令管理，该命令把剩余参数转发给 profile 目录里的 pnpm：

```bash
DSH_HOME=./config/dsh-home node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web install
```

该 profile 依赖 `@deepseek-ai/dsh-mcp-client` 与 `@deepseek-ai/dsh-skill-filesystem`。

**dsh 版本** —— `@deepseek-ai/dsh` 处于早期 release candidate，它解析的 profile bundle
图（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`）会随之变动。需要可复现就锁定你
验证过的版本。

**画布标签没反应** —— 画布是一个本机生图后端，程序不假设它的安装位置。用 `CANVAS_CMD`
指向其可执行文件，用 `CANVAS_CWD` 指向其工作目录。默认命令在 Windows 上是 `python.exe`，
其它平台是 `python`，参数为 `main.py --port <端口>`。

**`pnpm install` 解析不了 `@aws-sdk/token-providers`** —— pi 的 AWS Bedrock 服务商链路
要一个未发布到 npm 的版本。`pnpm-workspace.yaml` 通过 `overrides` 把它钉到已发布的最新版，
原因就记在旁边的注释里。等 pi 自己的链路能解析后即可去掉该覆盖。

**某个 MCP 服务器以空命令或空路径启动** —— 看它的 `config/mcp.json` 条目是否用了环境
占位符、而该变量在这台机器上没设置。未设置且无 fallback 的变量会原样保留，所以在报错
输出里找字面量 `${...}`。

**端口被占用** —— 默认是 3470（portal）、3458（pi-web）、3081（dsh）、8188（画布）。每个
都可覆盖：`PORTAL_PORT`、`PI_WEB_PORT`、`DSH_PORT`、`CANVAS_PORT`。

## 许可证

MIT，见 [LICENSE](LICENSE)。
