package com.mcca.mobile.ui

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mcca.mobile.store.Notice
import com.mcca.mobile.store.Store
import kotlinx.coroutines.delay

/**
 * 事件板：只放「人在会话里明确要求推」的记录（portal 的 kind=manual）。
 * 自动播报（任务完成/失败、agent 错误）走「任务 → 通知」和系统通知，不上板。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BoardScreen() {
    var tick by remember { mutableStateOf(0L) }
    whilePolling {
        Store.loadNotices()
        Store.markBoardSeen()
        while (true) {
            delay(5000)
            tick = System.currentTimeMillis()
            Store.loadNotices()
        }
    }
    val items = Store.boardNotices()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("事件板", fontWeight = FontWeight.SemiBold, fontSize = 20.sp)
                        Text(
                            if (items.isEmpty()) "还没有记录" else "${items.size} 条记录",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { Store.loadNotices() }) {
                        Icon(
                            Icons.Default.Refresh,
                            "刷新",
                            modifier = Modifier.size(19.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (items.isNotEmpty()) {
                        TextButton(onClick = { Store.clearBoard() }) {
                            Text("清空", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (items.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(horizontal = 40.dp)) {
                        Box(
                            Modifier
                                .size(48.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                Icons.Default.List,
                                null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                                modifier = Modifier.size(22.dp),
                            )
                        }
                        Spacer(Modifier.height(12.dp))
                        Text("还没有事件", color = MaterialTheme.colorScheme.onSurface, fontSize = 14.sp)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "在会话里明确说「推一条到事件板」，pi / dsh 才会往这里推（技能：event-board）。" +
                                "任务完成/失败这类自动播报只走系统通知，不占板子。",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontSize = 12.sp,
                            lineHeight = 18.sp,
                        )
                    }
                }
            } else {
                LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 4.dp),
                ) {
                    items(items, key = { it.id }) { notice ->
                        SwipeBoardCard(notice, tick)
                    }
                    item { Spacer(Modifier.height(80.dp)) }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeBoardCard(notice: Notice, tick: Long) {
    val state = rememberSwipeToDismissBoxState(
        positionalThreshold = { distance -> distance * 0.4f },
        confirmValueChange = { value ->
            if (value == SwipeToDismissBoxValue.StartToEnd) {
                Store.dismissBoard(notice)
                true
            } else {
                false
            }
        },
    )
    SwipeToDismissBox(
        state = state,
        enableDismissFromStartToEnd = true,
        enableDismissFromEndToStart = false,
        backgroundContent = {
            Box(
                Modifier
                    .fillMaxSize()
                    .padding(horizontal = 14.dp, vertical = 5.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(MaterialTheme.colorScheme.error),
                contentAlignment = Alignment.CenterStart,
            ) {
                Row(
                    Modifier.padding(start = 18.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Default.Delete, null, tint = MaterialTheme.colorScheme.onError, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("删除", color = MaterialTheme.colorScheme.onError, fontSize = 13.sp)
                }
            }
        },
    ) {
        BoardCard(notice, tick)
    }
}

@Composable
private fun BoardCard(notice: Notice, tick: Long) {
    var expanded by remember(notice.id) { mutableStateOf(false) }
    val unread = notice.numericId > Store.boardSeenUpTo.value
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 5.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(
                1.dp,
                if (unread) accent.copy(alpha = 0.45f) else hairline,
                RoundedCornerShape(16.dp),
            )
            .clickable { expanded = !expanded }
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (unread) {
                Box(Modifier.size(7.dp).clip(CircleShape).background(accent))
                Spacer(Modifier.width(7.dp))
            }
            Text(
                notice.title,
                fontWeight = FontWeight.SemiBold,
                fontSize = 14.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                timeAgo(notice.at),
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (notice.body.isNotEmpty()) {
            Spacer(Modifier.height(7.dp))
            Text(
                notice.body,
                fontSize = 13.sp,
                lineHeight = 20.sp,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = if (expanded) 40 else 3,
                overflow = TextOverflow.Ellipsis,
            )
            if (!expanded && notice.body.length > 80) {
                Spacer(Modifier.height(5.dp))
                Text("展开全文", fontSize = 11.sp, color = accent)
            } else if (expanded && notice.body.length > 80) {
                Spacer(Modifier.height(5.dp))
                Text("收起", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusPill("手动", accent)
            if (notice.at > 0) {
                Text(clockText(notice.at), fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
