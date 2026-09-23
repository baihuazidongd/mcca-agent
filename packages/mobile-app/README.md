# mcca 手机端（App + 桥 + 中转）

给桌面应用配的原生手机客户端：**QQ 式的会话列表 + 流式聊天**，pi 与 dsh 两个 agent
平级接入；图片双向（拍照/相册发图、对话里的图与工具产出缩略图、全屏查看与保存）；
任务状态、完成/失败通知、远程操作（发消息/排队/停止/新建/删改会话/切模型/思考强度/
dsh 目标 goal 操作）和桌面进程管理（dsh / pi / 画布 / 手机桥）。深色/浅色双主题可切。

```
┌────────────┐   LAN: ws://<桌面内网IP>:3471/ws     ┌──────────────────────────┐
│  Android   │ ───────────────────────────────────▶ │  mobile-bridge            │
│  App       │   WAN: ws://<服务器>/mcca/app        │  （桌面 :3471）            │
└────────────┘                                       │  pi-web REST/SSE          │
      ▲                                              │  dsh /api + events.mux/host│
      │  ws://<服务器>/mcca/app（外网时）              │  portal REST              │
┌─────┴──────────────┐   ← 桌面主动外连 /mcca/desktop  └──────┬───────────────────┘
│ mobile-relay        │ ◀────────────────────────────        │ 127.0.0.1
│ （云服务器 nginx+node）│                               ┌──────▼───────┐
└────────────────────┘                                │ portal :3470 │
                                                      │ pi-web :3458 │
                                                      │ dsh web :3081│
                                                      └──────────────┘
```

## 两个 agent 怎么接的

| agent | 数据来源 | 会话 | 流式 | 图片 |
|---|---|---|---|---|
| pi | pi-web REST + SSE | `/api/sessions*` | SSE 帧 → `reducer.cjs` 归约 | 发送走 prompt 的 `images[{mimeType,data}]`；工具产出内联缩略图；正文 `![alt](path)` 经 `/api/file` 代理读取；**会话头像**取 pi-web 的像素角色素材（`public/avatars/manifest.json`，与前端同一套 hash，每个会话固定一个角色；子代理按 `roles` 固定） |
| dsh | Cordis apiproxy + WebSocket | `session.list/history/prompt/cancel/create/rename` | `/api/events.mux` + `/api/events.host` → `dsh-reducer.cjs` 归约 | 发送走 `content:[{type:'image',mediaType,data}]`；历史/工具图片按 `attachmentId` 经 `session.attachment` 拉取 |

dsh 侧无鉴权，桥在本机回环直连（Host 信任栅栏内），不需要给 dsh 开端口。

聊天页**默认停在最后一条**（打开就看最新结果），往上翻会出现「回到最新」按钮。

**Markdown 渲染**（`app/src/main/java/com/mcca/mobile/ui/Markdown.kt`，自研轻量版，不引第三方库）：
标题 `#`–`######`、有序/无序列表（含嵌套与 `- [ ]` 勾选框）、围栏代码块（带语言标签与「复制」、
横向滚动）、引用、表格（列宽按内容自适应）、分割线；行内 **加粗**、*斜体*、~~删除~~、`代码`、
链接（http/https 走系统浏览器，本地路径弱化为代码样式）。下划线强调要求词边界，
`zb_ares.png` 这类标识符不会被误判成斜体。

## 应用内更新

「我的 → 更新」里可以检查、下载并安装新版本（不用连电脑）：

- **检查**：读中转的 `/mcca/version.json`（`{versionCode, versionName, sha256, size, builtAt}`）比对版本号；
  没有元数据时回落成「先下载整包、再按包内版本号判断」。
- **下载**：从 `/mcca/app.apk` 流式下载到 `cacheDir/update/`，带进度条与 sha256 校验。
- **安装**：FileProvider 暴露缓存里的 APK，拉起系统安装器（`REQUEST_INSTALL_PACKAGES`）。
  首次需要在系统里允许「安装未知应用」，App 会检测并一键跳到对应设置页。

发布一个新版本：

```bash
pnpm --filter @mcca/mobile-app apk                      # 1) 出包（记着改 app/build.gradle.kts 的 versionCode/Name）
node packages/mobile-app/scripts/publish-apk.mjs        # 2) 生成 version.json（sha256/size/版本号）
scp app-release.apk version.json <user>@<relay>:/opt/mcca-relay/
# 3) 服务器上：mv app-release.apk app.apk && chown www-data:www-data app.apk version.json
```


## 本地缓存与秒开

会话列表和每个会话最近 200 条消息会落盘到 `filesDir/cache/`（`sessions.json` + `msg-<key>.json`，
3 秒去抖写入、关会话立即写）。冷启动先渲染快照再拉服务端；断网也能看历史。角色头像在会话列表
刷新时批量预取、失败 20 秒后自动重试，所以滚到哪都有图。卸载重装会清空内部存储（Android 机制），
那种情况只能重新拉。

## 子代理（subagent）

pi 的子代理是独立子会话（不在会话列表里出现）。App 里：

- **任务页**：每个 run 一张卡，带**角色头像**（取 pi-web `avatars/manifest.json` 的 `roles.<agent>`，
  如 worker / reviewer / oracle / scout / delegate 各有固定立绘）、状态、耗时、任务描述、结果/错误；
  working 的可以直接「停止」。
- **点卡片进详情**：只读转录（思考过程折叠、Markdown 正文、工具调用可展开、代码块可复制），
  顶部「父会话」一键跳到发起它的会话；右上刷新可重拉。
- 数据来源：桥的 `tasks.transcript {sessionId, runId}` → pi-web
  `/api/sessions/:parent/subagents/:runId/transcript`（异步 run 会读它的 transcript 产物）。

## 事件板（同步 portal + 原生推送）
portal 顶栏的「事件板」在 App 里是**独立页签**（底栏第三个），数据走同一条队列：`/api/notify` 的
`kind` 决定去向——`manual`（人在会话里要求推的，技能 `skills/event-board`）上板；`auto`
（任务完成/失败、agent 错误）只弹系统通知不上板。旧版 portal 不带 `kind`，App 按人工条目处理。

- 列表：新→旧，未读带绿点 + 底栏 tab 角标；正文超过 3 行可「展开全文」；「清空」只清板上条目，
  水位（清空/已读）与 portal 端 localStorage 同语义，落盘在 App 设置里，跨重启保留。
- 原生推送：事件板条目走独立通知渠道「事件板」（IMPORTANCE_HIGH、震动），自动播报走
  「任务通知」；点事件板通知直接落到事件板页签，点任务通知落到对应会话。
- 任务页的「通知」分段只显示 auto 条目，不再和事件板混在一起。

> 需要桌面端 portal 是**带 kind 的新版**（重启一次桌面应用即可）。旧进程里任务完成/失败这类
> 自动播报没有 kind 字段，会暂时按人工条目显示在事件板上，「清空」即可。

## 三个包

| 包 | 跑在哪 | 作用 |
|---|---|---|
| `packages/mobile-bridge` | 桌面（随 portal 自动启动） | 聚合 pi-web / dsh / portal，暴露移动协议；局域网监听 `0.0.0.0:3471`，并主动外连中转 |
| `packages/mobile-relay` | 云服务器 | 无状态中转：App 的请求转发给桌面，桌面的事件广播给 App；token 鉴权 + APK 下发 |
| `packages/mobile-app` | 手机 | 原生 Kotlin + Compose；局域网/中转自动切换 |

## 桌面侧

```bash
node packages/mobile-bridge/server.cjs       # 手动跑（portal 启动时会自动拉起）
```

首次启动会生成 `config/mobile.json`（**已 gitignore，含配对 token**）：

```json
{
  "token": "手机接入凭证",
  "port": 3471,
  "name": "桌面名",
  "relayUrl": "ws://<你的中转服务器>/desktop"
}
```

- `relayUrl` 留空 = 仅局域网可用；填上则走公网中转。
- portal 的「管理」页有「手机接入 (bridge)」卡片，可看运行状态/启停。点「常驻」后：门户启动时
  端口上没人听就自动拉起，桥异常退出由 20s 巡检重新拉起；点「停止」只暂停本轮常驻（下次门户
  启动恢复）。关掉桌面窗口不影响在跑的桥（子进程 detached，实测父进程被结束仍存活）。
- 环境变量覆盖：`MCCA_MOBILE_TOKEN` / `MCCA_MOBILE_PORT` / `MCCA_RELAY_URL` /
  `MCCA_PI_WEB_BASE` / `MCCA_PORTAL_BASE` / `MCCA_DSH_BASE`（默认 `http://127.0.0.1:3081`）。

## 服务器侧（中转）

```bash
sudo bash packages/mobile-relay/deploy/install-direct.sh <token>   # 与桌面 token 一致
```

做的事：装 Node 22 到 `/opt/node` → 放 `/opt/mcca-relay` → systemd `mcca-relay`
**直接监听 80**（`RELAY_PORT` 可改；不依赖 nginx，最省一层转发）。
验证：`curl http://<服务器>/health`，`desktop.online` 为 `true` 表示桌面已挂上来。

- APK 放在 `/opt/mcca-relay/app.apk` 时，`http://<服务器>/app.apk` 可直接下载安装。
- `RELAY_DEBUG=1`（systemd drop-in）会记录每个请求/回包的转发日志。

## 手机侧

从 `http://<服务器>/app.apk` 下载安装，或本地构建：

```bash
pnpm --filter @mcca/mobile-app apk        # packages/mobile-app/app/build/outputs/apk/release/app-release.apk
```

「我的」页填两样：

1. **中转地址**：你自己的中转服务器（可省 `ws://`，程序会补；留空 = 只走局域网）
2. **手机接入 token**：桌面 `config/mobile.json` 里的 token

「我的 → 连接方式」可切 **自动 / 仅局域网 / 仅中转**（秒级生效）：

- **自动**（默认）：局域网可达就直连，不可达自动走中转；走中转时会定期重探，通了切回直连。
- **仅局域网**：只直连桌面，绝不上中转（在家用，省流量、最低延迟）。
- **仅中转**：始终走公网中转，同 Wi-Fi 下也不切（在外用，最稳）。

局域网地址可不填——App 连上后会从桌面 hello 里学到内网地址。连接过的成功端点会记下来，
冷启动**先直连该端点**（不再等 UDP 发现/逐个探测，进程被杀重开约 0.3s 挂回）；
UDP 发现只在后台补充候选。断开后指数退避重连，前台服务保活（通知栏常驻
「mcca · 局域网直连/公网中转」），任务完成/失败发系统通知，点通知直达对应会话。

「我的 → 外观」里可切 **跟随系统 / 深色 / 浅色** 三档主题。

## 后台推送（微信/QQ 式）

连接由前台服务（`HubService`，常驻通知「mcca · 局域网直连/公网中转」）保活：划掉最近任务、
锁屏、切后台都不影响收消息。任务完成/失败走「任务通知」通道、事件板走「事件板」通道，
两者都是 **IMPORTANCE_HIGH**（弹横幅 + 提示音 + 震动），并按 `mcca` 分组折叠（带摘要）。

- **开机自启**：`BootReceiver` 收到 `BOOT_COMPLETED` / `MY_PACKAGE_REPLACED` 自动拉起服务，
  重启手机后不用先打开 App 也能恢复在线。
- **「我的 → 后台通知」** 卡片给全了系统入口：通知权限、电池优化白名单（
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`）、系统应用设置页，还有「发测试通知」一键自检。
- 国产 ROM 的省电策略仍需手动放行（卡片里有小米/华为/OPPO/vivo 的具体路径）；
  若 App 被系统「强行停止」，任何应用都无法后台收消息，需重新打开一次。

## 协议（桥与 App）

JSON 文本帧，见 `packages/mobile-bridge/server.cjs` 顶部注释：

```
App → 桥   {t:"req", id, m, p}
桥 → App   {t:"res", id, ok, d} | {t:"res", id, ok:false, e}
桥 → App   {t:"evt", m, d}        m: sessions | patch | notify | host | relay | hello
```

方法：`hello` `sessions.list/open/close/send/stop/create/delete/rename/setModel/setThinking/models/workspaces`
`tasks.list` `tasks.stopSubagent` `goal.action`（dsh 目标 create/pause/resume/complete/clear）
`notify.list` `host.status/action/logs` `file.get`（图片：pi 传 `path`，dsh 传 `attachmentId`）。

会话与事件都带 `agent`（`pi` / `dsh`）：`sessions.list` 合并两个 agent 并按时间排序，
`sessions.open/send/...` 用 `agent` 路由。`patch` 是手机侧的增量协议
（`reset` / `msg` / `delta` / `session`），两个 agent 各自归约成同一套消息模型
（`reducer.cjs` / `dsh-reducer.cjs`），App 端不区分 agent。测试见
`test/mobile-bridge.test.mjs`、`test/mobile-bridge-dsh.test.mjs`、`test/mobile-relay.test.mjs`。

## 本地验证（雷电模拟器）

```powershell
& "D:\leidian\LDPlayer14\ldconsole.exe" launch --name dsh
& "D:\leidian\LDPlayer14\adb.exe" devices
& "D:\leidian\LDPlayer14\adb.exe" install -r packages\mobile-app\app\build\outputs\apk\release\app-release.apk
```

想验证「出门在外」的中转路径，可在模拟器里屏蔽局域网直连再重连：

```bash
adb shell "su -c 'iptables -I OUTPUT -d <桌面内网IP> -p tcp --dport 3471 -j DROP'"
adb shell "su -c 'iptables -D OUTPUT -d <桌面内网IP> -p tcp --dport 3471 -j DROP'"   # 恢复
```

给模拟器塞测试图片：`adb push test.png /sdcard/Pictures/` 后再跑一次媒体扫描广播
（`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/test.png`），
在 App 的「＋ → 从相册选择」里就能选到。

