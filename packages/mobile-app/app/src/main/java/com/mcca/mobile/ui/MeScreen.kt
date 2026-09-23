package com.mcca.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import com.mcca.mobile.Background
import com.mcca.mobile.Notifier
import androidx.compose.ui.unit.sp
import com.mcca.mobile.data.Args
import com.mcca.mobile.data.Updater
import com.mcca.mobile.net.Hub
import kotlinx.coroutines.launch
import java.io.File

/** 应用内更新状态机。 */
sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data object Latest : UpdateState
    /** 中转没有 version.json：需要下载后再读包内版本 */
    data object NoMeta : UpdateState
    data class Available(val info: Updater.Info) : UpdateState
    data class Downloading(val percent: Int, val done: Long, val total: Long) : UpdateState
    data class Ready(val file: File, val versionName: String, val versionCode: Int) : UpdateState
    data class Failed(val message: String) : UpdateState
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MeScreen(args: Args, onSave: (Args) -> Unit) {
    var relay by remember(args.relayHost) { mutableStateOf(args.relayHost) }
    var token by remember(args.token) { mutableStateOf(args.token) }
    var lan by remember(args.lanHost) { mutableStateOf(args.lanHost) }
    var notify by remember(args.notify) { mutableStateOf(args.notify) }
    var theme by remember(args.theme) { mutableStateOf(args.theme) }
    var savedHint by remember { mutableStateOf("") }
    val conn by Hub.conn.collectAsState()

    fun persist(next: Args) = onSave(next)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("我的", fontWeight = FontWeight.SemiBold, fontSize = 20.sp) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
        ) {
            SectionCard("连接") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(if (conn.online) accent else Danger),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        when {
                            conn.online && conn.mode == Hub.Mode.LAN -> "局域网直连"
                            conn.online -> "公网中转"
                            else -> "未连接"
                        },
                        fontWeight = FontWeight.Medium,
                        fontSize = 14.sp,
                    )
                    Spacer(Modifier.weight(1f))
                    Text(conn.detail, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
                Spacer(Modifier.height(6.dp))
                KeyValueRow("桌面", conn.desktop?.name ?: "-")
                KeyValueRow("版本", conn.desktop?.version ?: "-")
                if (conn.since > 0) KeyValueRow("已连接", fmtDuration(System.currentTimeMillis() - conn.since))
                if (conn.desktop != null && conn.desktop!!.lanAddresses.isNotEmpty()) {
                    KeyValueRow("桌面内网", conn.desktop!!.lanAddresses.joinToString(", "))
                }
                Spacer(Modifier.height(4.dp))
                Row {
                    TextButton(onClick = { Hub.reconnect() }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp)) {
                        Text("立即重连", color = accent, fontSize = 13.sp)
                    }
                    TextButton(onClick = { Hub.stop() }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp)) {
                        Text("断开", color = Danger, fontSize = 13.sp)
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text("连接方式", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
                Row {
                    for ((id, label) in listOf("auto" to "自动", "lan" to "仅局域网", "relay" to "仅中转")) {
                        FilterChip(label, args.connMode == id) {
                            persist(args.copy(connMode = id))
                            savedHint = when (id) {
                                "lan" -> "已切到仅局域网：只直连桌面，出门会连不上"
                                "relay" -> "已切到仅中转：始终走公网中转"
                                else -> "已切到自动：局域网优先，不可达时走中转"
                            }
                            Hub.reconnect()
                        }
                    }
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    when (args.connMode) {
                        "lan" -> "只走局域网直连（最快，适合在家）；探测不到会一直重试，不会偷偷走中转。"
                        "relay" -> "只走公网中转（最稳，适合在外面）；同 Wi-Fi 下也不会切局域网。"
                        else -> "局域网可达就直连（快），不可达自动走中转；推荐日常使用。"
                    },
                    fontSize = 11.sp,
                    lineHeight = 16.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            SectionCard("外观") {
                Text("主题", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
                Row {
                    for ((id, label) in listOf("system" to "跟随系统", "dark" to "深色", "light" to "浅色")) {
                        FilterChip(label, theme == id) {
                            theme = id
                            persist(args.copy(theme = id))
                            savedHint = "主题已切换"
                        }
                    }
                }
            }

            SectionCard("服务器") {
                OutlinedTextField(
                    value = relay,
                    onValueChange = { relay = it },
                    label = { Text("中转地址（公网）") },
                    placeholder = { Text("公网 IP 或域名，留空则仅局域网") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    label = { Text("手机接入 token") },
                    placeholder = { Text("桌面 config/mobile.json 里的 token") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = lan,
                    onValueChange = { lan = it },
                    label = { Text("局域网地址（可选）") },
                    placeholder = { Text("192.168.0.100:3471") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "同 Wi-Fi 下会自动探测桌面广播的局域网地址并直连，探测不到再走中转；这里填的地址是兜底。",
                    fontSize = 11.sp,
                    lineHeight = 16.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(14.dp))
                Button(onClick = {
                    persist(args.copy(relayHost = relay, token = token, lanHost = lan))
                    savedHint = "已保存，正在按新配置连接…"
                }, modifier = Modifier.fillMaxWidth()) { Text("保存并连接") }
                if (savedHint.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    Text(savedHint, color = accent, fontSize = 12.sp)
                }
            }

            SectionCard("通知") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("任务完成 / 失败提醒", fontSize = 14.sp)
                        Text("桌面端任务跑完时推送到手机", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Switch(
                        checked = notify,
                        onCheckedChange = {
                            notify = it
                            persist(args.copy(notify = it))
                        },
                        colors = SwitchDefaults.colors(checkedTrackColor = accent),
                    )
                }
            }

            SectionCard("后台通知") {
                val context = LocalContext.current
                var notifOn by remember { mutableStateOf(Notifier.enabled(context)) }
                var batteryOk by remember { mutableStateOf(Background.batteryUnrestricted(context)) }
                // 从系统设置页回来时重新读一遍（用户可能刚开完权限）
                val owner = LocalContext.current as? LifecycleOwner
                DisposableEffect(owner) {
                    val obs = LifecycleEventObserver { _, e ->
                        if (e == Lifecycle.Event.ON_RESUME) {
                            notifOn = Notifier.enabled(context)
                            batteryOk = Background.batteryUnrestricted(context)
                        }
                    }
                    owner?.lifecycle?.addObserver(obs)
                    onDispose { owner?.lifecycle?.removeObserver(obs) }
                }
                KeyValueRow("通知权限", if (notifOn) "已开启" else "被系统关闭（收不到提醒）")
                if (!notifOn) {
                    TextButton(onClick = { Background.openNotificationSettings(context) }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                        Text("去开启通知权限", color = accent, fontSize = 13.sp)
                    }
                }
                KeyValueRow("电池优化", if (batteryOk) "已允许后台常驻" else "系统可能随时冻结连接")
                if (!batteryOk) {
                    TextButton(onClick = { Background.requestBatteryUnrestricted(context) }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                        Text("加入电池优化白名单", color = accent, fontSize = 13.sp)
                    }
                }
                Row {
                    TextButton(onClick = { Background.openAppSettings(context) }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                        Text("打开系统应用设置", color = accent, fontSize = 13.sp)
                    }
                    TextButton(onClick = { Notifier.test(context) }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                        Text("发测试通知", color = accent, fontSize = 13.sp)
                    }
                }
                Text(
                    "想做到微信/QQ 那样后台也能收提醒：① 通知权限开着；② 电池优化白名单；" +
                        "③ 国产 ROM 还要允许自启动——小米/红米：设置→应用设置→应用管理→mcca→自启动 + 省电策略「无限制」；" +
                        "华为/荣耀：手机管家→应用启动管理→mcca→手动管理（三个开关都开）；" +
                        "OPPO/vivo/一加：设置→电池→应用耗电管理→允许后台运行。",
                    fontSize = 11.sp,
                    lineHeight = 16.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            SectionCard("更新") {
                val context = LocalContext.current
                val scope = rememberCoroutineScope()
                val (currentCode, currentName) = remember { Updater.currentVersion(context) }
                var state by remember { mutableStateOf<UpdateState>(UpdateState.Idle) }
                var needPermission by remember { mutableStateOf(!Updater.canInstall(context)) }

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("当前版本", fontSize = 14.sp)
                        Text(
                            "$currentName ($currentCode)",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(
                        onClick = {
                            if (state is UpdateState.Checking) return@TextButton
                            state = UpdateState.Checking
                            scope.launch {
                                val info = Updater.check(relay)
                                state = when {
                                    info == null -> UpdateState.NoMeta
                                    info.versionCode > currentCode -> UpdateState.Available(info)
                                    else -> UpdateState.Latest
                                }
                            }
                        },
                        enabled = state !is UpdateState.Checking && state !is UpdateState.Downloading,
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp),
                    ) {
                        Text(
                            if (state is UpdateState.Checking) "检查中…" else "检查更新",
                            color = accent,
                            fontSize = 13.sp,
                        )
                    }
                }

                when (val s = state) {
                    is UpdateState.Latest -> {
                        Spacer(Modifier.height(4.dp))
                        Text("已是最新版本", color = accent, fontSize = 12.sp)
                    }
                    is UpdateState.NoMeta -> {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "中转没有版本元数据（version.json）。可以直接下载最新安装包，下载后按包内版本判断。",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontSize = 11.sp,
                            lineHeight = 16.sp,
                        )
                        TextButton(
                            onClick = {
                                val url = Updater.apkUrl(relay) ?: run { state = UpdateState.Failed("未配置中转地址"); return@TextButton }
                                scope.launch {
                                    state = UpdateState.Downloading(0, 0, 0)
                                    try {
                                        val file = Updater.download(context, Updater.Info(0, "latest", "", 0, url, "")) { p, d, t ->
                                            state = UpdateState.Downloading(p, d, t)
                                        }
                                        val ver = Updater.readApkVersion(context, file)
                                        state = if (ver != null && ver.first > currentCode) {
                                            UpdateState.Ready(file, ver.second, ver.first)
                                        } else {
                                            UpdateState.Latest
                                        }
                                    } catch (e: Throwable) {
                                        state = UpdateState.Failed(e.message ?: "下载失败")
                                    }
                                }
                            },
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp),
                        ) { Text("下载最新安装包", color = accent, fontSize = 12.sp) }
                    }
                    is UpdateState.Available -> {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "发现新版本 ${s.info.versionName} (${s.info.versionCode})" +
                                if (s.info.size > 0) " · ${fmtBytes(s.info.size)}" else "",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                        )
                        if (s.info.builtAt.isNotEmpty()) {
                            Text("构建于 ${s.info.builtAt.take(16).replace('T', ' ')}", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Spacer(Modifier.height(8.dp))
                        Button(
                            onClick = {
                                scope.launch {
                                    state = UpdateState.Downloading(0, 0, 0)
                                    try {
                                        val file = Updater.download(context, s.info) { p, d, t ->
                                            state = UpdateState.Downloading(p, d, t)
                                        }
                                        state = UpdateState.Ready(file, s.info.versionName, s.info.versionCode)
                                    } catch (e: Throwable) {
                                        state = UpdateState.Failed(e.message ?: "下载失败")
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("下载并安装") }
                    }
                    is UpdateState.Downloading -> {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            if (s.total > 0) "下载中 ${s.percent}% · ${fmtBytes(s.done)} / ${fmtBytes(s.total)}" else "下载中…",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(6.dp))
                        LinearProgressIndicator(
                            progress = { if (s.total > 0) s.percent / 100f else 0f },
                            modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(50)),
                            color = accent,
                            trackColor = MaterialTheme.colorScheme.surfaceVariant,
                        )
                    }
                    is UpdateState.Ready -> {
                        Spacer(Modifier.height(6.dp))
                        Text("已下载 ${s.versionName} (${s.versionCode})，点击安装", fontSize = 12.sp, color = accent)
                        if (needPermission) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "系统需要先允许 mcca 安装应用（安装未知应用权限）。",
                                fontSize = 11.sp,
                                lineHeight = 16.sp,
                                color = Amber,
                            )
                        }
                        Spacer(Modifier.height(8.dp))
                        Button(
                            onClick = {
                                if (!Updater.canInstall(context)) {
                                    needPermission = true
                                    Updater.openInstallPermission(context)
                                } else {
                                    Updater.install(context, s.file)
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(if (Updater.canInstall(context)) "安装更新" else "去开启安装权限") }
                        TextButton(
                            onClick = { Updater.install(context, s.file) },
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp),
                        ) { Text("仍要尝试安装", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp) }
                    }
                    is UpdateState.Failed -> {
                        Spacer(Modifier.height(4.dp))
                        Text(s.message, color = Danger, fontSize = 12.sp, lineHeight = 17.sp)
                    }
                    UpdateState.Checking, UpdateState.Idle -> Unit
                }
                if (relay.isBlank()) {
                    Spacer(Modifier.height(4.dp))
                    Text("未配置中转地址，无法检查更新（更新包由中转下发）。", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            SectionCard("关于") {
                KeyValueRow("App", "mcca mobile ${Updater.currentVersion(LocalContext.current).second}")
                KeyValueRow("协议", "mobile-bridge v0.3.0")
                KeyValueRow("agent", "pi + dsh 双通道")
                Spacer(Modifier.height(4.dp))
                Text(
                    "桌面端「管理 → 手机接入 (bridge)」可查看运行状态；token 在 config/mobile.json。",
                    fontSize = 11.sp,
                    lineHeight = 16.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(80.dp))
        }
    }
}
