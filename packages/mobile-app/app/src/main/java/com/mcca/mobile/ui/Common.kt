package com.mcca.mobile.ui

import android.graphics.Bitmap
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.lazy.LazyListState
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.mcca.mobile.data.Avatars
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * 只在界面可见时跑的轮询：退到后台就停，回到前台立刻再跑一轮。
 *
 * 直接 `LaunchedEffect { while(true) delay(...) }` 的循环在 Activity 只 stop 不
 * destroy 时是继续跑的 —— 手机揣兜里也在每 5s 往桌面打一次 tasks.list（那一次要
 * 扇 12–20 个会话快照，实测持续吃掉桌面两成单核）。
 */
@Composable
fun whilePolling(vararg keys: Any?, block: suspend () -> Unit) {
    val owner = LocalContext.current as? LifecycleOwner
    LaunchedEffect(*keys) {
        if (owner == null) {
            block()
        } else {
            owner.repeatOnLifecycle(Lifecycle.State.STARTED) { block() }
        }
    }
}

/**
 * 头像色系按 agent 归属：pi 走蓝靛、dsh 走紫罗兰、未知走石板灰。
 * 同一 agent 内部按 key 取不同深浅，保证「成组但不刺眼」。
 */
private val PI_TONES = listOf(
    Color(0xFF5B7CFA), Color(0xFF4E86EF), Color(0xFF5F6EE8),
    Color(0xFF4A78E0), Color(0xFF6A79F5), Color(0xFF5268D8),
)
private val DSH_TONES = listOf(
    Color(0xFF9E7BFF), Color(0xFFA96BF0), Color(0xFF8F6CF2),
    Color(0xFFB088F5), Color(0xFF8E5EE0), Color(0xFF9C7AEB),
)
private val NEUTRAL_TONES = listOf(
    Color(0xFF64748B), Color(0xFF5D6B7E), Color(0xFF6B7A8F),
)

private fun toneFor(key: String, agent: String): Color {
    val pool = when (agent) {
        "pi" -> PI_TONES
        "dsh" -> DSH_TONES
        else -> NEUTRAL_TONES
    }
    var hash = 7
    for (c in (key.ifEmpty { "x" })) hash = hash * 31 + c.code
    return pool[((hash % pool.size) + pool.size) % pool.size]
}

/**
 * 最后一条的底边相对视口底边多出来的像素。
 * 正数 = 新内容被挡住，需要往下跟；负数 = 内容还没撑满；[Int.MIN_VALUE] = 底不在视口里。
 * 视口高度为 0（页面被收起）时返回 0，避免在看不见的时候空转滚动。
 */
internal fun LazyListState.endOverflow(): Int {
    val info = layoutInfo
    val viewport = info.viewportEndOffset - info.viewportStartOffset
    if (info.totalItemsCount == 0 || viewport <= 0) return 0
    val last = info.visibleItemsInfo.lastOrNull() ?: return Int.MIN_VALUE
    if (last.index < info.totalItemsCount - 1) return Int.MIN_VALUE
    return last.offset + last.size - info.viewportEndOffset
}

/** 把最后一条的末尾露出来。默认偏移会把长消息的开头钉在视口顶上，聊天要的是末尾。 */
internal suspend fun LazyListState.revealEnd(animated: Boolean = false) {
    val count = layoutInfo.totalItemsCount
    if (count <= 0) return
    val target = count - 1
    if (animated) animateScrollToItem(target) else scrollToItem(target)
    val info = layoutInfo
    val vis = info.visibleItemsInfo.lastOrNull() ?: return
    if (vis.index != target) return
    val extra = vis.offset + vis.size - info.viewportEndOffset
    if (extra > 1) {
        if (animated) animateScrollBy(extra.toFloat()) else scroll { scrollBy(extra.toFloat()) }
    }
}

fun initialOf(name: String): String {
    val trimmed = name.trim()
    if (trimmed.isEmpty()) return "?"
    val first = trimmed.first()
    return if (first.code in 0x4E00..0x9FFF || first.isLetter()) first.uppercase() else "#"
}

@Composable
fun Avatar(name: String, key: String = name, size: Dp = 48.dp, agent: String = "") {
    val tone = toneFor(key.ifEmpty { name }, agent)
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(Brush.verticalGradient(listOf(lerp(tone, Color.White, 0.10f), tone))),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = initialOf(name),
            color = Color.White.copy(alpha = 0.96f),
            fontWeight = FontWeight.Medium,
            fontSize = (size.value * 0.38f).sp,
        )
    }
}

/**
 * 会话头像：pi 用像素角色（每会话固定角色，与 pi-web 同 hash），
 * 拿不到素材或 dsh 会话回落字母头像。
 */
@Composable
fun SessionAvatar(
    name: String,
    key: String,
    size: Dp = 48.dp,
    agent: String = "",
    role: String = "",
) {
    val bitmap by produceState<Bitmap?>(
        initialValue = if (agent == "pi") Avatars.cached(agent, key, role) else null,
        key,
        agent,
        role,
    ) {
        // 轮询缓存直到出现：预取正在进行时 load() 会被去重挡下（返回 null），
        // 之前拿到 null 就再也不重试，行上就一直是字母头像。
        value = if (agent != "pi") null else Avatars.cached(agent, key, role)
        var tries = 0
        while (value == null && agent == "pi" && tries < 30) {
            kotlinx.coroutines.delay(700)
            value = Avatars.cached(agent, key, role) ?: Avatars.load(agent, key, role)
            tries += 1
        }
    }
    val bmp = bitmap
    if (bmp == null) {
        Avatar(name, key, size, agent)
        return
    }
    val tone = toneFor(key.ifEmpty { name }, agent)
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(tone.copy(alpha = 0.16f)),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            bitmap = bmp.asImageBitmap(),
            contentDescription = name,
            contentScale = ContentScale.Fit,
            filterQuality = FilterQuality.None,
            modifier = Modifier.fillMaxSize().padding(size * 0.08f),
        )
    }
}

/** 会话来源平文标记：不用底色胶囊，避免列表花。 */
@Composable
fun AgentTag(agent: String, modifier: Modifier = Modifier) {
    if (agent.isEmpty()) return
    Text(
        text = if (agent == "dsh") "dsh" else "pi",
        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f),
        fontSize = 10.sp,
        fontWeight = FontWeight.Medium,
        modifier = modifier,
    )
}

/** 任务/目标卡上的来源胶囊（信息更弱，才用底色）。 */
@Composable
fun AgentBadge(agent: String, compact: Boolean = false) {
    if (agent.isEmpty()) return
    val color = if (agent == "dsh") Violet else Blue
    Text(
        text = if (agent == "dsh") "dsh" else "pi",
        color = color,
        fontSize = if (compact) 9.sp else 10.sp,
        fontWeight = FontWeight.Medium,
        maxLines = 1,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(color.copy(alpha = 0.12f))
            .padding(horizontal = if (compact) 5.dp else 6.dp, vertical = 1.dp),
    )
}

@Composable
fun RunDot(active: Boolean, size: Dp = 7.dp, color: Color = Amber) {
    if (!active) {
        Box(Modifier.size(size).clip(CircleShape).background(MaterialTheme.colorScheme.outline))
        return
    }
    val transition = rememberInfiniteTransition(label = "run")
    val pulse by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(800), RepeatMode.Reverse),
        label = "pulse",
    )
    Box(Modifier.size(size).alpha(pulse).clip(CircleShape).background(color))
}

/** 状态小胶囊：底色极淡，只做定性提示。 */
@Composable
fun StatusPill(text: String, color: Color, modifier: Modifier = Modifier) {
    Text(
        text = text,
        color = color,
        fontSize = 11.sp,
        fontWeight = FontWeight.Medium,
        maxLines = 1,
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(color.copy(alpha = 0.12f))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

fun timeAgo(ms: Long): String {
    if (ms <= 0) return ""
    val now = System.currentTimeMillis()
    val diff = now - ms
    return when {
        diff < 60_000 -> "刚刚"
        diff < 3_600_000 -> "${diff / 60_000} 分钟前"
        isSameDay(ms, now) -> SimpleDateFormat("HH:mm", Locale.CHINA).format(Date(ms))
        isSameDay(ms, now - 86_400_000) -> "昨天"
        else -> SimpleDateFormat("M月d日", Locale.CHINA).format(Date(ms))
    }
}

fun clockText(ms: Long): String = SimpleDateFormat("HH:mm", Locale.CHINA).format(Date(ms))

private fun isSameDay(a: Long, b: Long): Boolean {
    val ca = Calendar.getInstance().apply { timeInMillis = a }
    val cb = Calendar.getInstance().apply { timeInMillis = b }
    return ca.get(Calendar.YEAR) == cb.get(Calendar.YEAR) && ca.get(Calendar.DAY_OF_YEAR) == cb.get(Calendar.DAY_OF_YEAR)
}

fun fmtDuration(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0)
    val m = total / 60
    val s = total % 60
    return if (m >= 60) String.format(Locale.CHINA, "%d:%02d:%02d", m / 60, m % 60, s)
    else String.format(Locale.CHINA, "%02d:%02d", m, s)
}

fun fmtBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val kb = bytes / 1024.0
    if (kb < 1024) return String.format(Locale.CHINA, "%.0f KB", kb)
    val mb = kb / 1024.0
    if (mb < 1024) return String.format(Locale.CHINA, "%.1f MB", mb)
    return String.format(Locale.CHINA, "%.2f GB", mb / 1024.0)
}

/** 会话列表用的工作区短名（D:\dshpi → dshpi）。 */
fun shortWorkspace(cwd: String): String {
    val trimmed = cwd.trim().trimEnd('\\', '/')
    if (trimmed.isEmpty()) return ""
    val part = trimmed.substringAfterLast('\\').substringAfterLast('/')
    return part.ifEmpty { trimmed }
}

@Composable
fun KeyValueRow(label: String, value: String, valueColor: Color = MaterialTheme.colorScheme.onSurface) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 5.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
        Text(value, color = valueColor, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** 设置页分组卡片：弱分隔、留白为主。 */
@Composable
fun SectionCard(
    title: String? = null,
    modifier: Modifier = Modifier,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 5.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, hairline, RoundedCornerShape(18.dp))
            .padding(16.dp),
    ) {
        if (title != null) {
            Text(
                title,
                fontWeight = FontWeight.SemiBold,
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(10.dp))
        }
        content()
    }
}

/** 分段筛选：选中只加淡底色 + 主题色字，不用大面积实心。 */
@Composable
fun FilterChip(text: String, selected: Boolean, onClick: () -> Unit) {
    Text(
        text = text,
        color = if (selected) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        fontSize = 13.sp,
        fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
        modifier = Modifier
            .padding(end = 6.dp)
            .clip(RoundedCornerShape(50))
            .background(if (selected) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

@Composable
fun ListDivider(startIndent: Dp = 74.dp) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(start = startIndent)
            .height(1.dp)
            .background(hairline.copy(alpha = 0.55f)),
    )
}
