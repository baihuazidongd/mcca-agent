package com.mcca.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
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
import androidx.compose.runtime.getValue
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
import com.mcca.mobile.net.Hub
import com.mcca.mobile.net.Hub.Conn
import com.mcca.mobile.store.Session
import com.mcca.mobile.store.Store
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListScreen(conn: Conn, onOpen: (Session) -> Unit) {
    var menuFor by remember { mutableStateOf<String?>(null) }
    var renameFor by remember { mutableStateOf<Session?>(null) }
    var deleteFor by remember { mutableStateOf<Session?>(null) }
    var pickAgent by remember { mutableStateOf(false) }
    val filter by Store.agentFilter

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = {
                        Column {
                            Text("消息", fontWeight = FontWeight.SemiBold, fontSize = 20.sp)
                            Spacer(Modifier.height(2.dp))
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    Modifier
                                        .size(6.dp)
                                        .clip(CircleShape)
                                        .background(
                                            when {
                                                !conn.online -> Danger
                                                conn.mode == Hub.Mode.LAN -> accent
                                                else -> Blue
                                            },
                                        ),
                                )
                                Spacer(Modifier.width(5.dp))
                                Text(
                                    when {
                                        conn.online && conn.mode == Hub.Mode.LAN -> "局域网直连 · ${conn.desktop?.name ?: ""}"
                                        conn.online -> "公网中转 · ${conn.desktop?.name ?: ""}"
                                        else -> conn.detail.ifEmpty { "未连接" }
                                    },
                                    fontSize = 11.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    },
                    actions = {
                        IconButton(onClick = { Store.refreshSessions() }) {
                            Icon(
                                Icons.Default.Refresh,
                                contentDescription = "刷新",
                                modifier = Modifier.size(19.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                )
                Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 4.dp)) {
                    FilterChip("全部 ${Store.sessions.size}", filter == "all") { Store.agentFilter.value = "all" }
                    FilterChip("pi ${Store.sessions.count { it.agent == "pi" }}", filter == "pi") { Store.agentFilter.value = "pi" }
                    FilterChip("dsh ${Store.sessions.count { it.agent == "dsh" }}", filter == "dsh") { Store.agentFilter.value = "dsh" }
                }
            }
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { if (filter == "all") pickAgent = true else Store.newSession(filter) { onOpen(it) } },
                containerColor = accent,
                contentColor = MaterialTheme.colorScheme.onPrimary,
                shape = RoundedCornerShape(16.dp),
            ) {
                Icon(Icons.Default.Add, contentDescription = "新会话", modifier = Modifier.size(22.dp))
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (!conn.online) OfflineBanner(conn)
            val items = Store.visibleSessions()
            if (items.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("还没有会话", color = MaterialTheme.colorScheme.onSurface, fontSize = 15.sp)
                        Spacer(Modifier.height(6.dp))
                        Text("点右下角 ＋ 开一个", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            LazyColumn(Modifier.fillMaxSize()) {
                items(items, key = { it.key }, contentType = { _ -> "session" }) { session ->
                    SessionRow(session, onOpen, { menuFor = session.key })
                    if (menuFor == session.key) {
                        Box {
                            DropdownMenu(expanded = true, onDismissRequest = { menuFor = null }) {
                                DropdownMenuItem(
                                    text = { Text("重命名") },
                                    leadingIcon = { Icon(Icons.Default.Edit, null, modifier = Modifier.size(18.dp)) },
                                    onClick = { menuFor = null; renameFor = session },
                                )
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            if (session.agent == "dsh") "dsh 会话不支持删除" else "删除",
                                            color = if (session.agent == "dsh") MaterialTheme.colorScheme.onSurfaceVariant else Danger,
                                        )
                                    },
                                    leadingIcon = {
                                        Icon(
                                            Icons.Default.Delete,
                                            null,
                                            tint = if (session.agent == "dsh") MaterialTheme.colorScheme.onSurfaceVariant else Danger,
                                            modifier = Modifier.size(18.dp),
                                        )
                                    },
                                    enabled = session.agent != "dsh",
                                    onClick = { menuFor = null; deleteFor = session },
                                )
                            }
                        }
                    }
                    ListDivider()
                }
                item { Spacer(Modifier.height(84.dp)) }
            }
        }
    }

    if (pickAgent) {
        AlertDialog(
            onDismissRequest = { pickAgent = false },
            title = { Text("新会话用哪个 agent？") },
            text = {
                Column {
                    AgentOption("pi", "pi（pi-web：会话、子代理、技能）") { pickAgent = false; Store.newSession("pi") { onOpen(it) } }
                    Spacer(Modifier.height(8.dp))
                    AgentOption("dsh", "dsh（Cordis：目标、沙箱、命令）") { pickAgent = false; Store.newSession("dsh") { onOpen(it) } }
                }
            },
            confirmButton = { TextButton(onClick = { pickAgent = false }) { Text("取消") } },
        )
    }

    renameFor?.let { target ->
        var text by remember(target.key) { mutableStateOf(target.title) }
        AlertDialog(
            onDismissRequest = { renameFor = null },
            title = { Text("重命名会话") },
            text = { OutlinedTextField(value = text, onValueChange = { text = it }, singleLine = true) },
            confirmButton = {
                TextButton(onClick = {
                    if (text.isNotBlank()) Store.renameSession(target, text.trim())
                    renameFor = null
                }) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { renameFor = null }) { Text("取消") } },
        )
    }

    deleteFor?.let { target ->
        AlertDialog(
            onDismissRequest = { deleteFor = null },
            title = { Text("删除会话") },
            text = { Text("「${target.title}」及其本地记录将被删除，不可恢复。") },
            confirmButton = {
                TextButton(onClick = { Store.deleteSession(target) {}; deleteFor = null }) { Text("删除", color = Danger) }
            },
            dismissButton = { TextButton(onClick = { deleteFor = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun AgentOption(agent: String, desc: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f))
            .clickable(onClick = onClick)
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AgentBadge(agent)
        Spacer(Modifier.width(10.dp))
        Text(desc, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun SessionRow(session: Session, onOpen: (Session) -> Unit, onMenu: () -> Unit) {
    var tick by remember { mutableStateOf(0L) }
    if (session.running) {
        whilePolling(session.key, session.running) {
            while (session.running) {
                tick = System.currentTimeMillis()
                delay(1000)
            }
        }
    }
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onOpen(session) }
            .padding(start = 16.dp, end = 12.dp, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SessionAvatar(session.title, session.key, 48.dp, session.agent)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    session.title,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                    fontSize = 15.sp,
                )
                Spacer(Modifier.width(6.dp))
                AgentTag(session.agent)
            }
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (session.running) {
                    RunDot(true, 6.dp)
                    Spacer(Modifier.width(5.dp))
                }
                val preview = when {
                    session.running && session.lastText.isNotEmpty() -> session.lastText
                    session.running -> "任务进行中…"
                    session.lastText.isNotEmpty() -> session.lastText
                    session.lastStatus == "error" -> "上次任务失败"
                    else -> shortWorkspace(session.cwd).ifEmpty { "空白会话" }
                }
                Text(
                    preview,
                    fontSize = 13.sp,
                    color = when {
                        session.running -> Amber
                        session.lastStatus == "error" && session.lastText.isEmpty() -> Danger
                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 220.dp),
                )
                if (session.goal != null) {
                    Spacer(Modifier.width(6.dp))
                    Text("目标", color = Violet, fontSize = 10.sp)
                }
                if (session.queue > 0) {
                    Spacer(Modifier.width(6.dp))
                    Text("排队 ${session.queue}", color = Blue, fontSize = 10.sp)
                }
            }
        }
        Spacer(Modifier.width(8.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(
                if (session.running && session.turnStartedAt > 0) fmtDuration(tick - session.turnStartedAt)
                else timeAgo(session.updatedAt),
                fontSize = 11.sp,
                color = if (session.running) Amber else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (session.unread > 0) {
                    Box(
                        Modifier
                            .clip(CircleShape)
                            .background(accent)
                            .padding(horizontal = 7.dp, vertical = 2.dp),
                    ) {
                        Text(
                            if (session.unread > 99) "99+" else "${session.unread}",
                            color = MaterialTheme.colorScheme.onPrimary,
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                    Spacer(Modifier.width(2.dp))
                }
                IconButton(onClick = onMenu, modifier = Modifier.size(24.dp)) {
                    Icon(
                        Icons.Default.MoreVert,
                        "更多",
                        modifier = Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
                    )
                }
            }
        }
    }
}

@Composable
fun OfflineBanner(conn: Conn) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surface)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(Danger))
            Spacer(Modifier.width(6.dp))
            Text(
                conn.detail.ifEmpty { "未连接桌面" },
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 12.sp,
                maxLines = 2,
            )
        }
        TextButton(onClick = { Store.refreshSessions() }) { Text("重试", color = accent, fontSize = 12.sp) }
    }
}
