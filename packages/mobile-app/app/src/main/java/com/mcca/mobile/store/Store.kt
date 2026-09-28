package com.mcca.mobile.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import com.google.gson.JsonObject
import com.mcca.mobile.net.Hub
import com.mcca.mobile.net.Proto
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** 一张图的引用：内联 base64 / dsh 附件 id / pi 工作区文件路径，三者取其一。 */
class Img(
    val key: String,
    var mimeType: String = "image/png",
    var data: String = "",
    var attachmentId: String = "",
    var path: String = "",
    var name: String = "",
) {
    companion object {
        fun inline(mimeType: String, data: String, name: String = ""): Img =
            Img("inline:${data.take(64)}:${data.length}", mimeType, data = data, name = name)

        fun attachment(id: String, mimeType: String, name: String = ""): Img =
            Img("att:$id", mimeType, attachmentId = id, name = name)

        fun file(path: String, name: String = ""): Img = Img("path:$path", name = name, path = path)
    }
}

class Tool(val callId: String, var name: String = "tool") {
    var args by mutableStateOf("")
    var output by mutableStateOf("")
    var isError by mutableStateOf(false)
    var phase by mutableStateOf("start")
    /** subagent 类工具的 async runId：聊天页据此打开子代理转录 */
    var runId by mutableStateOf("")
    val images = mutableStateListOf<Img>()
}

class Msg(val id: String, val role: String) {
    var text by mutableStateOf("")
    var thinking by mutableStateOf("")
    var status by mutableStateOf("done")
    var at by mutableStateOf(0L)
    var turn by mutableStateOf(0)
    var durationMs by mutableStateOf(0L)
    var tokens by mutableStateOf(0)
    var tokPerSec by mutableStateOf(0.0)
    var error by mutableStateOf("")
    var expanded by mutableStateOf(false)
    var pending by mutableStateOf(false)
    val tools = mutableStateListOf<Tool>()
    val images = mutableStateListOf<Img>()

    /** 纯文本（图片单独渲染）：去掉 markdown 图片链接，避免显示成一串路径。 */
    val bodyText: String get() = MARKDOWN_IMAGE.replace(text, "").trim()

    /** 正文里引用的图片（![alt](path)）。 */
    val linkedImages: List<Img>
        get() = MARKDOWN_IMAGE.findAll(text).mapNotNull { m ->
            val path = m.groupValues.getOrNull(2)?.trim().orEmpty()
            if (path.isEmpty() || path.startsWith("http://") || path.startsWith("https://") || path.startsWith("data:")) null
            else Img.file(path, m.groupValues.getOrNull(1)?.trim().orEmpty())
        }.toList()

    companion object {
        val MARKDOWN_IMAGE = Regex("!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)")
    }
}

class Goal {
    var objective by mutableStateOf("")
    var phase by mutableStateOf("")
    var blockedReason by mutableStateOf("")
    var roundsStarted by mutableStateOf(0)
    var maxGoalRounds by mutableStateOf(0)
}

class Session(val id: String) {
    var agent by mutableStateOf("pi")
    var title by mutableStateOf("新会话")
    var cwd by mutableStateOf("")
    var updatedAt by mutableStateOf(0L)
    var running by mutableStateOf(false)
    var status by mutableStateOf("idle")
    var turn by mutableStateOf(0)
    var turnStartedAt by mutableStateOf(0L)
    var queue by mutableStateOf(0)
    var lastRole by mutableStateOf("")
    var lastText by mutableStateOf("")
    var lastStatus by mutableStateOf("")
    var modelProvider by mutableStateOf("")
    var modelId by mutableStateOf("")
    var thinkingLevel by mutableStateOf("")
    var unread by mutableStateOf(0)
    var loaded by mutableStateOf(false)
    var hasMore by mutableStateOf(false)
    var goal by mutableStateOf<Goal?>(null)

    val key: String get() = "$agent:$id"
    val agentLabel: String get() = if (agent == "dsh") "dsh" else "pi"
}

class Task(
    val id: String,
    val kind: String,
    val sessionId: String,
    val agent: String,
    var runId: String = "",
) {
    var title by mutableStateOf("")
    var detail by mutableStateOf("")
    var status by mutableStateOf("working")
    var statusText by mutableStateOf("")
    var startedAt by mutableStateOf(0L)
    var endedAt by mutableStateOf(0L)
    var updatedAt by mutableStateOf(0L)
    var result by mutableStateOf("")
    var error by mutableStateOf("")
    var parentTitle by mutableStateOf("")
    var queue by mutableStateOf(0)
    var model by mutableStateOf("")
    var thinking by mutableStateOf("")
}

class Notice(
    val id: String,
    var title: String,
    var body: String,
    var at: Long,
    var sessionId: String = "",
    var kind: String = "",
    var read: Boolean = false,
) {
    val numericId: Long get() = id.filter { it.isDigit() }.toLongOrNull() ?: 0L

    /**
     * 是否上「事件板」：portal 里人工推的（kind=manual）才上板；
     * 宿主自动播报（kind=auto）只弹系统通知。旧版 portal 不带 kind，按上板处理。
     */
    val isBoard: Boolean get() = kind == "manual" || kind.isEmpty()
}

class Agent(val name: String) {
    var label by mutableStateOf("")
    var port by mutableStateOf(0)
    var running by mutableStateOf(false)
    var pid by mutableStateOf(0)
    var startedAt by mutableStateOf(0L)
    var lastExitAt by mutableStateOf(0L)
    var busy by mutableStateOf(false)
}

class Host {
    var online by mutableStateOf(false)
    var error by mutableStateOf("")
    var cpuApp by mutableStateOf(0.0)
    var cpuTotal by mutableStateOf(0.0)
    var memApp by mutableStateOf(0L)
    var memUsed by mutableStateOf(0L)
    var memTotal by mutableStateOf(1L)
    var procCount by mutableStateOf(0)
    var piOnline by mutableStateOf(false)
    var dshOnline by mutableStateOf(false)
    val agents = mutableStateListOf<Agent>()
}

class ModelRef(val id: String, val name: String)

class ModelGroup(val provider: String, val label: String) {
    val models = mutableStateListOf<ModelRef>()
    val efforts = mutableStateMapOf<String, String>() // 模型 id → 该模型支持的思考强度标签（逗号分隔）
    val defaultEffort = mutableStateMapOf<String, String>()
}

/**
 * 全局状态：双 agent（pi / dsh）的会话、消息、任务、通知、桌面进程。
 * 事件从 Hub 进来，按桥的补丁协议增量更新（Compose 细粒度状态，流式更新不整表刷新）。
 */
object Store {

    val sessions = mutableStateListOf<Session>()
    val messages = mutableStateMapOf<String, SnapshotStateList<Msg>>() // key = "agent:id"
    val tasks = mutableStateListOf<Task>()
    val notices = mutableStateListOf<Notice>()
    val host = Host()
    val currentKey = mutableStateOf("")
    val currentSessionId = mutableStateOf("")
    val tasksLoading = mutableStateOf(false)
    val models = mutableStateListOf<ModelGroup>()
    val thinkingLevels = mutableStateListOf<Pair<String, String>>()
    val workspaces = mutableStateListOf<String>()
    val lastError = mutableStateOf("")
    /** 子代理转录：按任务 id 缓存（点开子代理卡片时拉一次，只读） */
    val transcripts = mutableStateMapOf<String, SnapshotStateList<Msg>>()
    /** 会话消息被整段刷新（缓存→服务端、手动刷新）的信号：聊天页据此重新贴底 */
    val refreshTick = mutableStateMapOf<String, Int>()
    val transcriptLoading = mutableStateMapOf<String, Boolean>()
    val transcriptError = mutableStateMapOf<String, String>()
    val transcriptMeta = mutableStateMapOf<String, String>()
    /** 转录对应的 run 元信息（从聊天页进来时也能显示状态/模型/结果） */
    val transcriptRuns = mutableStateMapOf<String, Task>()
    val agentFilter = mutableStateOf("all") // all | pi | dsh
    /** 事件板水位（与 portal 端 localStorage 同语义，清空/已读都持久化） */
    val boardClearedUpTo = mutableStateOf(0L)
    val boardSeenUpTo = mutableStateOf(0L)
    var onBoardCursor: ((cleared: Long, seen: Long) -> Unit)? = null
    /** 右滑删除落盘。参数是逗号分隔的 id。 */
    var onBoardDismiss: ((String) -> Unit)? = null
    private val dismissedBoard = HashSet<Long>()
    private var dismissedGen by mutableStateOf(0)
    var onNotice: ((Notice) -> Unit)? = null
    private var noticeSeq = 0L
    private var scope: CoroutineScope? = null
    private var appContext: android.content.Context? = null
    private val dirtySessions = mutableSetOf<String>()
    private var sessionsDirty = false
    private var flushJob: kotlinx.coroutines.Job? = null

    /** 启动时先读本地快照（会话列表 + 上次看过的消息），随后由网络刷新覆盖。 */
    fun init(context: android.content.Context) {
        appContext = context.applicationContext
        runCatching {
            val raw = com.mcca.mobile.data.Cache.loadSessions(context) ?: return@runCatching
            val json = Proto.parse(raw) ?: return@runCatching
            applySessions(json, "")
        }
        startFlushLoop()
    }

    private fun startFlushLoop() {
        val s = scope ?: return
        if (flushJob != null) return
        flushJob = s.launch(Dispatchers.IO) {
            var ticks = 0
            while (true) {
                kotlinx.coroutines.delay(3000)
                flushDirty()
                ticks += 1
                // 每 15 秒补一次头像漏（首轮失败/新会话/弱网），列表很快补齐
                if (ticks % 5 == 0) {
                    withMain {
                        com.mcca.mobile.data.Avatars.prefetch(
                            s,
                            sessions.map { Triple(it.agent, it.id, "") },
                        )
                    }
                }
            }
        }
    }

    private fun flushDirty() {
        val ctx = appContext ?: return
        if (sessionsDirty) {
            sessionsDirty = false
            com.mcca.mobile.data.Cache.saveSessions(ctx, sessionsToJson().toString())
        }
        val keys = synchronized(dirtySessions) {
            val copy = dirtySessions.toList()
            dirtySessions.clear()
            copy
        }
        for (key in keys) {
            val list = messages[key] ?: continue
            com.mcca.mobile.data.Cache.saveMessages(ctx, key, messagesToJson(list).toString())
        }
    }

    private fun sessionsToJson(): com.google.gson.JsonObject {
        val root = com.google.gson.JsonObject()
        val arr = com.google.gson.JsonArray()
        for (s in sessions) {
            val o = com.google.gson.JsonObject()
            o.addProperty("agent", s.agent)
            o.addProperty("id", s.id)
            o.addProperty("title", s.title)
            o.addProperty("cwd", s.cwd)
            o.addProperty("updatedAt", s.updatedAt)
            o.addProperty("running", s.running)
            o.addProperty("status", s.status)
            o.addProperty("turn", s.turn)
            o.addProperty("turnStartedAt", s.turnStartedAt)
            o.addProperty("queue", s.queue)
            o.addProperty("lastRole", s.lastRole)
            o.addProperty("lastText", s.lastText)
            o.addProperty("lastStatus", s.lastStatus)
            if (s.modelId.isNotEmpty()) {
                val m = com.google.gson.JsonObject()
                m.addProperty("provider", s.modelProvider)
                m.addProperty("modelId", s.modelId)
                o.add("model", m)
            }
            s.goal?.let { g ->
                val go = com.google.gson.JsonObject()
                go.addProperty("objective", g.objective)
                go.addProperty("phase", g.phase)
                go.addProperty("blockedReason", g.blockedReason)
                go.addProperty("roundsStarted", g.roundsStarted)
                go.addProperty("maxGoalRounds", g.maxGoalRounds)
                o.add("goal", go)
            }
            arr.add(o)
        }
        root.add("sessions", arr)
        return root
    }

    private fun messagesToJson(list: Collection<Msg>): com.google.gson.JsonObject {
        val root = com.google.gson.JsonObject()
        val arr = com.google.gson.JsonArray()
        val tail = list.toList().takeLast(com.mcca.mobile.data.Cache.messagesLimit())
        for (m in tail) {
            val o = com.google.gson.JsonObject()
            o.addProperty("id", m.id)
            o.addProperty("role", m.role)
            o.addProperty("text", m.text)
            o.addProperty("thinking", m.thinking)
            o.addProperty("status", m.status)
            o.addProperty("at", m.at)
            o.addProperty("turn", m.turn)
            o.addProperty("durationMs", m.durationMs)
            o.addProperty("tokens", m.tokens)
            o.addProperty("pending", m.pending)
            if (m.error.isNotEmpty()) o.addProperty("error", m.error)
            if (m.tools.isNotEmpty()) {
                val tools = com.google.gson.JsonArray()
                for (t in m.tools) {
                    val to = com.google.gson.JsonObject()
                    to.addProperty("callId", t.callId)
                    to.addProperty("name", t.name)
                    to.addProperty("args", t.args.take(4000))
                    to.addProperty("output", t.output.take(4000))
                    to.addProperty("isError", t.isError)
                    to.addProperty("phase", t.phase)
                    if (t.runId.isNotEmpty()) to.addProperty("runId", t.runId)
                    tools.add(to)
                }
                o.add("tools", tools)
            }
            // 内联图片的 base64 会让缓存膨胀：快照里只留引用（attachmentId/path），
            // 下次拉服务端历史时再补回来
            val imgs = m.images.filter { it.attachmentId.isNotEmpty() || it.path.isNotEmpty() }
            if (imgs.isNotEmpty()) {
                val ia = com.google.gson.JsonArray()
                for (i in imgs) {
                    val io = com.google.gson.JsonObject()
                    io.addProperty("mimeType", i.mimeType)
                    if (i.attachmentId.isNotEmpty()) io.addProperty("attachmentId", i.attachmentId)
                    if (i.path.isNotEmpty()) io.addProperty("path", i.path)
                    if (i.name.isNotEmpty()) io.addProperty("name", i.name)
                    ia.add(io)
                }
                o.add("images", ia)
            }
            arr.add(o)
        }
        root.add("messages", arr)
        return root
    }

    fun attach(scope: CoroutineScope) {
        if (this.scope != null) return
        this.scope = scope
        startFlushLoop()
        scope.launch {
            Hub.events.collect { evt ->
                try {
                    when (Proto.str(evt, "m")) {
                        "sessions" -> applySessions(Proto.obj(evt, "d"), Proto.str(Proto.obj(evt, "d") ?: JsonObject(), "agent"))
                        "patch" -> applyPatch(Proto.obj(evt, "d"))
                        "notify" -> applyNotice(Proto.obj(Proto.obj(evt, "d"), "item"))
                        "host" -> applyHost(Proto.obj(evt, "d"))
                        "hello" -> applyHello(Proto.obj(evt, "d"))
                        "desktop" -> Unit
                    }
                } catch (t: Throwable) {
                    lastError.value = "事件处理失败：${t.message}"
                }
            }
        }
    }

    fun session(agent: String, id: String): Session? = sessions.firstOrNull { it.agent == agent && it.id == id }
    fun sessionByKey(key: String): Session? = sessions.firstOrNull { it.key == key }
    fun messagesOf(session: Session): SnapshotStateList<Msg> = messages.getOrPut(session.key) { mutableStateListOf() }
    fun messagesOf(key: String): SnapshotStateList<Msg> = messages.getOrPut(key) { mutableStateListOf() }

    /** 当前过滤器下可见的会话。 */
    fun visibleSessions(): List<Session> = when (agentFilter.value) {
        "pi" -> sessions.filter { it.agent == "pi" }
        "dsh" -> sessions.filter { it.agent == "dsh" }
        else -> sessions.toList()
    }

    // ── 事件应用 ────────────────────────────────────────────────────

    private fun applySessions(d: JsonObject?, agentHint: String) {
        val list = Proto.arr(d, "sessions") ?: return
        val agent = Proto.str(d, "agent").ifEmpty { agentHint }
        val seen = HashSet<String>()
        for (el in list) {
            val o = el.takeIf { it.isJsonObject }?.asJsonObject ?: continue
            val id = Proto.str(o, "id")
            if (id.isEmpty()) continue
            val itemAgent = Proto.str(o, "agent").ifEmpty { if (agent.isNotEmpty()) agent else "pi" }
            seen.add("$itemAgent:$id")
            val s = sessions.firstOrNull { it.agent == itemAgent && it.id == id }
                ?: Session(id).also { it.agent = itemAgent; sessions.add(it) }
            s.agent = itemAgent
            s.title = Proto.str(o, "title", "新会话")
            s.cwd = Proto.str(o, "cwd")
            s.updatedAt = Proto.long(o, "updatedAt")
            s.running = Proto.bool(o, "running")
            s.status = Proto.str(o, "status", if (s.running) "processing" else "idle")
            s.turn = Proto.long(o, "turn").toInt()
            s.turnStartedAt = Proto.long(o, "turnStartedAt")
            s.queue = Proto.long(o, "queue").toInt()
            val lastText = Proto.str(o, "lastText")
            if (lastText.isNotEmpty() || s.lastText.isEmpty()) {
                s.lastRole = Proto.str(o, "lastRole")
                s.lastText = lastText
                s.lastStatus = Proto.str(o, "lastStatus")
            }
            val model = Proto.obj(o, "model")
            if (model != null) {
                s.modelProvider = Proto.str(model, "provider")
                s.modelId = Proto.str(model, "modelId")
            }
            val goal = Proto.obj(o, "goal")
            s.goal = if (goal != null && Proto.str(goal, "objective").isNotEmpty()) {
                (s.goal ?: Goal()).also {
                    it.objective = Proto.str(goal, "objective")
                    it.phase = Proto.str(goal, "phase")
                    it.blockedReason = Proto.str(goal, "blockedReason")
                    it.roundsStarted = Proto.long(goal, "roundsStarted").toInt()
                    it.maxGoalRounds = Proto.long(goal, "maxGoalRounds").toInt()
                }
            } else null
        }
        // 只清理这次事件覆盖的那个 agent（另一个 agent 的列表保持不动）
        if (agent.isNotEmpty()) {
            val gone = sessions.filter { it.agent == agent && it.key !in seen }
            for (g in gone) {
                sessions.remove(g)
                messages.remove(g.key)
            }
        }
        sessions.sortByDescending { it.updatedAt }
        sessionsDirty = true
        scope?.let { s ->
            com.mcca.mobile.data.Avatars.prefetch(s, sessions.map { Triple(it.agent, it.id, "") })
        }
    }

    private fun applyPatch(d: JsonObject?) {
        val sessionId = Proto.str(d, "sessionId")
        if (sessionId.isEmpty()) return
        val agent = Proto.str(d, "agent", "pi")
        val patches = Proto.arr(d, "patches") ?: return
        val key = "$agent:$sessionId"
        val list = messagesOf(key)
        for (el in patches) {
            val p = el.takeIf { it.isJsonObject }?.asJsonObject ?: continue
            when (Proto.str(p, "t")) {
                "reset" -> {
                    list.clear()
                    Proto.arr(p, "messages")?.forEach { m ->
                        m.takeIf { it.isJsonObject }?.asJsonObject?.let { list.add(toMsg(it)) }
                    }
                    session(agent, sessionId)?.let { it.loaded = true; it.unread = 0 }
                }
                "msg" -> {
                    val incoming = Proto.obj(p, "msg") ?: continue
                    val role = Proto.str(incoming, "role")
                    val text = Proto.str(incoming, "text")
                    // 服务端回显的用户消息：认领本地那条 pending 气泡，避免同一句话出现两条
                    if (role == "user") {
                        val pendingIdx = list.indexOfFirst { it.role == "user" && it.pending && it.text == text }
                        if (pendingIdx >= 0) {
                            list[pendingIdx].pending = false
                            session(agent, sessionId)?.let { it.lastText = text; it.lastRole = "user" }
                            continue
                        }
                    }
                    val id = Proto.str(incoming, "id")
                    val idx = list.indexOfFirst { it.id == id }
                    if (idx >= 0) mergeMsg(list[idx], incoming) else {
                        list.add(toMsg(incoming))
                        bumpUnread(agent, sessionId, incoming)
                    }
                }
                "delta" -> {
                    val id = Proto.str(p, "msgId")
                    val msg = list.firstOrNull { it.id == id } ?: continue
                    val field = Proto.str(p, "field", "text")
                    val text = Proto.str(p, "text")
                    if (field == "thinking") msg.thinking += text else msg.text += text
                    msg.status = "streaming"
                    // 列表只显示一行预览。正文变长但首行可见部分不变时不要写 lastText，
                    // 否则会话列表在流式期间每个 token 都重测那一行。
                    session(agent, sessionId)?.let { s ->
                        s.lastRole = "agent"
                        s.lastStatus = "streaming"
                        if (msg.text.isEmpty()) {
                            if (s.lastText.isNotEmpty()) s.lastText = ""
                        } else {
                            val preview = previewLine(msg.text)
                            if (s.lastText != preview) s.lastText = preview
                        }
                    }
                }
                "session" -> Proto.obj(p, "session")?.let { applySessionMeta(agent, sessionId, it) }
            }
        }
        synchronized(dirtySessions) { dirtySessions.add(key) }
    }

    private fun applySessionMeta(agent: String, sessionId: String, o: JsonObject) {
        val s = session(agent, sessionId) ?: return
        Proto.str(o, "title").takeIf { it.isNotEmpty() }?.let { s.title = it }
        Proto.str(o, "cwd").takeIf { it.isNotEmpty() }?.let { s.cwd = it }
        s.running = Proto.bool(o, "running", s.running)
        Proto.str(o, "status").takeIf { it.isNotEmpty() }?.let { s.status = it }
        s.turn = Proto.long(o, "turn", s.turn.toLong()).toInt()
        s.turnStartedAt = Proto.long(o, "turnStartedAt")
        Proto.arr(o, "queue")?.let { s.queue = it.size() }
        val model = Proto.obj(o, "model")
        if (model != null) {
            s.modelProvider = Proto.str(model, "provider")
            s.modelId = Proto.str(model, "modelId")
        }
        Proto.str(o, "thinkingLevel").takeIf { it.isNotEmpty() }?.let { s.thinkingLevel = it }
        val goal = Proto.obj(o, "goal")
        s.goal = if (goal != null && Proto.str(goal, "objective").isNotEmpty()) {
            (s.goal ?: Goal()).also {
                it.objective = Proto.str(goal, "objective")
                it.phase = Proto.str(goal, "phase")
                it.blockedReason = Proto.str(goal, "blockedReason")
                it.roundsStarted = Proto.long(goal, "roundsStarted").toInt()
                it.maxGoalRounds = Proto.long(goal, "maxGoalRounds").toInt()
            }
        } else if (Proto.bool(o, "goalCleared")) null else s.goal
    }

    /** 会话列表一行装得下的预览。多了的字符会被省略号挡住，不必再触发重组。 */
    private fun previewLine(text: String): String {
        var i = 0
        val n = text.length
        while (i < n) {
            val c = text[i]
            if (c != ' ' && c != '\n' && c != '\r' && c != '\t') break
            i++
        }
        val start = i
        var count = 0
        while (i < n && text[i] != '\n' && count < 32) {
            i++
            count++
        }
        return text.substring(start, i)
    }

    private fun bumpUnread(agent: String, sessionId: String, incoming: JsonObject) {
        if ("$agent:$sessionId" == currentKey.value) return
        val role = Proto.str(incoming, "role")
        if (role != "agent") return
        session(agent, sessionId)?.let { it.unread += 1 }
    }

    private fun toMsg(o: JsonObject): Msg {
        val msg = Msg(Proto.str(o, "id"), Proto.str(o, "role", "agent"))
        mergeMsg(msg, o)
        return msg
    }

    private fun mergeMsg(msg: Msg, o: JsonObject) {
        Proto.str(o, "text").takeIf { it.isNotEmpty() }?.let { msg.text = it }
        Proto.str(o, "thinking").takeIf { it.isNotEmpty() }?.let { msg.thinking = it }
        Proto.str(o, "status").takeIf { it.isNotEmpty() }?.let { msg.status = it }
        Proto.long(o, "at").takeIf { it > 0 }?.let { msg.at = it }
        Proto.long(o, "durationMs").takeIf { it > 0 }?.let { msg.durationMs = it }
        Proto.long(o, "tokens").takeIf { it > 0 }?.let { msg.tokens = it.toInt() }
        Proto.str(o, "error").takeIf { it.isNotEmpty() }?.let { msg.error = it }
        if (o.has("pending")) msg.pending = Proto.bool(o, "pending")
        Proto.arr(o, "tools")?.let { arr ->
            msg.tools.clear()
            for (t in arr) {
                val to = t.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                val tool = Tool(Proto.str(to, "callId", "c${msg.tools.size}"), Proto.str(to, "name", "tool"))
                tool.args = Proto.str(to, "args")
                tool.output = Proto.str(to, "output")
                tool.isError = Proto.bool(to, "isError")
                tool.phase = Proto.str(to, "phase", "end")
                tool.runId = Proto.str(to, "runId")
                parseImages(to).forEach { tool.images.add(it) }
                msg.tools.add(tool)
            }
        }
        val images = parseImages(o)
        if (images.isNotEmpty()) {
            msg.images.clear()
            images.forEach { msg.images.add(it) }
        }
    }

    private fun parseImages(o: JsonObject?): List<Img> {
        val arr = Proto.arr(o, "images") ?: return emptyList()
        val out = mutableListOf<Img>()
        for (el in arr) {
            val io = el.takeIf { it.isJsonObject }?.asJsonObject ?: continue
            val mime = Proto.str(io, "mimeType", "image/png")
            val data = Proto.str(io, "data")
            val att = Proto.str(io, "attachmentId")
            val path = Proto.str(io, "path")
            val name = Proto.str(io, "name")
            when {
                data.isNotEmpty() -> out.add(Img.inline(mime, data, name))
                att.isNotEmpty() -> out.add(Img.attachment(att, mime, name))
                path.isNotEmpty() -> out.add(Img.file(path, name))
            }
        }
        return out
    }

    private fun applyNotice(item: JsonObject?) {
        if (item == null) return
        val id = Proto.str(item, "id", "n${++noticeSeq}")
        val source = Proto.str(item, "source")
        val rawKind = Proto.str(item, "kind")
        // portal 新版显式给 manual/auto；旧版不带 kind，只有 source=portal → 当人工条目
        val kind = rawKind.ifEmpty { if (source == "portal") "" else source }
        val notice = Notice(
            id,
            Proto.str(item, "title", "mcca"),
            Proto.str(item, "body"),
            Proto.long(item, "at", System.currentTimeMillis()),
            Proto.str(item, "sessionId"),
            kind,
        )
        notices.add(0, notice)
        if (notices.size > 200) notices.subList(160, notices.size).clear()
        onNotice?.invoke(notice)
    }

    private fun applyHost(d: JsonObject?) {
        if (d == null) return
        host.online = Proto.bool(d, "online")
        if (!host.online) {
            host.error = Proto.str(d, "error")
            for (a in host.agents) a.running = false
            return
        }
        host.error = ""
        Proto.arr(d, "agents")?.let { arr ->
            for (el in arr) {
                val o = el.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                val name = Proto.str(o, "agent")
                val a = host.agents.firstOrNull { it.name == name } ?: Agent(name).also { host.agents.add(it) }
                a.label = Proto.str(o, "label", name)
                a.port = Proto.long(o, "port").toInt()
                a.running = Proto.bool(o, "running")
                a.pid = Proto.long(o, "pid").toInt()
                a.startedAt = Proto.long(o, "startedAt")
                val exit = Proto.obj(o, "lastExit")
                a.lastExitAt = if (exit != null) Proto.long(exit, "at") else 0L
            }
        }
        Proto.obj(d, "resources")?.let { r ->
            host.cpuApp = Proto.long(r, "cpuApp").toDouble() / 100.0
            host.cpuTotal = Proto.long(r, "cpuTotal").toDouble() / 100.0
            host.memApp = Proto.long(r, "memApp")
            host.memUsed = Proto.long(r, "memUsed")
            host.memTotal = Proto.long(r, "memTotal", 1L).coerceAtLeast(1L)
            host.procCount = Proto.long(r, "procCount").toInt()
        }
    }

    private fun applyHello(hello: JsonObject?) {
        if (hello == null) return
        host.piOnline = Proto.bool(Proto.obj(hello, "pi"), "online")
        host.dshOnline = Proto.bool(Proto.obj(hello, "dsh"), "online")
    }

    // ── 操作 ────────────────────────────────────────────────────────

    private fun io(block: suspend () -> Unit) {
        scope?.launch(Dispatchers.IO) { block() }
    }

    fun refreshSessions() = io {
        try {
            Hub.call("sessions.list")
        } catch (t: Throwable) {
            withMain { lastError.value = t.message ?: "刷新失败" }
        }
    }

    fun openSession(session: Session, force: Boolean = false) {
        currentKey.value = session.key
        currentSessionId.value = session.id
        session.unread = 0
        val list = messagesOf(session)
        // 每次都从服务端拉一份最新：缓存先垫着所以不黑屏，拉取很快（本地几十 ms）。
        // 之前 loaded=true 就直接 return，离开会话期间的更新永远补不上——看起来就是"消息没同步"。
        io {
            try {
                // 先用本地快照秒开（升级/重启后不用等网络），再拉服务端最新
                val ctx0 = appContext
                if (ctx0 != null && list.isEmpty()) {
                    runCatching {
                        val raw = com.mcca.mobile.data.Cache.loadMessages(ctx0, session.key) ?: return@runCatching
                        val json = Proto.parse(raw) ?: return@runCatching
                        val cached = mutableListOf<JsonObject>()
                        Proto.arr(json, "messages")?.forEach { m ->
                            m.takeIf { it.isJsonObject }?.asJsonObject?.let { cached.add(it) }
                        }
                        if (cached.isNotEmpty()) withMain { list.addAll(cached.map { toMsg(it) }) }
                    }
                }
                val res = Hub.call(
                    "sessions.open",
                    Proto.obj("agent" to session.agent, "id" to session.id),
                    60_000,
                )
                val d = Proto.obj(res, "d") ?: return@io
                val raw = mutableListOf<JsonObject>()
                Proto.arr(d, "messages")?.forEach { m ->
                    m.takeIf { it.isJsonObject }?.asJsonObject?.let { raw.add(it) }
                }
                val meta = Proto.obj(d, "session")
                val hasMore = Proto.bool(d, "hasMore")
                withMain {
                    list.clear()
                    list.addAll(raw.map { toMsg(it) })
                    meta?.let { applySessionMeta(session.agent, session.id, it) }
                    session.loaded = true
                    session.hasMore = hasMore
                    // 通知聊天页：这段是整段替换，重新贴底（否则停在旧位置，看着像没同步）
                    refreshTick[session.key] = (refreshTick[session.key] ?: 0) + 1
                }
                // 兜底：还没加载到消息但会话在跑，稍后再取一次（dsh 冷会话首帧延迟）
                if (raw.isEmpty() && session.running) {
                    kotlinx.coroutines.delay(2500)
                    if (list.isEmpty()) {
                        val again = runCatching {
                            Hub.call("sessions.open", Proto.obj("agent" to session.agent, "id" to session.id), 60_000)
                        }.getOrNull()
                        val d2 = Proto.obj(again, "d")
                        val raw2 = mutableListOf<JsonObject>()
                        Proto.arr(d2, "messages")?.forEach { m ->
                            m.takeIf { it.isJsonObject }?.asJsonObject?.let { raw2.add(it) }
                        }
                        withMain { if (raw2.isNotEmpty()) { list.clear(); list.addAll(raw2.map { toMsg(it) }) } }
                    }
                }
            } catch (t: Throwable) {
                withMain { lastError.value = t.message ?: "打开会话失败" }
            }
        }
    }

    fun closeSession(session: Session) {
        if (currentKey.value == session.key) {
            currentKey.value = ""
            currentSessionId.value = ""
        }
        synchronized(dirtySessions) { dirtySessions.add(session.key) }
        val ctx = appContext
        val list = messages[session.key]
        if (ctx != null && list != null) {
            io { com.mcca.mobile.data.Cache.saveMessages(ctx, session.key, messagesToJson(list).toString()) }
        }
        io { runCatching { Hub.call("sessions.close", Proto.obj("agent" to session.agent, "id" to session.id)) } }
    }

    fun send(text: String, images: List<Img>, onDone: (Boolean, String?) -> Unit) {
        val key = currentKey.value
        val session = sessionByKey(key) ?: return
        val local = Msg("local-${System.currentTimeMillis()}", "user")
        local.text = text
        local.at = System.currentTimeMillis()
        local.pending = true
        for (img in images) local.images.add(img)
        val list = messagesOf(session)
        // send 由 UI 线程调用，直接改状态即可
        list.add(local)
        session.lastText = text
        session.lastRole = "user"
        io {
            try {
                val params = JsonObject().apply {
                    addProperty("agent", session.agent)
                    addProperty("id", session.id)
                    addProperty("text", text)
                    if (images.isNotEmpty()) {
                        add(
                            "images",
                            Proto.any(
                                images.filter { it.data.isNotEmpty() }.map {
                                    mapOf("mimeType" to it.mimeType, "data" to it.data, "name" to it.name)
                                },
                            ),
                        )
                    }
                }
                val res = Hub.call("sessions.send", params, 60_000)
                val d = Proto.obj(res, "d")
                val ok = d == null || Proto.bool(d, "ok", true)
                val mode = if (d != null) Proto.str(d, "mode") else ""
                withMain {
                    local.pending = ok
                    onDone(ok, if (!ok) Proto.str(d, "error", "发送失败") else if (mode == "queued") "已排队" else null)
                }
            } catch (t: Throwable) {
                withMain { local.pending = false; onDone(false, t.message) }
            }
        }
    }

    fun stopSession(session: Session) = io {
        runCatching { Hub.call("sessions.stop", Proto.obj("agent" to session.agent, "id" to session.id)) }
    }

    fun newSession(agent: String, onCreated: (Session) -> Unit) = io {
        try {
            val res = Hub.call("sessions.create", Proto.obj("agent" to agent), 60_000)
            val d = Proto.obj(res, "d")
            val ok = d == null || Proto.bool(d, "ok", true)
            val id = if (d != null) Proto.str(d, "id") else ""
            if (ok && id.isNotEmpty()) {
                refreshSessions()
                withMain {
                    val s = sessions.firstOrNull { it.agent == agent && it.id == id }
                        ?: Session(id).also { it.agent = agent; sessions.add(0, it) }
                    onCreated(s)
                }
            } else {
                withMain { lastError.value = if (d != null) Proto.str(d, "error", "新建失败") else "新建失败" }
            }
        } catch (t: Throwable) {
            withMain { lastError.value = t.message ?: "新建失败" }
        }
    }

    fun deleteSession(session: Session, onDone: (Boolean) -> Unit) = io {
        val res = runCatching {
            Hub.call("sessions.delete", Proto.obj("agent" to session.agent, "id" to session.id))
        }
        withMain {
            val d = res.getOrNull()?.let { Proto.obj(it, "d") }
            val ok = res.isSuccess && (d == null || Proto.bool(d, "ok", true))
            val err = if (d != null) Proto.str(d, "error") else res.exceptionOrNull()?.message ?: ""
            if (ok) {
                sessions.remove(session)
                messages.remove(session.key)
                if (currentKey.value == session.key) {
                    currentKey.value = ""
                    currentSessionId.value = ""
                }
            } else if (err.isNotEmpty()) {
                lastError.value = err
            }
            onDone(ok)
        }
    }

    fun renameSession(session: Session, title: String) = io {
        runCatching { Hub.call("sessions.rename", Proto.obj("agent" to session.agent, "id" to session.id, "title" to title)) }
        refreshSessions()
    }

    fun setModel(session: Session, provider: String, modelId: String, level: String = "") = io {
        val params = JsonObject().apply {
            addProperty("agent", session.agent)
            addProperty("id", session.id)
            addProperty("provider", provider)
            addProperty("modelId", modelId)
            if (level.isNotEmpty()) addProperty("level", level)
        }
        runCatching { Hub.call("sessions.setModel", params) }
        withMain {
            session.modelProvider = provider
            session.modelId = modelId
            if (level.isNotEmpty()) session.thinkingLevel = level
        }
    }

    fun setThinking(session: Session, level: String) = io {
        runCatching { Hub.call("sessions.setThinking", Proto.obj("agent" to session.agent, "id" to session.id, "level" to level)) }
        withMain { session.thinkingLevel = level }
    }

    fun loadModels(session: Session) = io {
        runCatching {
            val res = Hub.call("sessions.models", Proto.obj("agent" to session.agent, "id" to session.id), 30_000)
            val d = Proto.obj(res, "d") ?: return@runCatching
            val groupsRaw = mutableListOf<JsonObject>()
            Proto.arr(d, "groups")?.forEach { g ->
                g.takeIf { it.isJsonObject }?.asJsonObject?.let { groupsRaw.add(it) }
            }
            val levelsRaw = mutableListOf<Pair<String, String>>()
            Proto.arr(d, "levels")?.forEach { l ->
                if (l.isJsonArray && l.asJsonArray.size() >= 1) {
                    val id = l.asJsonArray.get(0).let { if (it.isJsonPrimitive) it.asString else "" }
                    val label = if (l.asJsonArray.size() >= 2 && l.asJsonArray.get(1).isJsonPrimitive) l.asJsonArray.get(1).asString else id
                    if (id.isNotEmpty()) levelsRaw.add(id to label)
                }
            }
            withMain {
                models.clear()
                for (o in groupsRaw) {
                    val provider = Proto.str(o, "id").ifEmpty { Proto.str(o, "name") }
                    val label = Proto.str(o, "name").ifEmpty { provider }
                    val group = ModelGroup(provider, label)
                    Proto.arr(o, "models")?.forEach { m ->
                        if (m.isJsonPrimitive) group.models.add(ModelRef(m.asString, m.asString))
                        else if (m.isJsonObject) {
                            val mo = m.asJsonObject
                            val id = Proto.str(mo, "id")
                            if (id.isEmpty()) return@forEach
                            group.models.add(ModelRef(id, Proto.str(mo, "name").ifEmpty { id }))
                            val efforts = Proto.arr(mo, "efforts")
                            if (efforts != null) {
                                val labels = mutableListOf<String>()
                                for (e in efforts) {
                                    val eo = e.takeIf { it.isJsonObject }?.asJsonObject
                                    if (eo != null) {
                                        labels.add(
                                            Proto.str(eo, "name", Proto.str(eo, "id")).ifEmpty { Proto.str(eo, "id") },
                                        )
                                        group.efforts["$id:${Proto.str(eo, "id")}"] = Proto.str(eo, "name", Proto.str(eo, "id"))
                                    } else if (e.isJsonPrimitive) {
                                        labels.add(e.asString)
                                        group.efforts["$id:${e.asString}"] = e.asString
                                    }
                                }
                            }
                        }
                    }
                    if (group.models.isNotEmpty()) models.add(group)
                }
                thinkingLevels.clear()
                for ((id, label) in levelsRaw) thinkingLevels.add(id to label)
            }
        }
    }

    fun effortOptions(modelId: String): List<Pair<String, String>> {
        val out = mutableListOf<Pair<String, String>>()
        for (g in models) {
            for (m in g.models) {
                if (m.id != modelId) continue
                for ((k, label) in g.efforts) {
                    val id = k.substringAfter(":")
                    if (k.startsWith("$modelId:")) out.add(id to label)
                }
            }
        }
        return out
    }

    fun saveGoal(session: Session, action: String, objective: String = "", maxRounds: Int = 0) = io {
        val params = JsonObject().apply {
            addProperty("agent", session.agent)
            addProperty("id", session.id)
            addProperty("action", action)
            if (objective.isNotEmpty()) addProperty("objective", objective)
            if (maxRounds > 0) addProperty("maxRounds", maxRounds)
        }
        runCatching { Hub.call("goal.action", params) }
        refreshSessions()
    }

    fun refreshTasks() {
        tasksLoading.value = true
        io {
            try {
                val res = Hub.call("tasks.list", timeoutMs = 25_000)
                val d = Proto.obj(res, "d")
                val raws = mutableListOf<JsonObject>()
                Proto.arr(d, "tasks")?.forEach { el ->
                    el.takeIf { it.isJsonObject }?.asJsonObject?.let { raws.add(it) }
                }
                withMain {
                    val incoming = raws.map { o ->
                        val t = Task(
                            Proto.str(o, "id"),
                            Proto.str(o, "kind"),
                            Proto.str(o, "sessionId"),
                            Proto.str(o, "agent", "pi"),
                            Proto.str(o, "runId"),
                        )
                        t.title = Proto.str(o, "title")
                        t.detail = Proto.str(o, "detail")
                        t.status = Proto.str(o, "status", "working")
                        t.statusText = Proto.str(o, "statusText")
                        t.startedAt = Proto.long(o, "startedAt")
                        t.endedAt = Proto.long(o, "endedAt")
                        t.updatedAt = Proto.long(o, "updatedAt")
                        t.result = Proto.str(o, "result")
                        t.error = Proto.str(o, "error")
                        t.parentTitle = Proto.str(o, "parentTitle")
                        t.queue = Proto.long(o, "queue").toInt()
                        t.model = Proto.str(o, "model")
                        t.thinking = Proto.str(o, "thinking")
                        t
                    }
                    val byId = tasks.associateBy { it.id }
                    tasks.clear()
                    for (t in incoming) {
                        byId[t.id]?.let { old ->
                            t.title = t.title.ifEmpty { old.title }
                            t.parentTitle = t.parentTitle.ifEmpty { old.parentTitle }
                            t.detail = t.detail.ifEmpty { old.detail }
                        }
                        tasks.add(t)
                    }
                    tasksLoading.value = false
                }
            } catch (t: Throwable) {
                withMain { tasksLoading.value = false; lastError.value = t.message ?: "任务刷新失败" }
            }
        }
    }

    fun stopSubagent(t: Task) = io {
        runCatching { Hub.call("tasks.stopSubagent", Proto.obj("sessionId" to t.sessionId, "runId" to t.runId)) }
        refreshTasks()
    }

    /** 打开子代理转录（只读对话）；同一 run 已有缓存就直接用。 */
    fun openTranscript(task: Task, force: Boolean = false) {
        val key = task.id
        if (!force && transcripts.containsKey(key) && transcripts[key]?.isNotEmpty() == true) return
        transcriptLoading[key] = true
        transcriptError.remove(key)
        io {
            try {
                val res = Hub.call(
                    "tasks.transcript",
                    Proto.obj("sessionId" to task.sessionId, "runId" to task.runId),
                    45_000,
                )
                val d = Proto.obj(res, "d")
                val raw = mutableListOf<JsonObject>()
                Proto.arr(d, "messages")?.forEach { m ->
                    m.takeIf { it.isJsonObject }?.asJsonObject?.let { raw.add(it) }
                }
                val name = Proto.str(d, "name")
                val runJson = Proto.obj(d, "run")
                val info = if (runJson != null) {
                    val t = Task(task.id, "subagent", task.sessionId, task.agent, task.runId)
                    t.title = Proto.str(runJson, "agent", name).ifEmpty { task.title }
                    t.detail = Proto.str(runJson, "task").ifEmpty { task.detail }
                    t.status = Proto.str(runJson, "status", task.status)
                    t.model = Proto.str(runJson, "model")
                    t.thinking = Proto.str(runJson, "thinking")
                    t.result = Proto.str(runJson, "result")
                    t.error = Proto.str(runJson, "error")
                    t.startedAt = Proto.long(runJson, "startedAt", task.startedAt)
                    t.endedAt = Proto.long(runJson, "endedAt", task.endedAt)
                    t.parentTitle = task.parentTitle
                    t.runId = task.runId
                    t
                } else {
                    task
                }
                withMain {
                    val list = transcripts.getOrPut(key) { mutableStateListOf() }
                    list.clear()
                    list.addAll(raw.map { toMsg(it) })
                    transcriptMeta[key] = name
                    transcriptRuns[key] = info
                    transcriptLoading[key] = false
                }
            } catch (t: Throwable) {
                withMain {
                    transcriptLoading[key] = false
                    transcriptError[key] = t.message ?: "转录读取失败"
                }
            }
        }
    }

    fun refreshHost() = io {
        runCatching { Hub.call("host.status") }.onFailure { t ->
            withMain { host.online = false; host.error = t.message ?: "" }
        }
    }

    fun hostAction(agent: String, action: String) {
        host.agents.firstOrNull { it.name == agent }?.busy = true
        io {
            try {
                Hub.call("host.action", Proto.obj("agent" to agent, "action" to action), 60_000)
            } catch (t: Throwable) {
                withMain { lastError.value = t.message ?: "操作失败" }
            }
            refreshHost()
            withMain { host.agents.firstOrNull { it.name == agent }?.busy = false }
        }
    }

    /**
     * 通知拉取游标。portal 侧 id 单调递增，所以默认按游标增量取 —— 原来每次
     * `since=0` 全量重传 + 整表重建，事件板每 5s 刷一次全是白刷。
     * portal 重启后序号归零，用 `latest < 游标` 判定，退回一次全量。
     */
    private var noticeCursor = 0L

    fun loadNotices(full: Boolean = false) = io {
        runCatching {
            val since = if (full) 0L else noticeCursor
            val res = Hub.call("notify.list", Proto.obj("since" to since))
            val d = Proto.obj(res, "d") ?: return@runCatching
            val items = Proto.arr(d, "items") ?: return@runCatching
            val latest = Proto.long(d, "latest")
            withMain {
                val rewound = since > 0L && latest < noticeCursor
                if (since == 0L || rewound) notices.clear()
                val seen = notices.mapTo(HashSet()) { it.id }
                for (el in items) {
                    val o = el.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                    val id = Proto.str(o, "id", "p${o.hashCode()}")
                    if (id in seen) continue
                    notices.add(
                        0,
                        Notice(
                            id,
                            Proto.str(o, "title", "mcca"),
                            Proto.str(o, "body"),
                            Proto.long(o, "at"),
                            // kind 丢了的话任务播报会被当成人工条目上板（原来只取前 4 个字段）
                            Proto.str(o, "sessionId"),
                            Proto.str(o, "kind"),
                        ),
                    )
                }
                noticeCursor = if (since == 0L || rewound) latest else maxOf(noticeCursor, latest)
            }
        }
    }

    fun markAllRead() {
        for (n in notices) n.read = true
        for (s in sessions) s.unread = 0
    }

    // ── 事件板 ─────────────────────────────────────────────────────

    /** 上板的条目（人工推的），按 id 倒序；水位以下、以及右滑删掉的，都不显示。 */
    fun boardNotices(): List<Notice> {
        dismissedGen
        return notices.filter { it.isBoard && it.numericId > boardClearedUpTo.value && it.numericId !in dismissedBoard }
            .sortedByDescending { it.numericId }
    }

    fun syncDismissed(raw: String) {
        if (raw.isBlank()) return
        var changed = false
        for (part in raw.split(',')) {
            val id = part.toLongOrNull() ?: continue
            if (dismissedBoard.add(id)) changed = true
        }
        if (changed) dismissedGen += 1
    }

    private fun dismissedCsv(): String {
        val ids = dismissedBoard.toList()
        val tail = if (ids.size > 300) ids.takeLast(300) else ids
        return tail.joinToString(",")
    }

    /** 右滑删除：先从板上拿掉，再让 portal 把归档也删掉，刷新不会回来。 */
    fun dismissBoard(notice: Notice) {
        val id = notice.numericId
        if (id > 0 && dismissedBoard.add(id)) dismissedGen += 1
        notices.removeAll { it.id == notice.id || (id > 0 && it.numericId == id) }
        onBoardDismiss?.invoke(dismissedCsv())
        if (id <= 0) return
        io {
            runCatching { Hub.call("notify.delete", Proto.obj("id" to id)) }
                .onFailure { t -> withMain { lastError.value = t.message ?: "删除失败" } }
        }
    }

    /** 自动通知（任务完成/失败、agent 错误），只弹系统通知不上板。 */
    fun autoNotices(): List<Notice> = notices.filter { !it.isBoard }

    fun boardUnread(): Int = boardNotices().count { it.numericId > boardSeenUpTo.value }

    fun clearBoard() {
        val newest = boardNotices().maxOfOrNull { it.numericId } ?: 0L
        boardClearedUpTo.value = maxOf(boardClearedUpTo.value, newest, notices.maxOfOrNull { it.numericId } ?: 0L)
        boardSeenUpTo.value = maxOf(boardSeenUpTo.value, boardClearedUpTo.value)
        onBoardCursor?.invoke(boardClearedUpTo.value, boardSeenUpTo.value)
    }

    fun markBoardSeen() {
        val newest = boardNotices().maxOfOrNull { it.numericId } ?: 0L
        boardSeenUpTo.value = maxOf(boardSeenUpTo.value, newest)
        onBoardCursor?.invoke(boardClearedUpTo.value, boardSeenUpTo.value)
    }

    fun syncBoardCursor(cleared: Long, seen: Long) {
        boardClearedUpTo.value = maxOf(boardClearedUpTo.value, cleared)
        boardSeenUpTo.value = maxOf(boardSeenUpTo.value, seen)
    }

    fun markSessionRead(session: Session) {
        session.unread = 0
    }

    private suspend fun withMain(block: () -> Unit) {
        kotlinx.coroutines.withContext(Dispatchers.Main) { block() }
    }
}
