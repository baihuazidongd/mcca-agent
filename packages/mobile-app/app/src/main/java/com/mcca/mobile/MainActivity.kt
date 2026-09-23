package com.mcca.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.key
import com.mcca.mobile.data.Args
import com.mcca.mobile.net.Hub
import com.mcca.mobile.service.HubService
import com.mcca.mobile.store.Session
import com.mcca.mobile.store.Store
import com.mcca.mobile.store.Task
import com.mcca.mobile.ui.ChatListScreen
import com.mcca.mobile.ui.ChatScreen
import com.mcca.mobile.ui.BoardScreen
import com.mcca.mobile.ui.HostScreen
import com.mcca.mobile.ui.MccaTheme
import com.mcca.mobile.ui.MeScreen
import com.mcca.mobile.ui.SubagentScreen
import com.mcca.mobile.ui.TasksScreen
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val deepLink = MutableStateFlow<String?>(null)
    private val openBoard = MutableStateFlow(false)

    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as MccaApp
        startForegroundService(Intent(this, HubService::class.java))
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        deepLink.value = intent?.getStringExtra("sessionId")
        openBoard.value = intent?.getBooleanExtra("openBoard", false) == true
        setContent {
            val args by app.prefs.flow.collectAsState(initial = Args())
            MccaTheme(themeMode = args.theme) {
                Root(args = args, deepLink = deepLink, openBoard = openBoard, onSave = { app.scope.launch { app.prefs.save(it) } })
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val id = intent.getStringExtra("sessionId")
        if (!id.isNullOrEmpty()) deepLink.value = id
        if (intent.getBooleanExtra("openBoard", false)) openBoard.value = true
    }

    override fun onResume() {
        super.onResume()
        AppState.foreground = true
    }

    override fun onPause() {
        AppState.foreground = false
        super.onPause()
    }
}

private data class Tab(val label: String, val icon: ImageVector)
@Composable
private fun Root(
    args: Args,
    deepLink: MutableStateFlow<String?>,
    openBoard: MutableStateFlow<Boolean>,
    onSave: (Args) -> Unit,
) {
    var tab by remember { mutableIntStateOf(0) }
    var openKey by remember { mutableStateOf("") }
    var openTask by remember { mutableStateOf<Task?>(null) }
    val conn by Hub.conn.collectAsState()
    val link by deepLink.collectAsState()
    val boardLink by openBoard.collectAsState()

    LaunchedEffect(conn.online) {
        if (conn.online) Store.refreshSessions()
    }
    LaunchedEffect(link) {
        val id = link
        if (!id.isNullOrEmpty()) {
            Store.sessions.firstOrNull { it.id == id }?.let { openKey = it.key }
            deepLink.value = null
        }
    }
    LaunchedEffect(boardLink) {
        if (boardLink) {
            tab = 2
            openBoard.value = false
        }
    }

    val opened: Session? = if (openKey.isEmpty()) null else Store.sessionByKey(openKey)
    LaunchedEffect(openKey, opened) {
        AppState.currentSession = opened?.id ?: ""
    }
    // 系统返回键：聊天页 → 回列表；子代理页自己消费返回。其余情况交给系统（退出应用）
    BackHandler(enabled = opened != null && openTask == null) { openKey = "" }

    // 盖住而不是拆掉：返回时列表/聊天的滚动位置还在。盖住时不放置，避免白画一层。
    Box(Modifier.fillMaxSize()) {
        KeptAlive(visible = opened == null && openTask == null) {
            TabScaffold(
                tab = tab,
                onTab = { tab = it },
                args = args,
                onSave = onSave,
                conn = conn,
                onOpen = { openKey = it.key },
                onOpenSubagent = { openTask = it },
            )
        }
        if (opened != null) {
            KeptAlive(visible = openTask == null) {
                key(opened.key) {
                    ChatScreen(
                        session = opened,
                        onBack = { openKey = "" },
                        onDeleted = { openKey = "" },
                        onOpenSubagent = { openTask = it },
                    )
                }
            }
        }
        openTask?.let { task ->
            SubagentScreen(
                task = task,
                onBack = { openTask = null },
                onOpenParent = {
                    openTask = null
                    openKey = "${task.agent}:${task.sessionId}"
                },
            )
        }
    }
}

@Composable
private fun KeptAlive(visible: Boolean, content: @Composable () -> Unit) {
    // 同一个调用点，切换可见性才不会把里面的滚动状态丢掉
    Box(
        if (visible) Modifier.fillMaxSize()
        else Modifier
            .clearAndSetSemantics { }
            .layout { measurable, constraints ->
                measurable.measure(constraints)
                layout(0, 0) {}
            },
    ) { content() }
}

@Composable
private fun TabScaffold(
    tab: Int,
    onTab: (Int) -> Unit,
    args: Args,
    onSave: (Args) -> Unit,
    conn: com.mcca.mobile.net.Hub.Conn,
    onOpen: (Session) -> Unit,
    onOpenSubagent: (Task) -> Unit,
) {
    val tabs = listOf(
        Tab("消息", Icons.Default.Home),
        Tab("任务", Icons.Default.Notifications),
        Tab("事件板", Icons.Default.List),
        Tab("管理", Icons.Default.Settings),
        Tab("我的", Icons.Default.Person),
    )
    val boardUnread = if (tab == 2 || Store.notices.isEmpty()) 0 else Store.boardUnread()
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Box(Modifier.weight(1f)) {
            when (tab) {
                0 -> ChatListScreen(conn, onOpen = onOpen)
                1 -> TasksScreen(onOpenSession = onOpen, onOpenSubagent = onOpenSubagent)
                2 -> BoardScreen()
                3 -> HostScreen()
                else -> MeScreen(args, onSave)
            }
        }
        NavigationBar(containerColor = MaterialTheme.colorScheme.background, tonalElevation = 0.dp) {
            tabs.forEachIndexed { index, item ->
                val selected = tab == index
                NavigationBarItem(
                    selected = selected,
                    onClick = { onTab(index) },
                    icon = {
                        if (index == 2 && boardUnread > 0) {
                            BadgedBox(
                                badge = {
                                    Badge(containerColor = MaterialTheme.colorScheme.primary) {
                                        Text(if (boardUnread > 99) "99+" else "$boardUnread", fontSize = 9.sp)
                                    }
                                },
                            ) {
                                Icon(item.icon, item.label, modifier = Modifier.size(22.dp))
                            }
                        } else {
                            Icon(item.icon, item.label, modifier = Modifier.size(22.dp))
                        }
                    },
                    label = {
                        Text(item.label, fontSize = 10.sp)
                    },
                    colors = NavigationBarItemDefaults.colors(
                        selectedIconColor = MaterialTheme.colorScheme.primary,
                        selectedTextColor = MaterialTheme.colorScheme.primary,
                        indicatorColor = MaterialTheme.colorScheme.surfaceVariant,
                        unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                        unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    ),
                )
            }
        }
    }
}
