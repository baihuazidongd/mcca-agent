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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.first
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mcca.mobile.store.Msg
import com.mcca.mobile.store.Store
import com.mcca.mobile.store.Task

/**
 * 子代理详情：只读转录。
 * 子代理是 pi 的独立子会话（列表里不出现），从「任务」页的子代理卡片点进来。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SubagentScreen(task: Task, onBack: () -> Unit, onOpenParent: () -> Unit) {
    val messages = Store.transcripts[task.id]
    val loading = Store.transcriptLoading[task.id] == true
    val error = Store.transcriptError[task.id].orEmpty()
    val info = Store.transcriptRuns[task.id] ?: task
    val agentName = Store.transcriptMeta[task.id].orEmpty().ifEmpty { info.title.ifEmpty { task.title } }
    val listState = rememberLazyListState()
    val widthDp = LocalConfiguration.current.screenWidthDp

    LaunchedEffect(task.id) { Store.openTranscript(task) }
    BackHandler(enabled = true) { onBack() }
    LaunchedEffect(task.id) {
        var seen = -1
        snapshotFlow { Store.transcripts[task.id]?.size ?: 0 }.collect { count ->
            if (count <= 0 || count == seen) return@collect
            seen = count
            snapshotFlow { listState.layoutInfo.totalItemsCount }.first { it > 0 }
            listState.revealEnd()
        }
    }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    navigationIcon = {
                        IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "返回", modifier = Modifier.size(20.dp)) }
                    },
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            SessionAvatar(agentName.ifEmpty { info.title }, task.runId, 32.dp, "pi", role = info.title)
                            Spacer(Modifier.width(10.dp))
                            Column {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text("子代理", color = Violet, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                                    Spacer(Modifier.width(6.dp))
                                    AgentTag("pi")
                                }
                                Text(
                                    agentName.ifEmpty { "子代理" },
                                    fontWeight = FontWeight.SemiBold,
                                    fontSize = 15.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    },
                    actions = {
                        IconButton(onClick = { Store.openTranscript(task, force = true) }) {
                            Icon(
                                Icons.Default.Refresh,
                                "刷新",
                                modifier = Modifier.size(19.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        TextButton(onClick = onOpenParent) { Text("父会话", color = accent, fontSize = 13.sp) }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                )
                Box(Modifier.fillMaxWidth().height(1.dp).background(hairline))
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            // 任务概要条：状态 + 任务描述 + 结果/错误
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 6.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(MaterialTheme.colorScheme.surface)
                    .padding(12.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RunDot(active = info.status == "working", size = 7.dp)
                    Spacer(Modifier.width(8.dp))
                    val (color, text) = when (info.status) {
                        "working" -> Amber to "进行中"
                        "completed" -> accent to "已完成"
                        "failed" -> Danger to "失败"
                        "stopped" -> MaterialTheme.colorScheme.onSurfaceVariant to "已停止"
                        else -> MaterialTheme.colorScheme.onSurfaceVariant to info.status.ifEmpty { "未知" }
                    }
                    StatusPill(text, color)
                    if (info.model.isNotEmpty()) {
                        Spacer(Modifier.width(6.dp))
                        StatusPill(info.model, Blue)
                    }
                    if (info.thinking.isNotEmpty()) {
                        Spacer(Modifier.width(6.dp))
                        StatusPill("思考 ${info.thinking}", Violet)
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "父会话：${info.parentTitle.ifEmpty { info.sessionId }}",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (info.detail.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text(info.detail, fontSize = 12.sp, lineHeight = 18.sp, color = MaterialTheme.colorScheme.onSurface)
                }
                if (info.result.isNotEmpty() && (messages.isNullOrEmpty())) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "结果：${info.result.replace("\n", " ")}",
                        fontSize = 12.sp,
                        lineHeight = 18.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (info.error.isNotEmpty()) {
                    Spacer(Modifier.height(4.dp))
                    Text(info.error, fontSize = 12.sp, color = Danger, lineHeight = 18.sp)
                }
            }

            when {
                loading && messages.isNullOrEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator(modifier = Modifier.size(22.dp), color = accent, strokeWidth = 2.dp)
                        Spacer(Modifier.height(10.dp))
                        Text("读取子代理转录…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                error.isNotEmpty() -> EmptyHint("读不到转录", error)
                messages.isNullOrEmpty() -> EmptyHint(
                    "子代理还没有输出",
                    if (task.status == "working") "正在跑，稍后点右上角刷新" else "这个 run 没有留下转录",
                )
                else -> LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(top = 6.dp, bottom = 16.dp),
                ) {
                    items(messages, key = { it.id }) { msg ->
                        TranscriptBubble(msg, (widthDp * 0.86f).dp)
                    }
                }
            }
        }
    }
}

@Composable
private fun TranscriptBubble(msg: Msg, maxWidth: androidx.compose.ui.unit.Dp) {
    when (msg.role) {
        "user" -> Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.End,
        ) {
            Box(
                Modifier
                    .widthIn(max = maxWidth * 0.8f)
                    .clip(RoundedCornerShape(16.dp, 16.dp, 6.dp, 16.dp))
                    .background(accent.copy(alpha = 0.14f))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Text(msg.text, fontSize = 14.sp, lineHeight = 21.sp, color = MaterialTheme.colorScheme.onSurface)
            }
        }
        "system" -> Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.Center) {
            Text(msg.text, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        else -> Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp)) {
            Column(
                Modifier
                    .widthIn(max = maxWidth)
                    .clip(RoundedCornerShape(16.dp, 16.dp, 16.dp, 6.dp))
                    .background(MaterialTheme.colorScheme.surface)
                    .border(1.dp, hairline, RoundedCornerShape(16.dp, 16.dp, 16.dp, 6.dp))
                    .padding(horizontal = 12.dp, vertical = 9.dp),
            ) {
                if (msg.thinking.isNotEmpty()) {
                    var expanded by remember(msg.id) { mutableStateOf(false) }
                    Row(
                        Modifier.clip(RoundedCornerShape(8.dp)).clickable { expanded = !expanded }.padding(vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                            null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(15.dp),
                        )
                        Spacer(Modifier.width(3.dp))
                        Text("思考过程", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (expanded) {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            msg.thinking,
                            fontSize = 12.sp,
                            lineHeight = 18.sp,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.heightIn(max = 200.dp).verticalScroll(rememberScrollState()),
                        )
                    }
                    Spacer(Modifier.height(6.dp))
                }
                if (msg.bodyText.isNotEmpty()) MarkdownText(msg.bodyText)
                if (msg.error.isNotEmpty()) {
                    Spacer(Modifier.height(4.dp))
                    Text(msg.error, fontSize = 12.sp, color = Danger)
                }
                for (tool in msg.tools) {
                    var expanded by remember(tool.callId) { mutableStateOf(false) }
                    val color = if (tool.isError) Danger else if (tool.phase == "start") Amber else accent
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .padding(top = 4.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(color.copy(alpha = 0.07f))
                            .clickable { expanded = !expanded }
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(5.dp).clip(CircleShape).background(color))
                            Spacer(Modifier.width(6.dp))
                            Text(
                                tool.name,
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace,
                                color = color,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Icon(
                                if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                                null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.size(14.dp),
                            )
                        }
                        if (expanded) {
                            if (tool.args.isNotEmpty()) {
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    tool.args,
                                    fontSize = 10.sp,
                                    lineHeight = 15.sp,
                                    fontFamily = FontFamily.Monospace,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 10,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            if (tool.output.isNotEmpty()) {
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    tool.output,
                                    fontSize = 10.sp,
                                    lineHeight = 15.sp,
                                    fontFamily = FontFamily.Monospace,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 14,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
                if (msg.at > 0 || msg.tokens > 0) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        listOf(
                            if (msg.at > 0) clockText(msg.at) else "",
                            if (msg.tokens > 0) "${msg.tokens} tok" else "",
                        ).filter { it.isNotEmpty() }.joinToString(" · "),
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f),
                    )
                }
            }
        }
    }
}
