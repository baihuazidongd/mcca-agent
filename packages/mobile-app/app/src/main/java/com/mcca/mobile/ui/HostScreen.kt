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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mcca.mobile.net.Hub
import com.mcca.mobile.store.Agent
import com.mcca.mobile.store.Store
import kotlinx.coroutines.delay

/**
 * 管理页：信息密度优先——连接 / 进程 / 资源三块，720p 一屏看完不用滚。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostScreen() {
    var tick by remember { mutableStateOf(0L) }
    whilePolling {
        Store.refreshHost()
        while (true) {
            delay(5000)
            tick = System.currentTimeMillis()
            Store.refreshHost()
        }
    }
    val conn = Hub.conn.value
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("管理", fontWeight = FontWeight.SemiBold, fontSize = 20.sp) },
                actions = {
                    IconButton(onClick = { Store.refreshHost() }) {
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
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 12.dp),
        ) {
            // ── 连接 ──────────────────────────────────────────
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                Box(
                    Modifier
                        .size(7.dp)
                        .clip(CircleShape)
                        .background(
                            when {
                                !conn.online -> Danger
                                conn.mode == Hub.Mode.LAN -> accent
                                else -> Blue
                            },
                        ),
                )
                Spacer(Modifier.width(7.dp))
                Text(
                    if (conn.online) (if (conn.mode == Hub.Mode.LAN) "局域网直连" else "公网中转") else "未连接",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    conn.desktop?.name ?: "-",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.weight(1f))
                if (conn.since > 0) {
                    Text(fmtDuration(System.currentTimeMillis() - conn.since), fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(8.dp))
                }
                TextButton(onClick = { Hub.reconnect() }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp)) {
                    Text("重连", color = accent, fontSize = 12.sp)
                }
                TextButton(onClick = { Hub.stop() }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp)) {
                    Text("断开", color = Danger, fontSize = 12.sp)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusPill("pi ${if (Store.host.piOnline) "在线" else "离线"}", if (Store.host.piOnline) accent else Danger)
                Spacer(Modifier.width(6.dp))
                StatusPill("dsh ${if (Store.host.dshOnline) "在线" else "离线"}", if (Store.host.dshOnline) accent else Danger)
                if (conn.desktop != null && conn.desktop!!.lanAddresses.isNotEmpty()) {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "内网 ${conn.desktop!!.lanAddresses.joinToString(", ")}",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                }
            }

            SectionHeader("桌面进程")
            if (!Store.host.online) {
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("portal 未运行或不可达", fontSize = 13.sp, color = Danger)
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = { Store.refreshHost() }) { Text("重试", color = accent, fontSize = 12.sp) }
                }
            } else {
                for ((index, agent) in Store.host.agents.withIndex()) {
                    if (index > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(hairline))
                    AgentRow(agent)
                }
            }

            Text(
                "资源 · App ${String.format(java.util.Locale.CHINA, "%.1f%%", Store.host.cpuApp * 100)} · " +
                    "系统 ${String.format(java.util.Locale.CHINA, "%.0f%%", Store.host.cpuTotal * 100)} · " +
                    "内存 ${fmtBytes(Store.host.memUsed)}/${fmtBytes(Store.host.memTotal)}" +
                    (if (Store.host.procCount > 0) " · ${Store.host.procCount} 进程" else ""),
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 10.dp, bottom = 4.dp),
            )
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 2.dp)) {
        Text(text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f).height(1.dp).background(hairline))
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.Metric(label: String, value: String, ratio: Float) {
    Column(Modifier.weight(1f)) {
        Text(label, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(2.dp))
        Text(value, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1)
        Spacer(Modifier.height(4.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .height(3.dp)
                .clip(RoundedCornerShape(50))
                .background(MaterialTheme.colorScheme.surfaceVariant),
        ) {
            if (ratio >= 0f) {
                Box(
                    Modifier
                        .fillMaxWidth(ratio.coerceIn(0f, 1f))
                        .height(3.dp)
                        .clip(RoundedCornerShape(50))
                        .background(if (ratio > 0.85f) Danger else accent),
                )
            }
        }
    }
}

@Composable
private fun AgentRow(agent: Agent) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(if (agent.running) accent else MaterialTheme.colorScheme.outline),
        )
        Spacer(Modifier.width(8.dp))
        Text(agent.label.ifEmpty { agent.name }, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = Modifier.width(64.dp))
        Text(
            if (agent.running) "运行中" else "已停止",
            fontSize = 12.sp,
            color = if (agent.running) accent else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (agent.port > 0) {
            Spacer(Modifier.width(8.dp))
            Text(":${agent.port}", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (agent.running && agent.startedAt > 0) {
            Spacer(Modifier.width(8.dp))
            Text(
                "${fmtDuration(System.currentTimeMillis() - agent.startedAt)}" + if (agent.pid > 0) " · pid ${agent.pid}" else "",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (!agent.running && agent.lastExitAt > 0) {
            Spacer(Modifier.width(8.dp))
            Text("上次异常退出 ${timeAgo(agent.lastExitAt)}", fontSize = 11.sp, color = Danger)
        }
        Spacer(Modifier.weight(1f))
        if (agent.busy) {
            Text("处理中…", fontSize = 12.sp, color = Amber)
        } else if (agent.running) {
            Text("重启", fontSize = 12.sp, color = Blue, modifier = Modifier.clickable { Store.hostAction(agent.name, "restart") }.padding(horizontal = 6.dp))
            Text("停止", fontSize = 12.sp, color = Danger, modifier = Modifier.clickable { Store.hostAction(agent.name, "stop") }.padding(horizontal = 6.dp))
        } else {
            Text("启动", fontSize = 12.sp, color = accent, modifier = Modifier.clickable { Store.hostAction(agent.name, "start") }.padding(horizontal = 6.dp))
        }
    }
}
