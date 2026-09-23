package com.mcca.mobile.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import com.mcca.mobile.data.Args
import com.google.gson.JsonObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/**
 * 连接枢纽：局域网直连 / 公网中转 自动切换。
 *
 * 局域网发现三条路，按可靠性排序：
 *  1. UDP 广播（桥 3472 端口应答）——换网段/换 IP 也能立刻找到，不依赖中转；
 *  2. 记住的地址（上次成功的）——冷启动直连；
 *  3. 中转 hello 里广播的地址——最后的兜底。
 * 探测是并行的、单条 1.2s 预算：一条不通不会拖慢整体，也不会"一次探不到就永远走中转"
 * （走中转时每 20s 重探一次，通了立刻切回）。
 */
object Hub {

    enum class Mode { NONE, LAN, RELAY }

    data class Desktop(
        val name: String = "",
        val version: String = "",
        val lanPort: Int = 0,
        val lanAddresses: List<String> = emptyList(),
    )

    data class Conn(
        val mode: Mode = Mode.NONE,
        val online: Boolean = false,
        val detail: String = "未连接",
        val since: Long = 0L,
        val desktop: Desktop? = null,
        val error: String = "",
    )

    val conn = MutableStateFlow(Conn())
    private val _events = MutableSharedFlow<JsonObject>(extraBufferCapacity = 512, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val events: SharedFlow<JsonObject> = _events

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** 学到可用的局域网地址时回调（App 侧落盘，下次冷启动直接直连）。 */
    var onLearnLan: ((String) -> Unit)? = null

    /** 连接成功时回写端点：冷启动先直连它（不走发现，快很多）。 */
    var onLearnEndpoint: ((String) -> Unit)? = null

    private var running = false
    private var ws: WebSocket? = null
    @Volatile private var socketOpen = false
    private var config = Args()
    private var appContext: Context? = null
    private var lastMessageAt = 0L
    private var seq = 0L
    private val pending = ConcurrentHashMap<String, kotlinx.coroutines.CompletableDeferred<JsonObject>>()
    @Volatile private var lanCandidates: List<String> = emptyList()
    @Volatile private var lanSwitchAt = 0L
    @Volatile private var learnedLan: String = ""
    @Volatile private var switchingToLan = false
    @Volatile private var lastDiscoveryAt = 0L
    @Volatile private var discovered: List<String> = emptyList()
    /** 局域网明确探不到时的静默期：这段时间直接用中转，不再每轮都白探 700ms */
    @Volatile private var lanDeadUntil = 0L

    fun start(context: Context, args: Args) {
        val modeChanged = args.connMode != config.connMode
        config = args
        appContext = context.applicationContext
        lanCandidates = listOfNotNull(
            args.lanHost.trim().takeIf { it.isNotEmpty() },
        )
        if (running) {
            if (modeChanged) ws?.cancel()
            return
        }
        running = true
        scope.launch { runLoop(context.applicationContext) }
    }

    fun update(args: Args) {
        val restart = args.lanHost != config.lanHost || args.relayHost != config.relayHost ||
            args.token != config.token || args.connMode != config.connMode
        config = args
        if (restart) {
            lanCandidates = listOfNotNull(args.lanHost.trim().takeIf { it.isNotEmpty() })
            ws?.cancel()
        }
    }

    fun stop() {
        running = false
        ws?.cancel()
        ws = null
        socketOpen = false
        setConn(Conn())
    }

    /** 立即重连（取消当前连接，由重连循环接管）。 */
    fun reconnect() {
        ws?.cancel()
    }

    /** 学习桌面 hello 广播的局域网地址，供下一次自动切换使用。 */
    private fun learnLan(hello: JsonObject) {
        val lan = Proto.obj(hello, "lan") ?: return
        val port = Proto.long(lan, "port", 3471).toInt()
        val addrs = Proto.arr(lan, "addresses")?.mapNotNull { it.takeIf { e -> e.isJsonPrimitive }?.asString } ?: return
        if (addrs.isEmpty()) return
        lanCandidates = (addrs.map { "$it:$port" } + lanCandidates).distinct()
    }

    /**
     * 正在走中转时，定期重探局域网：可达就断开当前连接让重连循环切过去。
     * 之前只在连上中转的那一刻试一次，探不到就一直挂在中转上。
     */
    private fun maybeSwitchToLan() {
        val ctx = appContext ?: return
        // 「仅中转」是用户显式选择：别再偷偷切走
        if (config.connMode == "relay") return
        if (conn.value.mode != Mode.RELAY || !conn.value.online) return
        val now = System.currentTimeMillis()
        if (now - lanSwitchAt < 20_000L) return
        lanSwitchAt = now
        scope.launch {
            if (!isOnLan(ctx)) return@launch
            if (probeLanFast(config) != null) {
                switchingToLan = true
                lanDeadUntil = 0L
                setConn(conn.value.copy(detail = "切换到局域网直连…"))
                ws?.cancel()
            }
        }
    }

    private fun setConn(next: Conn) {
        conn.value = next
    }

    private suspend fun runLoop(context: Context) {
        var backoff = 1500L
        while (running) {
            val args = config
            if (args.token.isBlank()) {
                setConn(Conn(detail = "未配置 token", error = "在「我的」里填入手机接入 token"))
                delay(4000)
                continue
            }
            val onWifi = isOnLan(context)
            // 候选：用户填的/记住的 + hello 学到的（UDP 发现结果随后台任务补充）
            val merged = if (args.lanHost.isBlank() && learnedLan.isNotBlank()) args.copy(lanHost = learnedLan) else args
            lanCandidates = (
                listOfNotNull(merged.lanHost.trim().takeIf { it.isNotEmpty() })
                    + discovered
                    + lanCandidates
                ).distinct()

            // ① 快速通道：上次成功的端点直接连，不等发现、不重复探测
            val fast = fastTarget(merged, onWifi)
            if (fast != null) {
                // auto 模式且记住的是中转端点：先花几十毫秒看一眼已知的局域网候选（在家立刻走直连）
                val quick = if (fast.first == Mode.RELAY && merged.connMode == "auto" && onWifi) {
                    probeLanFast(merged) ?: fast
                } else {
                    fast
                }
                android.util.Log.i("mcca-hub", "快速通道 -> ${quick.first} ${quick.second.substringBefore("?")}")
                val okFast = try {
                    connectOnce(quick.first, quick.second, merged, fast = true)
                } catch (t: Throwable) {
                    setConn(conn.value.copy(online = false, detail = "连接失败：${t.message ?: t.javaClass.simpleName}"))
                    false
                }
                if (okFast) {
                    backoff = 1500L
                    continue
                }
                // 记住的局域网端点连不上：进静默期，直接给中转让路
                if (quick.first == Mode.LAN) lanDeadUntil = System.currentTimeMillis() + 15_000L
            }

            // ② UDP 发现丢后台，别挡着连接
            val now = System.currentTimeMillis()
            if (onWifi && now - lastDiscoveryAt > 15_000) {
                lastDiscoveryAt = now
                scope.launch {
                    val found = LanDiscovery.discover(1200)
                    if (found.isNotEmpty()) {
                        discovered = found
                        lanCandidates = (found + lanCandidates).distinct()
                    }
                }
            }

            // ③ 按连接方式选目标：auto=局域网优先（只等 700ms，超时就上中转，别干等探测）
            val target: Pair<Mode, String>? = when (merged.connMode) {
                "lan" -> if (onWifi) probeLanFast(merged) else null
                "relay" -> relayTarget(merged)
                else -> {
                    val relay = relayTarget(merged)
                    when {
                        !onWifi -> relay
                        relay == null -> probeLanFast(merged)
                        System.currentTimeMillis() < lanDeadUntil -> relay
                        else -> {
                            // 探测放后台跑（学到的地址照样更新候选），前台只等 700ms
                            val lanJob = scope.async { probeLanFast(merged) }
                            val lan = withTimeoutOrNull(700) { lanJob.await() }
                            if (lan != null) {
                                lan
                            } else {
                                // 明确探不到（不是超时）→ 15s 内别再白探
                                if (lanJob.isCompleted && lanJob.getCompleted() == null) {
                                    lanDeadUntil = System.currentTimeMillis() + 15_000L
                                }
                                relay
                            }
                        }
                    }
                }
            }
            if (target == null) {
                setConn(
                    Conn(
                        detail = if (merged.connMode == "lan" && !onWifi) "仅局域网模式：当前不在局域网" else "没有可用的连接地址",
                        error = "在「我的」里检查中转地址/局域网地址",
                    ),
                )
                delay(4000)
                continue
            }
            val (mode, url) = target
            android.util.Log.i("mcca-hub", "连接 connMode=${merged.connMode} onWifi=$onWifi -> $mode ${url.substringBefore("?")}")
            val ok = try {
                connectOnce(mode, url, merged)
            } catch (t: Throwable) {
                setConn(conn.value.copy(online = false, detail = "连接失败：${t.message ?: t.javaClass.simpleName}", error = t.message ?: ""))
                false
            }
            if (running && !ok) {
                delay(backoff)
                backoff = (backoff * 1.7).toLong().coerceAtMost(20_000L)
            } else {
                backoff = 1500L
            }
        }
    }

    /**
     * 快速通道：把上次成功的 WS 端点拆回 (模式, url)。
     *  - LAN 端点（含 /ws）先做一次短探测，避免抱着过期 IP 干等；
     *  - 中转端点（含 /app）直接连。
     * 连接方式为「仅中转」时忽略 LAN 端点，反之亦然。
     */
    private suspend fun fastTarget(args: Args, onWifi: Boolean): Pair<Mode, String>? {
        val ep = args.lastEndpoint.trim()
        if (ep.isEmpty() || !(ep.startsWith("ws://") || ep.startsWith("wss://"))) return null
        val isLan = ep.contains("/ws?") || ep.endsWith("/ws") || ep.contains("/ws/")
        if (args.connMode == "relay" && isLan) return null
        if (args.connMode == "lan" && !isLan) return null
        // 局域网端点不在同网段时直接跳过（探都不用探）
        // 注意：这里不再做 HTTP 预探测——直接连 WS 更快，连不上就当快速通道失败
        if (isLan && !onWifi) return null
        return (if (isLan) Mode.LAN else Mode.RELAY) to ep
    }

    private fun relayTarget(args: Args): Pair<Mode, String>? {
        val host = args.relayHost.trim().trimEnd('/')
        if (host.isEmpty()) return null
        val base = when {
            host.startsWith("ws://") || host.startsWith("wss://") -> host
            host.startsWith("http://") -> host.replaceFirst("http://", "ws://")
            host.startsWith("https://") -> host.replaceFirst("https://", "wss://")
            host.endsWith(".apk") -> return null
            else -> "ws://$host"
        }
        return Mode.RELAY to "$base/app?token=${args.token}"
    }

    /** 并行探测所有候选，同网段的优先（避免先试到不可达的虚拟网卡地址），第一条通的即用。 */
    private suspend fun probeLanFast(args: Args): Pair<Mode, String>? = coroutineScope {
        val mine = localSubnets()
        val candidates = lanCandidates
            .distinct()
            .sortedByDescending { candidate -> mine.any { prefix -> candidate.startsWith("$prefix.") } }
            .take(6)
        if (candidates.isEmpty()) return@coroutineScope null
        val winner = kotlinx.coroutines.CompletableDeferred<String>()
        val done = AtomicBoolean(false)
        val jobs = candidates.map { candidate ->
            launch {
                if (done.get()) return@launch
                val host = normalizeHost(candidate)
                if (reachable(host, args.token)) {
                    if (done.compareAndSet(false, true)) {
                        learnedLan = candidate
                        onLearnLan?.invoke(candidate)
                        winner.complete(host)
                    }
                }
            }
        }
        val host = withTimeoutOrNull(3500) { winner.await() }
        if (host == null) {
            jobs.forEach { it.cancel() }
            null
        } else {
            Mode.LAN to "${host.toWs()}/ws?token=${args.token}"
        }
    }

    /** 本机各网卡的 /24 前缀（用于「同网段优先」判断）。 */
    private fun localSubnets(): List<String> = try {
        java.net.NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { nic -> nic.interfaceAddresses }
            .mapNotNull { addr -> addr.address?.hostAddress }
            .filter { ip -> ip.contains('.') }
            .map { ip -> ip.substringBeforeLast('.') }
            .distinct()
    } catch (_: Throwable) {
        emptyList()
    }

    private fun normalizeHost(raw: String): String {        val trimmed = raw.trim().trimEnd('/')
        return when {
            trimmed.startsWith("ws://") -> "http://" + trimmed.removePrefix("ws://")
            trimmed.startsWith("wss://") -> "https://" + trimmed.removePrefix("wss://")
            trimmed.startsWith("http://") || trimmed.startsWith("https://") -> trimmed
            else -> "http://$trimmed"
        }
    }

    private fun String.toWs(): String = when {
        startsWith("https://") -> replaceFirst("https://", "wss://")
        startsWith("http://") -> replaceFirst("http://", "ws://")
        else -> this
    }

    private fun reachable(host: String, token: String): Boolean {
        return try {
            val req = Request.Builder().url("$host/health").header("x-mcca-token", token).build()
            client.newBuilder()
                .connectTimeout(800, TimeUnit.MILLISECONDS)
                .readTimeout(800, TimeUnit.MILLISECONDS)
                .build()
                .newCall(req).execute().use { it.isSuccessful }
        } catch (_: Throwable) {
            false
        }
    }

    private suspend fun connectOnce(mode: Mode, url: String, args: Args, fast: Boolean = false): Boolean {
        setConn(Conn(mode = mode, online = false, detail = if (mode == Mode.LAN) "连接局域网直连…" else "连接中转…"))
        // 局域网直连的失败要"快失败"（IP 过期时别干等）；快速通道更短
        val socketClient = client.newBuilder()
            .connectTimeout(if (mode == Mode.LAN) (if (fast) 1000L else 1800L) else 6000L, TimeUnit.MILLISECONDS)
            .build()
        val opened = suspendCancellableCoroutine<Boolean> { cont ->
            val listener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    lastMessageAt = System.currentTimeMillis()
                    socketOpen = true
                    if (cont.isActive) cont.resume(true)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    lastMessageAt = System.currentTimeMillis()
                    handleFrame(text)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    socketOpen = false
                    if (cont.isActive) cont.resume(false)
                    if (ws === webSocket) {
                        ws = null
                        val switching = switchingToLan
                        switchingToLan = false
                        setConn(
                            conn.value.copy(
                                online = false,
                                detail = if (switching) "切换到局域网直连…" else "已断开（${t.message ?: "网络错误"}）",
                            ),
                        )
                    }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    socketOpen = false
                    if (cont.isActive) cont.resume(false)
                    if (ws === webSocket) {
                        ws = null
                        val switching = switchingToLan
                        switchingToLan = false
                        setConn(conn.value.copy(online = false, detail = if (switching) "切换到局域网直连…" else "已断开"))
                    }
                }
            }
            val socket = socketClient.newWebSocket(Request.Builder().url(url).build(), listener)
            ws = socket
            cont.invokeOnCancellation { socket.cancel() }
        }
        if (!opened) {
            ws = null
            return false
        }
        // 记住这次成功的端点：下次冷启动直接连它，跳过 UDP 发现（划掉重开也快）
        onLearnEndpoint?.invoke(url)
        if (mode == Mode.LAN) lanDeadUntil = 0L
        // WS 一通就算在线：hello 里的桌面信息慢（pi-web 聚合可能要几秒）不该拖住"已连接"的观感
        setConn(
            Conn(
                mode = mode,
                online = true,
                detail = if (mode == Mode.LAN) "局域网直连" else "公网中转",
                since = System.currentTimeMillis(),
                desktop = conn.value.desktop,
            ),
        )
        android.util.Log.i("mcca-hub", "已连接 $mode ${url.substringBefore("?")}")
        // 握手后拿桌面信息（hello 里带局域网广播地址），失败也继续，事件流仍可用
        val hello = try {
            withTimeout(6000) { call("hello", null) }
        } catch (_: Throwable) {
            null
        }
        val info = parseHello(hello)
        if (info != null) {
            learnLan(info.second)
            setConn(conn.value.copy(desktop = info.first))
        }
        if (mode == Mode.RELAY) maybeSwitchToLan()
        // 心跳 + 假死检测 + 走中转时定期重探局域网
        try {
            while (running && socketOpen) {
                // 500ms 粒度轮询：切连接方式/断开能立刻生效，不用等满 15s
                var waited = 0L
                while (running && socketOpen && waited < 15_000L) {
                    delay(500)
                    waited += 500
                }
                if (!running || !socketOpen) break
                val silent = System.currentTimeMillis() - lastMessageAt
                if (silent > 75_000) {
                    ws?.cancel()
                    break
                }
                ws?.send("""{"t":"ping","time":${System.currentTimeMillis()}}""")
                if (!socketOpen) break
                if (mode == Mode.RELAY) maybeSwitchToLan()
            }
        } catch (_: Throwable) {
            // 循环异常按断线处理
        }
        for (waiter in pending.values) waiter.cancel()
        pending.clear()
        setConn(conn.value.copy(online = false, detail = "已断开"))
        return false
    }

    private fun parseHello(json: JsonObject?): Pair<Desktop, JsonObject>? {
        if (json == null) return null
        val root = Proto.obj(json, "d") ?: json
        val name = Proto.str(root, "name")
        val version = Proto.str(root, "version")
        val lan = Proto.obj(root, "lan")
        val port = if (lan != null) Proto.long(lan, "port", 3471).toInt() else 3471
        val addrs = lan?.let { l ->
            Proto.arr(l, "addresses")?.mapNotNull { it.takeIf { e -> e.isJsonPrimitive }?.asString }
        } ?: emptyList()
        return Desktop(name, version, port, addrs) to root
    }

    private fun handleFrame(text: String) {
        val frame = try {
            Proto.parse(text) ?: return
        } catch (_: Throwable) {
            return
        }
        try {
            when (Proto.str(frame, "t")) {
                Proto.T_RES -> {
                    val id = Proto.str(frame, "id")
                    val waiter = pending.remove(id) ?: return
                    if (Proto.bool(frame, "ok", true)) waiter.complete(frame) else waiter.completeExceptionally(
                        RuntimeException(Proto.str(frame, "e", "请求失败")),
                    )
                }
                Proto.T_EVT -> {
                    val m = Proto.str(frame, "m")
                    val d = Proto.obj(frame, "d") ?: JsonObject()
                    if (m == "hello") {
                        val info = parseHello(Proto.obj("d" to d))
                        if (info != null) {
                            learnLan(info.second)
                            setConn(conn.value.copy(desktop = info.first))
                        }
                    }
                    _events.tryEmit(Proto.obj("m" to m, "d" to d))
                }
                "ping" -> ws?.send("""{"t":"pong"}""")
            }
        } catch (_: Throwable) {
            // 畸形帧忽略，连接继续
        }
    }

    /** 发一条请求并等待响应（默认 20s 超时）。 */
    suspend fun call(method: String, params: JsonObject? = null, timeoutMs: Long = 20_000): JsonObject {
        val socket = ws ?: throw IllegalStateException("未连接")
        val id = "m${++seq}"
        val frame = Proto.obj("t" to Proto.T_REQ, "id" to id, "m" to method, "p" to (params ?: JsonObject()))
        val deferred = kotlinx.coroutines.CompletableDeferred<JsonObject>()
        pending[id] = deferred
        socket.send(frame.toString())
        return try {
            withTimeoutOrNull(timeoutMs) { deferred.await() } ?: throw RuntimeException("$method 超时")
        } finally {
            pending.remove(id)
        }
    }

    private fun isOnLan(context: Context): Boolean {
        return try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val network = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(network) ?: return false
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ||
                (Build.VERSION.SDK_INT >= 33 && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
        } catch (_: Throwable) {
            true
        }
    }
}
