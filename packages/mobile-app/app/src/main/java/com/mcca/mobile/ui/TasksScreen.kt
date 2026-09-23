package com.mcca.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Refresh
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mcca.mobile.store.Session
import com.mcca.mobile.store.Store
import com.mcca.mobile.store.Task
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(onOpenSession: (Session) -> Unit, onOpenSubagent: (Task) -> Unit = {}) {
    var segment by remember { mutableIntStateOf(0) }
    var tick by remember { mutableStateOf(0L) }
    LaunchedEffect(Unit) {
        Store.refreshTasks()
        Store.loadNotices()
        while (true) {
            delay(5000)
            tick = System.currentTimeMillis()
            Store.refreshTasks()
        }
    }
    val autoNotices = Store.autoNotices()
    val unreadNotices = autoNotices.count { !it.read }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = { Text("任务", fontWeight = FontWeight.SemiBold, fontSize = 20.sp) },
                    actions = {
                        IconButton(onClick = { Store.refreshTasks() }) {
                            Icon(
                                Icons.Default.Refresh,
                                "刷新",
                                modifier = Modifier.size(19.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                )
                Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 4.dp)) {
                    FilterChip("进行中 ${Store.tasks.count { it.status == "working" }}", segment == 0) { segment = 0 }
                    FilterChip(if (unreadNotices > 0) "通知 $unreadNotices" else "通知", segment == 1) {
                        segment = 1
                        Store.loadNotices()
                        Store.markAllRead()
                    }
                }
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (segment == 0) {
                if (Store.tasks.isEmpty()) {
                    EmptyHint("没有进行中的任务", "桌面端开跑后，这里实时显示进度、耗时与目标状态")
                } else {
                    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 4.dp)) {
                        items(Store.tasks, key = { it.id }) { task ->
                            TaskCard(task, tick, onOpen = { session -> if (session != null) onOpenSession(session) }, onOpenSubagent)
                        }
                        item { Spacer(Modifier.height(80.dp)) }
                    }
                }
            } else {
                if (autoNotices.isEmpty()) {
                    EmptyHint("没有通知", "任务完成 / 失败时会推送到这里，并弹系统通知；事件板在底栏单独一页")
                } else {
                    LazyColumn(Modifier.fillMaxSize()) {
                        items(autoNotices, key = { it.id }) { notice ->
                            Column(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        if (notice.sessionId.isEmpty()) return@clickable
                                        Store.sessions.firstOrNull { it.id == notice.sessionId }?.let(onOpenSession)
                                    }
                                    .padding(horizontal = 16.dp, vertical = 12.dp),
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(
                                        Icons.Default.Notifications,
                                        null,
                                        tint = if (notice.kind == "error") Danger else accent,
                                        modifier = Modifier.size(14.dp),
                                    )
                                    Spacer(Modifier.width(7.dp))
                                    Text(
                                        notice.title,
                                        fontWeight = FontWeight.Medium,
                                        fontSize = 14.sp,
                                        modifier = Modifier.weight(1f),
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(timeAgo(notice.at), fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                if (notice.body.isNotEmpty()) {
                                    Spacer(Modifier.height(4.dp))
                                    Text(
                                        notice.body,
                                        fontSize = 12.sp,
                                        lineHeight = 18.sp,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 3,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.padding(start = 21.dp),
                                    )
                                }
                            }
                            ListDivider(startIndent = 16.dp)
                        }
                        item { Spacer(Modifier.height(80.dp)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskCard(task: Task, tick: Long, onOpen: (Session?) -> Unit, onOpenSubagent: (Task) -> Unit) {
    val (statusColor, statusText) = when (task.status) {
        "working" -> Amber to (task.statusText.ifEmpty { "进行中" })
        "completed" -> accent to "已完成"
        "failed" -> Danger to "失败"
        "stopped" -> MaterialTheme.colorScheme.onSurfaceVariant to "已停止"
        "paused" -> Blue to "已暂停"
        else -> MaterialTheme.colorScheme.onSurfaceVariant to task.status
    }
    val elapsed = when {
        task.kind == "goal" -> ""
        task.status == "working" && task.startedAt > 0 ->
            fmtDuration((if (tick > 0) tick else System.currentTimeMillis()) - task.startedAt)
        task.endedAt > task.startedAt && task.startedAt > 0 -> fmtDuration(task.endedAt - task.startedAt)
        else -> ""
    }
    val session = Store.session(task.agent, task.sessionId)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 5.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, hairline, RoundedCornerShape(16.dp))
            .clickable { if (task.kind == "subagent") onOpenSubagent(task) else onOpen(session) }
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (task.kind == "subagent") {
                SessionAvatar(task.title, task.runId, 28.dp, "pi", role = task.title)
            } else {
                RunDot(active = task.status == "working", size = 7.dp, color = statusColor)
            }
            Spacer(Modifier.width(8.dp))
            Text(
                when (task.kind) {
                    "subagent" -> "子代理 · ${task.title}"
                    "goal" -> "目标 · ${task.title}"
                    else -> task.title
                },
                fontWeight = FontWeight.Medium,
                fontSize = 14.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            AgentTag(task.agent)
        }
        if (task.detail.isNotEmpty()) {
            Spacer(Modifier.height(5.dp))
            Text(
                task.detail,
                fontSize = 12.sp,
                lineHeight = 18.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (task.parentTitle.isNotEmpty() && task.parentTitle != task.title) {
            Spacer(Modifier.height(5.dp))
            Text(
                "来源 ${task.parentTitle}",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (task.result.isNotEmpty() || task.error.isNotEmpty()) {
            Spacer(Modifier.height(5.dp))
            Text(
                (if (task.error.isNotEmpty()) task.error else task.result).replace("\n", " "),
                fontSize = 11.sp,
                lineHeight = 16.sp,
                color = if (task.error.isNotEmpty()) Danger else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusPill(statusText, statusColor)
            if (elapsed.isNotEmpty()) {
                Spacer(Modifier.width(8.dp))
                Text(elapsed, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (task.kind == "goal" && task.updatedAt > 0) {
                Spacer(Modifier.width(8.dp))
                Text(
                    "最近活动 ${timeAgo(task.updatedAt)}",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (task.queue > 0) {
                Spacer(Modifier.width(8.dp))
                Text("排队 ${task.queue}", fontSize = 11.sp, color = Blue)
            }
            Spacer(Modifier.weight(1f))
            if (task.kind == "subagent" && task.status == "working") {
                TextButton(
                    onClick = { Store.stopSubagent(task) },
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp),
                ) { Text("停止", color = Danger, fontSize = 12.sp) }
            }
            if (task.kind == "subagent") {
                Text("查看转录 ›", fontSize = 12.sp, color = Violet)
            } else if (session != null) {
                Text("打开 ›", fontSize = 12.sp, color = accent)
            }
        }
    }
}

@Composable
fun EmptyHint(title: String, subtitle: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Default.Notifications,
                    null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                    modifier = Modifier.size(22.dp),
                )
            }
            Spacer(Modifier.height(12.dp))
            Text(title, color = MaterialTheme.colorScheme.onSurface, fontSize = 14.sp)
            Spacer(Modifier.height(6.dp))
            Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
        }
    }
}
