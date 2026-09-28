package com.mcca.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mcca.mobile.net.Proto
import com.mcca.mobile.store.Img
import com.mcca.mobile.store.Msg
import com.mcca.mobile.store.Session
import com.mcca.mobile.store.Store
import com.mcca.mobile.store.Task
import com.mcca.mobile.store.Tool
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** 用户消息是一块暖灰圆角，不是彩色聊天气泡。 */
@Composable
private fun userBubble(): Pair<Color, Color> {
    return MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurface
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(session: Session, onBack: () -> Unit, onDeleted: () -> Unit, onOpenSubagent: (Task) -> Unit = {}) {
    val messages = Store.messagesOf(session)
    val listState = remember(session.key) { androidx.compose.foundation.lazy.LazyListState() }
    val draft = rememberImageDraft()
    val pickActions = rememberImagePickActions(draft) { }
    var input by remember { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var showPicker by remember { mutableStateOf(false) }
    var renameOpen by remember { mutableStateOf(false) }
    var deleteOpen by remember { mutableStateOf(false) }
    var goalOpen by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf("") }
    var viewer by remember { mutableStateOf<Pair<List<Img>, Int>?>(null) }

    val scope = rememberCoroutineScope()
    val refresh = Store.refreshTick[session.key] ?: 0
    // 贴底才跟流。往上翻历史时不要被每个 token 拽回去。
    var stickToBottom by remember(session.key) { mutableStateOf(true) }
    var settling by remember(session.key) { mutableStateOf(false) }
    val followScroll = remember(session.key) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && available.y > 0.5f) {
                    val info = listState.layoutInfo
                    val top = info.visibleItemsInfo.firstOrNull()
                    val canLeaveBottom = top != null && (top.index > 0 || top.offset < info.viewportStartOffset)
                    if (canLeaveBottom) stickToBottom = false
                }
                return Offset.Zero
            }
        }
    }

    LaunchedEffect(session.key) { Store.openSession(session) }
    DisposableEffect(session.key) {
        onDispose { Store.closeSession(session) }
    }
    // 打开 / 整段刷新：重新贴底。不在组合里读正文长度，否则每个 token 都重组整页。
    LaunchedEffect(session.key, refresh) { stickToBottom = true }
    LaunchedEffect(session.key) {
        snapshotFlow {
            Triple(listState.endOverflow(), stickToBottom, listState.isScrollInProgress)
        }.collect { (overflow, stick, scrolling) ->
            if (settling || scrolling) return@collect
            if (!stick) {
                // 松手后几乎贴着底边才重新跟上，拖动过程中不抢
                if (overflow in 0..16) stickToBottom = true
                return@collect
            }
            when {
                overflow == Int.MIN_VALUE -> listState.revealEnd()
                overflow > 2 -> listState.scroll { scrollBy(overflow.toFloat()) }
            }
        }
    }
    val atBottom by remember {
        derivedStateOf {
            val overflow = listState.endOverflow()
            overflow != Int.MIN_VALUE && overflow <= 48
        }
    }
    LaunchedEffect(toast) {
        if (toast.isNotEmpty()) {
            delay(2400)
            toast = ""
        }
    }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(Icons.Default.ArrowBack, "返回", modifier = Modifier.size(20.dp))
                        }
                    },
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            SessionAvatar(session.title, session.key, 32.dp, session.agent)
                            Spacer(Modifier.width(10.dp))
                            Column {
                                Text(
                                    session.title,
                                    fontWeight = FontWeight.SemiBold,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    fontSize = 16.sp,
                                )
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Box(
                                        Modifier
                                            .size(5.dp)
                                            .clip(CircleShape)
                                            .background(if (session.running) Amber else MaterialTheme.colorScheme.outline),
                                    )
                                    Spacer(Modifier.width(5.dp))
                                    Text(
                                        buildString {
                                            append(session.agentLabel)
                                            if (session.modelId.isNotEmpty()) append(" · ${session.modelId}")
                                            if (session.running) append(" · 任务中")
                                        },
                                        fontSize = 11.sp,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                    )
                                }
                            }
                        }
                    },
                    actions = {
                        IconButton(onClick = { menu = true }) {
                            Icon(
                                Icons.Default.MoreVert,
                                "菜单",
                                modifier = Modifier.size(20.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text("刷新消息") },
                                onClick = { menu = false; Store.openSession(session, force = true) },
                            )
                            DropdownMenuItem(
                                text = { Text("模型与思考强度") },
                                onClick = { menu = false; Store.loadModels(session); showPicker = true },
                            )
                            if (session.agent == "dsh") {
                                DropdownMenuItem(
                                    text = { Text(if (session.goal == null) "新建目标（goal）" else "目标操作") },
                                    onClick = { menu = false; goalOpen = true },
                                )
                            }
                            DropdownMenuItem(text = { Text("重命名") }, onClick = { menu = false; renameOpen = true })
                            DropdownMenuItem(
                                text = { Text("停止任务", color = if (session.running) Danger else MaterialTheme.colorScheme.onSurfaceVariant) },
                                enabled = session.running,
                                onClick = { menu = false; Store.stopSession(session) },
                            )
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        if (session.agent == "dsh") "dsh 会话不支持删除" else "删除会话",
                                        color = if (session.agent == "dsh") MaterialTheme.colorScheme.onSurfaceVariant else Danger,
                                    )
                                },
                                enabled = session.agent != "dsh",
                                onClick = { menu = false; deleteOpen = true },
                            )
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                )
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
            session.goal?.let { goal ->
                GoalCard(
                    objective = goal.objective,
                    phase = goal.phase,
                    blockedReason = goal.blockedReason,
                    rounds = goal.roundsStarted,
                    maxRounds = goal.maxGoalRounds,
                    onPause = { Store.saveGoal(session, "pause") },
                    onResume = { Store.saveGoal(session, "resume") },
                    onComplete = { Store.saveGoal(session, "complete") },
                )
            }
            TaskStrip(
                running = session.running,
                startedAt = session.turnStartedAt,
                queue = session.queue,
                onStop = { Store.stopSession(session) },
            )
            Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize().nestedScroll(followScroll),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(top = 8.dp, bottom = 10.dp),
                ) {
                    itemsIndexed(messages, key = { _, msg -> msg.id }, contentType = { _, msg -> msg.role }) { index, msg ->
                        val prevAt = if (index > 0) messages[index - 1].at else 0L
                        if (msg.at > 0 && (prevAt == 0L || msg.at - prevAt > 15 * 60_000L)) {
                            TimeSeparator(msg.at)
                        }
                        MessageItem(session, msg, { images, i -> viewer = images to i }, onOpenSubagent)
                    }
                }
                if (!atBottom && messages.isNotEmpty()) {
                    Row(
                        Modifier
                            .align(Alignment.BottomEnd)
                            .padding(end = 14.dp, bottom = 10.dp)
                            .clip(RoundedCornerShape(50))
                            .background(MaterialTheme.colorScheme.surfaceVariant)
                            .clickable {
                                settling = true
                                stickToBottom = true
                                scope.launch {
                                    try {
                                        listState.revealEnd(animated = true)
                                    } finally {
                                        settling = false
                                    }
                                }
                            }
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            Icons.Default.KeyboardArrowDown,
                            contentDescription = "回到最新",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(15.dp),
                        )
                        Spacer(Modifier.width(4.dp))
                        Text("回到最新", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            if (toast.isNotEmpty()) {
                Text(
                    toast,
                    color = accent,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
                )
            }
            Composer(
                session = session,
                draft = draft,
                input = input,
                onInput = { input = it },
                onPick = pickActions.pickFromGallery,
                onCamera = pickActions.takePhoto,
                onSend = {
                    val text = input.trim()
                    if (text.isEmpty() && draft.images.isEmpty()) return@Composer
                    val pics = draft.images.toList()
                    input = ""
                    draft.clear()
                    Store.send(text, pics) { ok, note ->
                        if (!ok) toast = note ?: "发送失败" else if (note != null) toast = note
                    }
                },
                onStop = { Store.stopSession(session) },
            )
        }
    }

    viewer?.let { (images, index) ->
        // 看图时按返回先关查看器，而不是退回列表
        BackHandler(enabled = true) { viewer = null }
        ImageViewer(
            agent = session.agent,
            sessionId = session.id,
            images = images,
            startIndex = index,
            onClose = { viewer = null },
            onToast = { toast = it },
        )
    }

    if (renameOpen) {
        var text by remember { mutableStateOf(session.title) }
        AlertDialog(
            onDismissRequest = { renameOpen = false },
            title = { Text("重命名会话") },
            text = { OutlinedTextField(value = text, onValueChange = { text = it }, singleLine = true) },
            confirmButton = {
                TextButton(onClick = {
                    if (text.isNotBlank()) Store.renameSession(session, text.trim())
                    renameOpen = false
                }) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { renameOpen = false }) { Text("取消") } },
        )
    }
    if (deleteOpen) {
        AlertDialog(
            onDismissRequest = { deleteOpen = false },
            title = { Text("删除会话") },
            text = { Text("删除后不可恢复。") },
            confirmButton = {
                TextButton(onClick = {
                    deleteOpen = false
                    Store.deleteSession(session) { ok -> if (ok) onDeleted() }
                }) { Text("删除", color = Danger) }
            },
            dismissButton = { TextButton(onClick = { deleteOpen = false }) { Text("取消") } },
        )
    }
    if (goalOpen) {
        var objective by remember { mutableStateOf(session.goal?.objective ?: "") }
        var rounds by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { goalOpen = false },
            title = { Text(if (session.goal == null) "新建目标" else "目标") },
            text = {
                Column {
                    if (session.goal != null) {
                        Text(session.goal!!.objective, fontSize = 13.sp)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "阶段：${session.goal!!.phase} · ${session.goal!!.roundsStarted} 轮",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(10.dp))
                        Row {
                            if (session.goal!!.phase == "paused") {
                                TextButton(onClick = { Store.saveGoal(session, "resume"); goalOpen = false }) { Text("继续", color = accent) }
                            } else {
                                TextButton(onClick = { Store.saveGoal(session, "pause"); goalOpen = false }) { Text("暂停", color = Amber) }
                            }
                            TextButton(onClick = { Store.saveGoal(session, "complete"); goalOpen = false }) { Text("标记完成", color = accent) }
                            TextButton(onClick = { Store.saveGoal(session, "clear"); goalOpen = false }) { Text("清除", color = Danger) }
                        }
                    } else {
                        OutlinedTextField(
                            value = objective,
                            onValueChange = { objective = it },
                            label = { Text("目标描述") },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = rounds,
                            onValueChange = { rounds = it.filter { ch -> ch.isDigit() } },
                            label = { Text("最大轮数（可空）") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(12.dp))
                        TextButton(onClick = {
                            if (objective.isNotBlank()) Store.saveGoal(session, "create", objective.trim(), rounds.toIntOrNull() ?: 0)
                            goalOpen = false
                        }) { Text("创建目标", color = accent) }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { goalOpen = false }) { Text("关闭") } },
        )
    }
    if (showPicker) ModelPickerDialog(session = session, onClose = { showPicker = false })
}

@Composable
private fun TimeSeparator(at: Long) {
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), horizontalArrangement = Arrangement.Center) {
        Text(
            clockText(at),
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                .padding(horizontal = 8.dp, vertical = 2.dp),
        )
    }
}

@Composable
private fun GoalCard(
    objective: String,
    phase: String,
    blockedReason: String,
    rounds: Int,
    maxRounds: Int,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onComplete: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, hairline, RoundedCornerShape(16.dp))
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("目标", color = Violet, fontSize = 11.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.width(6.dp))
            StatusPill(phase, Violet)
            Spacer(Modifier.weight(1f))
            if (rounds > 0) {
                Text(
                    "$rounds${if (maxRounds > 0) " / $maxRounds" else ""} 轮",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(objective, fontSize = 13.sp, lineHeight = 19.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
        if (blockedReason.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Text("受阻：$blockedReason", color = Danger, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Row(Modifier.padding(top = 2.dp)) {
            if (phase == "paused") {
                TextButton(onClick = onResume, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 6.dp)) {
                    Text("继续", color = accent, fontSize = 12.sp)
                }
            } else {
                TextButton(onClick = onPause, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 6.dp)) {
                    Text("暂停", color = Amber, fontSize = 12.sp)
                }
            }
            TextButton(onClick = onComplete, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 6.dp)) {
                Text("完成", color = accent, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun TaskStrip(running: Boolean, startedAt: Long, queue: Int, onStop: () -> Unit) {
    if (!running && queue == 0) return
    var tick by remember { mutableStateOf(0L) }
    whilePolling(running) {
        while (running) {
            tick = System.currentTimeMillis()
            delay(1000)
        }
    }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surface)
            .padding(start = 12.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RunDot(active = running, size = 7.dp)
        Spacer(Modifier.width(8.dp))
        val elapsed = if (startedAt > 0) fmtDuration(tick - startedAt) else ""
        Text(
            when {
                running && queue > 0 -> "任务中 $elapsed · ${queue} 条排队"
                running -> "任务中 $elapsed"
                queue > 0 -> "${queue} 条排队"
                else -> "任务已停止"
            },
            fontSize = 12.sp,
            color = if (running) Amber else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
        if (running) {
            TextButton(onClick = onStop) { Text("停止", color = Danger, fontSize = 12.sp) }
        }
    }
}

@Composable
private fun MessageItem(
    session: Session,
    msg: Msg,
    onOpenImages: (List<Img>, Int) -> Unit,
    onOpenSubagent: (Task) -> Unit = {},
) {
    // 气泡宽度跟屏幕走：agent 侧留一点左边距就够，用户侧留出"对侧"的呼吸
    val widthDp = LocalConfiguration.current.screenWidthDp
    val maxBubble = (widthDp * if (msg.role == "user") 0.82f else 0.94f).dp
    when (msg.role) {
        "user" -> {
            val (bg, fg) = userBubble()
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.End,
            ) {
                Column(horizontalAlignment = Alignment.End) {
                    Box(
                        Modifier
                            .widthIn(max = maxBubble)
                            .clip(RoundedCornerShape(22.dp))
                            .background(bg)
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                    ) {
                        Column {
                            if (msg.images.isNotEmpty()) {
                                ImageGrid(session.agent, session.id, msg.images) { i -> onOpenImages(msg.images, i) }
                                if (msg.text.isNotEmpty()) Spacer(Modifier.height(6.dp))
                            }
                            if (msg.text.isNotEmpty()) Text(msg.text, fontSize = 16.sp, color = fg, lineHeight = 24.sp)
                        }
                    }
                    if (msg.pending) {
                        Spacer(Modifier.height(3.dp))
                        Text("发送中…", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        "system" -> Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.Center,
        ) {
            Text(
                msg.text,
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f))
                    .padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
        else -> Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp)) {
            Column(Modifier.fillMaxWidth()) {
                // 正文 / 思考各自读自己的状态：流式 token 不能把工具行和页脚一起拖着重排
                ThinkingRow(msg)
                AgentBody(session, msg, onOpenImages)
                if (msg.images.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    ImageGrid(session.agent, session.id, msg.images) { i -> onOpenImages(msg.images, i) }
                }
                if (msg.error.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text(msg.error, fontSize = 13.sp, color = Danger, lineHeight = 19.sp)
                }
                if (msg.tools.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    for ((i, tool) in msg.tools.withIndex()) {
                        if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(hairline))
                        ToolRow(session, tool, onOpenImages, onOpenSubagent)
                    }
                }
                MessageFooter(msg)
            }
        }
    }
}

@Composable
private fun AgentBody(session: Session, msg: Msg, onOpenImages: (List<Img>, Int) -> Unit) {
    val text = msg.text
    val streaming = msg.status == "streaming"
    val body = remember(text) { Msg.MARKDOWN_IMAGE.replace(text, "").trim() }
    val linked = remember(text) { msg.linkedImages }
    if (body.isNotEmpty()) MarkdownText(body, streaming = streaming)
    if (linked.isNotEmpty()) {
        Spacer(Modifier.height(8.dp))
        ImageGrid(session.agent, session.id, linked) { i -> onOpenImages(linked, i) }
    }
}

@Composable
private fun MessageFooter(msg: Msg) {
    val footer = buildString {
        if (msg.status == "streaming") append("生成中… ")
        if (msg.durationMs > 0) append("用时 ${fmtDuration(msg.durationMs)} ")
        if (msg.tokens > 0) append("${msg.tokens} tok ")
        if (msg.tokPerSec > 0) append(String.format(java.util.Locale.CHINA, "%.1f tok/s", msg.tokPerSec))
    }
    if (footer.isNotBlank() || msg.at > 0) {
        Spacer(Modifier.height(6.dp))
        Text(
            listOf(footer.trim(), if (msg.at > 0) clockText(msg.at) else "")
                .filter { it.isNotEmpty() }
                .joinToString(" · "),
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f),
        )
    }
}

@Composable
private fun ThinkingRow(msg: Msg) {
    val thinking = msg.thinking
    val streaming = msg.status == "streaming"
    val shown = rememberStreamingText(thinking, streaming && thinking.isNotEmpty())
    val scroll = rememberScrollState()
    if (thinking.isEmpty()) return
    // 思考往往很长，流式时只排最近一段，避免每拍都对整段做文本布局
    val visible = if (streaming && shown.length > 4000) shown.substring(shown.length - 4000) else shown
    Row(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable { msg.expanded = !msg.expanded }
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (msg.expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(15.dp),
        )
        Spacer(Modifier.width(3.dp))
        Text("思考过程", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (!msg.expanded && streaming) {
            Spacer(Modifier.width(6.dp))
            Text("思考中…", fontSize = 10.sp, color = Amber)
        }
    }
    if (msg.expanded) {
        Spacer(Modifier.height(6.dp))
        Text(
            visible,
            fontSize = 12.sp,
            lineHeight = 18.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 240.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f))
                .padding(10.dp)
                .verticalScroll(scroll),
        )
    }
    Spacer(Modifier.height(6.dp))
}

@Composable
private fun ToolRow(
    session: Session,
    tool: Tool,
    onOpenImages: (List<Img>, Int) -> Unit,
    onOpenSubagent: (Task) -> Unit = {},
) {
    var expanded by remember { mutableStateOf(false) }
    val dot = when {
        tool.isError -> Danger
        tool.phase == "start" -> Amber
        else -> accent
    }
    val isSubagent = tool.name.contains("subagent", ignoreCase = true)
    val subagentTask = remember(tool.runId, tool.args, tool.phase, tool.isError) {
        if (isSubagent && tool.runId.isNotEmpty()) subagentTaskOf(session, tool) else null
    }
    val label = if (isSubagent && subagentTask != null) {
        "子代理 ${subagentTask.title}" + if (subagentTask.detail.isNotEmpty()) " · ${subagentTask.detail.take(28)}" else ""
    } else {
        tool.name
    }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .clickable {
                    if (subagentTask != null) onOpenSubagent(subagentTask) else expanded = !expanded
                }
                .padding(vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(5.dp).clip(CircleShape).background(dot))
            Spacer(Modifier.width(7.dp))
            Text(
                label,
                fontSize = 11.sp,
                fontFamily = if (isSubagent) FontFamily.Default else FontFamily.Monospace,
                color = when {
                    tool.isError -> Danger
                    isSubagent -> Violet
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (tool.phase == "start") {
                Spacer(Modifier.width(6.dp))
                Text("执行中", fontSize = 10.sp, color = Amber)
            }
            Spacer(Modifier.weight(1f))
            if (subagentTask != null) {
                Text("查看子代理 ›", fontSize = 11.sp, color = Violet)
            } else {
                Icon(
                    if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                    modifier = Modifier
                        .size(20.dp)
                        .clickable { expanded = !expanded },
                )
            }
        }
        if (tool.images.isNotEmpty()) {
            Spacer(Modifier.height(4.dp))
            ImageGrid(session.agent, session.id, tool.images) { i -> onOpenImages(tool.images, i) }
        }
        if (expanded) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
                    .padding(10.dp),
            ) {
                if (tool.args.isNotEmpty()) {
                    Text(
                        tool.args,
                        fontSize = 10.sp,
                        lineHeight = 15.sp,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 14,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (tool.args.isNotEmpty() && tool.output.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Box(Modifier.fillMaxWidth().height(1.dp).background(hairline))
                    Spacer(Modifier.height(6.dp))
                }
                if (tool.output.isNotEmpty()) {
                    Text(
                        tool.output,
                        fontSize = 10.sp,
                        lineHeight = 15.sp,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 18,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(hairline))
    }
}

/** 从聊天里的 subagent 工具调用造一个 run 引用，点进子代理转录用。 */
private fun subagentTaskOf(session: Session, tool: Tool): Task {
    val args = Proto.parse(tool.args)
    val agent = args?.let { Proto.str(it, "agent") }.orEmpty()
    val taskText = args?.let { Proto.str(it, "task") }.orEmpty()
    val t = Task("run:${tool.runId}", "subagent", session.id, session.agent, tool.runId)
    t.title = agent.ifEmpty { "子代理" }
    t.detail = taskText
    t.status = when {
        tool.phase == "start" -> "working"
        tool.isError -> "failed"
        else -> "completed"
    }
    t.parentTitle = session.title
    return t
}

@Composable
private fun Composer(
    session: Session,
    draft: ImageDraft,
    input: String,
    onInput: (String) -> Unit,
    onPick: () -> Unit,
    onCamera: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)) {
        if (draft.images.isNotEmpty() || draft.busy) {
            Row(
                Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                draft.images.forEach { img ->
                    Box {
                        ImageThumb(session.agent, session.id, img, size = 60.dp)
                        Box(
                            Modifier
                                .align(Alignment.TopEnd)
                                .size(18.dp)
                                .clip(CircleShape)
                                .background(Color(0x99000000))
                                .clickable { draft.remove(img) },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.Default.Close, null, tint = Color.White, modifier = Modifier.size(11.dp))
                        }
                    }
                }
                if (draft.busy) {
                    Text("压缩中…", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        val field = MaterialTheme.colorScheme.surfaceVariant
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(field)
                .padding(start = 4.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            var attachOpen by remember { mutableStateOf(false) }
            Box(
                Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .clickable { attachOpen = true },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Default.Add,
                    "添加图片",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(22.dp),
                )
                DropdownMenu(expanded = attachOpen, onDismissRequest = { attachOpen = false }) {
                    DropdownMenuItem(text = { Text("拍照") }, onClick = { attachOpen = false; onCamera() })
                    DropdownMenuItem(text = { Text("从相册选择") }, onClick = { attachOpen = false; onPick() })
                }
            }
            BasicTextField(
                value = input,
                onValueChange = onInput,
                modifier = Modifier.weight(1f).heightIn(min = 40.dp, max = 140.dp).padding(bottom = 8.dp, top = 8.dp),
                textStyle = TextStyle(
                    color = MaterialTheme.colorScheme.onSurface,
                    fontSize = 16.sp,
                    lineHeight = 22.sp,
                ),
                cursorBrush = SolidColor(accent),
                maxLines = 6,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { onSend() }),
                decorationBox = { inner ->
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
                        if (input.isEmpty()) {
                            Text(
                                if (session.queue > 0) "发送将排队…" else "写一条消息",
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                                fontSize = 16.sp,
                            )
                        }
                        inner()
                    }
                },
            )
            Spacer(Modifier.width(6.dp))
            if (session.running) {
                Box(
                    Modifier
                        .padding(bottom = 2.dp)
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(Danger.copy(alpha = 0.14f))
                        .clickable(onClick = onStop),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Default.Close, "停止", tint = Danger, modifier = Modifier.size(18.dp))
                }
            } else {
                val enabled = input.isNotBlank() || draft.images.isNotEmpty()
                Box(
                    Modifier
                        .padding(bottom = 2.dp)
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(if (enabled) accent else MaterialTheme.colorScheme.outline.copy(alpha = 0.45f))
                        .clickable(enabled = enabled, onClick = onSend),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Default.KeyboardArrowUp,
                        "发送",
                        tint = if (enabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ModelPickerDialog(session: Session, onClose: () -> Unit) {
    var thinking by remember(session.thinkingLevel) { mutableStateOf(session.thinkingLevel) }
    val efforts = remember(session.modelId, Store.models.size) { Store.effortOptions(session.modelId) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("模型与思考强度") },
        text = {
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
                if (Store.models.isEmpty()) {
                    Text("模型目录为空（对应 agent 离线或未配置服务商）", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                for (group in Store.models) {
                    Text(
                        group.label,
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 10.dp, bottom = 4.dp),
                    )
                    for (model in group.models) {
                        val selected = session.modelProvider == group.provider && session.modelId == model.id
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .background(if (selected) accent.copy(alpha = 0.10f) else Color.Transparent)
                                .clickable {
                                    Store.setModel(session, group.provider, model.id, thinking)
                                    onClose()
                                }
                                .padding(vertical = 8.dp, horizontal = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                model.name,
                                fontSize = 14.sp,
                                color = if (selected) accent else MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.weight(1f),
                            )
                            if (selected) Icon(Icons.Default.Check, null, tint = accent, modifier = Modifier.size(16.dp))
                        }
                    }
                }
                val levels = if (efforts.isNotEmpty()) efforts else Store.thinkingLevels
                if (levels.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
                    HorizontalDivider(color = hairline)
                    Spacer(Modifier.height(10.dp))
                    Text("思考强度", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                        for ((levelId, levelLabel) in levels) {
                            val selected = thinking == levelId
                            Text(
                                levelLabel,
                                fontSize = 13.sp,
                                color = if (selected) accent else MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier
                                    .padding(end = 6.dp)
                                    .clip(RoundedCornerShape(50))
                                    .background(if (selected) accent.copy(alpha = 0.14f) else Color.Transparent)
                                    .border(1.dp, if (selected) Color.Transparent else hairline, RoundedCornerShape(50))
                                    .clickable { thinking = levelId; Store.setThinking(session, levelId) }
                                    .padding(horizontal = 12.dp, vertical = 6.dp),
                            )
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("关闭") } },
    )
}
