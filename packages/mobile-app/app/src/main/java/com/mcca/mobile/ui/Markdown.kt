package com.mcca.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.conflate

/**
 * 轻量 Markdown 渲染：agent 的输出本来就有标题/列表/表格/代码块/加粗，
 * 手机上按块解析后用 Compose 原生排版渲染（不引第三方库，也不走 WebView）。
 *
 * 支持：标题(#)、有序/无序列表（含嵌套与 - [ ] 勾选框）、围栏代码块、引用、
 * 表格、分割线；行内：**加粗**、*斜体*、~~删除~~、`代码`、[文字](链接)。
 * 图片语法已在 Store.bodyText 里抽走（单独渲染成图片行）。
 */

sealed interface MdBlock {
    data class Heading(val level: Int, val text: String) : MdBlock
    data class Para(val text: String) : MdBlock
    data class Item(val level: Int, val marker: String, val text: String) : MdBlock
    data class Code(val lang: String, val code: String) : MdBlock
    data class Quote(val text: String) : MdBlock
    data class Table(val header: List<String>, val rows: List<List<String>>) : MdBlock
    data object Rule : MdBlock
}

private val RE_HEADING = Regex("^\\s{0,3}(#{1,6})\\s+(.*)$")
private val RE_FENCE = Regex("^\\s{0,3}(```|~~~)\\s*([^`]*)$")
private val RE_ITEM = Regex("^(\\s*)([-*+]|\\d{1,3}[.)])\\s+(.*)$")
private val RE_RULE = Regex("^\\s{0,3}((\\*\\s*){3,}|(-\\s*){3,}|(_\\s*){3,})$")
private val RE_TABLE_SEP = Regex("^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$")

private fun splitTableRow(line: String): List<String> =
    line.trim().removePrefix("|").removeSuffix("|").split("|").map { it.trim() }

/** 把 Markdown 源码切成块（容错优先：解析不了的行当普通段落）。 */
fun parseMarkdown(src: String): List<MdBlock> {
    val lines = src.replace("\r\n", "\n").replace('\r', '\n').split('\n')
    val out = mutableListOf<MdBlock>()
    val para = mutableListOf<String>()

    fun flush() {
        if (para.isNotEmpty()) {
            out.add(MdBlock.Para(para.joinToString("\n")))
            para.clear()
        }
    }

    var i = 0
    while (i < lines.size) {
        val raw = lines[i]
        val line = raw.trimEnd()
        val fence = RE_FENCE.find(line)
        when {
            fence != null -> {
                flush()
                val mark = fence.groupValues[1]
                val lang = fence.groupValues[2].trim()
                val body = mutableListOf<String>()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith(mark)) {
                    body.add(lines[i])
                    i++
                }
                i++ // 跳过收尾围栏
                out.add(MdBlock.Code(lang, body.joinToString("\n")))
            }

            line.isBlank() -> {
                flush()
                i++
            }

            RE_HEADING.matches(line) -> {
                flush()
                val m = RE_HEADING.find(line)!!
                out.add(MdBlock.Heading(m.groupValues[1].length, m.groupValues[2].trim()))
                i++
            }

            RE_RULE.matches(line) -> {
                flush()
                out.add(MdBlock.Rule)
                i++
            }

            line.trimStart().startsWith(">") -> {
                flush()
                val quote = mutableListOf<String>()
                while (i < lines.size && lines[i].trimStart().startsWith(">")) {
                    quote.add(lines[i].trimStart().removePrefix(">").trimStart())
                    i++
                }
                out.add(MdBlock.Quote(quote.joinToString("\n")))
            }

            line.trimStart().startsWith("|") && i + 1 < lines.size && RE_TABLE_SEP.matches(lines[i + 1]) -> {
                flush()
                val header = splitTableRow(line)
                i += 2
                val rows = mutableListOf<List<String>>()
                while (i < lines.size && lines[i].trimStart().startsWith("|")) {
                    val cells = splitTableRow(lines[i])
                    if (cells.any { it.isNotEmpty() }) rows.add(cells)
                    i++
                }
                out.add(MdBlock.Table(header, rows))
            }

            RE_ITEM.matches(line) -> {
                flush()
                val m = RE_ITEM.find(line)!!
                val indent = m.groupValues[1].replace("\t", "  ").length / 2
                val bullet = m.groupValues[2]
                var text = m.groupValues[3]
                // - [ ] / - [x] 勾选项
                val check = Regex("^\\[([ xX])]\\s+(.*)$").find(text)
                val marker = when {
                    check != null && check.groupValues[1].equals("x", true) -> "☑"
                    check != null -> "☐"
                    bullet.first().isDigit() -> bullet
                    else -> "•"
                }
                if (check != null) text = check.groupValues[2]
                out.add(MdBlock.Item(indent.coerceIn(0, 3), marker, text.trim()))
                i++
            }

            else -> {
                para.add(line.trim())
                i++
            }
        }
    }
    flush()
    return out
}

/**
 * 流式增长时，只把「已经收束的块」算进稳定前缀：空行，或已经合上的围栏。
 * 当前这段未写完的段落留在尾巴里，后续 token 只重解析尾巴。
 */
internal fun splitStableMarkdown(src: String): Pair<String, String> {
    val n = src.length
    if (n < 48) return "" to src
    var i = 0
    var lineStart = 0
    var fence: String? = null
    var lastCut = 0
    while (i <= n) {
        val end = i == n
        if (end || src[i] == '\n') {
            var lineEnd = i
            if (lineEnd > lineStart && src[lineEnd - 1] == '\r') lineEnd--
            val line = src.substring(lineStart, lineEnd)
            val trimmed = line.trimStart()
            val lead = line.length - trimmed.length
            if (fence != null) {
                if (lead <= 3 && trimmed.startsWith(fence)) {
                    fence = null
                    if (!end) lastCut = i + 1
                }
            } else if (lead <= 3 && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
                fence = if (trimmed.startsWith("```")) "```" else "~~~"
            } else if (!end && line.isBlank()) {
                lastCut = i + 1
            }
            if (end) break
            i++
            lineStart = i
        } else {
            i++
        }
    }
    if (lastCut <= 0) return "" to src
    if (lastCut >= n) return src to ""
    return src.substring(0, lastCut) to src.substring(lastCut)
}

private class MdCache {
    private var stableSrc = ""
    private var stableBlocks: List<MdBlock> = emptyList()

    fun resolve(src: String): List<MdBlock> {
        val (stable, live) = splitStableMarkdown(src)
        if (stable != stableSrc) {
            stableBlocks = if (stableSrc.isNotEmpty() && stable.startsWith(stableSrc)) {
                val delta = stable.substring(stableSrc.length)
                if (delta.isBlank()) stableBlocks else stableBlocks + parseMarkdown(delta)
            } else if (stable.isEmpty()) {
                emptyList()
            } else {
                parseMarkdown(stable)
            }
            stableSrc = stable
        }
        if (live.isBlank()) return stableBlocks
        val tail = parseMarkdown(live)
        return if (tail.isEmpty()) stableBlocks else stableBlocks + tail
    }
}

private val INLINE_RULES: List<Triple<Regex, String, Int>> = listOf(
    Triple(Regex("`([^`]+)`"), "code", 0),
    Triple(Regex("\\*\\*(.+?)\\*\\*"), "bold", 1),
    // 下划线强调要求词边界：标识符里的 a_b_c、zb_ares.png 不能被当成斜体
    Triple(Regex("(?<![\\w])__([^_\\n]+?)__(?![\\w])"), "bold", 1),
    Triple(Regex("~~(.+?)~~"), "strike", 1),
    Triple(Regex("\\[([^\\]]+)]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)"), "link", 0),
    Triple(Regex("(?<![\\w])_([^_\\n]+?)_(?![\\w])"), "italic", 1),
    Triple(Regex("\\*([^*\\n]+)\\*"), "italic", 1),
)

private fun isPlainInline(text: String): Boolean {
    for (c in text) {
        if (c == '*' || c == '_' || c == '`' || c == '[' || c == '~') return false
    }
    return true
}

/** 尾巴附近还有未闭合的标记时不能只追加，得整段重排。 */
private fun markerNearEnd(src: String): Boolean {
    val from = (src.length - 16).coerceAtLeast(0)
    for (i in from until src.length) {
        when (src[i]) {
            '*', '_', '`', '~', '[', ']', '(' -> return true
        }
    }
    return false
}

private class InlineMemo {
    private var src = ""
    private var accent: Color = Color.Unspecified
    private var codeBg: Color = Color.Unspecified
    private var codeFg: Color = Color.Unspecified
    private var rendered: AnnotatedString? = null

    fun resolve(text: String, accent: Color, codeBg: Color, codeFg: Color): AnnotatedString {
        val cached = rendered
        if (cached != null && text == src && accent == this.accent && codeBg == this.codeBg && codeFg == this.codeFg) {
            return cached
        }
        val sameTheme = accent == this.accent && codeBg == this.codeBg && codeFg == this.codeFg
        if (cached != null && sameTheme && src.isNotEmpty() && text.startsWith(src)) {
            val delta = text.substring(src.length)
            if (delta.isNotEmpty() && isPlainInline(delta) && !markerNearEnd(src)) {
                val next = cached + AnnotatedString(delta)
                src = text
                rendered = next
                return next
            }
        }
        val built = buildInline(text, accent, codeBg, codeFg)
        this.accent = accent
        this.codeBg = codeBg
        this.codeFg = codeFg
        src = text
        rendered = built
        return built
    }
}

private fun buildInline(text: String, accent: Color, codeBg: Color, codeFg: Color): AnnotatedString {
    if (isPlainInline(text)) return AnnotatedString(text)
    return buildAnnotatedString {
        var rest = text
        var guard = 0
        while (rest.isNotEmpty() && guard++ < 400) {
            var best: Triple<Int, MatchResult, Triple<Regex, String, Int>>? = null
            for (rule in INLINE_RULES) {
                val m = rule.first.find(rest) ?: continue
                if (best == null || m.range.first < best!!.first) best = Triple(m.range.first, m, rule)
            }
            val hit = best ?: break
            val (start, match, rule) = hit
            if (start > 0) append(rest.substring(0, start))
            when (rule.second) {
                "code" -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg, color = codeFg)) {
                    append(match.groupValues[1])
                }
                "bold" -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(match.groupValues[1]) }
                "italic" -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(match.groupValues[1]) }
                "strike" -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(match.groupValues[1]) }
                "link" -> {
                    val label = match.groupValues[1]
                    val url = match.groupValues[2]
                    if (url.startsWith("http://") || url.startsWith("https://")) {
                        withLink(
                            LinkAnnotation.Url(
                                url,
                                TextLinkStyles(
                                    SpanStyle(color = accent, textDecoration = TextDecoration.Underline),
                                ),
                            ),
                        ) { append(label) }
                    } else {
                        withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = accent)) { append(label) }
                    }
                }
            }
            rest = rest.substring(match.range.last + 1)
        }
        if (rest.isNotEmpty()) append(rest)
    }
}

/** 行内样式 → AnnotatedString（链接用 LinkAnnotation，点按走系统浏览器）。 */
@Composable
fun inlineMarkdown(text: String): AnnotatedString {
    val accent = accent
    val codeBg = MaterialTheme.colorScheme.surfaceVariant
    val codeFg = MaterialTheme.colorScheme.onSurface
    val memo = remember { InlineMemo() }
    return memo.resolve(text, accent, codeBg, codeFg)
}

/**
 * 流式文本最多约 25 次/秒推进到屏幕。历史消息（streaming=false）不延迟。
 * 调用顺序固定，streaming 切换时 remember 不能跳过。
 */
@Composable
internal fun rememberStreamingText(value: String, streaming: Boolean): String {
    val latest = rememberUpdatedState(value)
    var shown by remember { mutableStateOf(value) }
    LaunchedEffect(streaming) {
        if (!streaming) {
            shown = latest.value
            return@LaunchedEffect
        }
        snapshotFlow { latest.value }
            .conflate()
            .collect { next ->
                if (next != shown) shown = next
                delay(40)
            }
    }
    return if (streaming) shown else value
}

/** 行内纯文本（不含块结构）。 */
@Composable
fun MdInline(text: String, size: Int = 15, color: Color = MaterialTheme.colorScheme.onSurface, weight: FontWeight? = null) {
    Text(
        inlineMarkdown(text),
        fontSize = size.sp,
        lineHeight = (size * 1.55f).sp,
        color = color,
        fontWeight = weight,
    )
}

@Stable
private class ToastRef {
    var fn: (String) -> Unit = {}
}

/** 整段 Markdown 渲染。streaming 时合并 token，已收束的块不再整段重解析。 */
@Composable
fun MarkdownText(
    markdown: String,
    modifier: Modifier = Modifier,
    streaming: Boolean = false,
    onToast: (String) -> Unit = {},
) {
    val shown = rememberStreamingText(markdown, streaming)
    val toast = remember { ToastRef() }
    toast.fn = onToast
    MarkdownBlocks(shown, modifier, toast)
}

@Composable
private fun MarkdownBlocks(
    shown: String,
    modifier: Modifier,
    onToast: ToastRef,
) {
    val cache = remember { MdCache() }
    val blocks = remember(shown) { cache.resolve(shown) }
    if (blocks.isEmpty()) return
    val clipboard = LocalClipboardManager.current
    val hairlineColor = MaterialTheme.colorScheme.outlineVariant
    val dim = MaterialTheme.colorScheme.onSurfaceVariant

    Column(modifier.fillMaxWidth()) {
        blocks.forEachIndexed { index, block ->
            when (block) {
                is MdBlock.Heading -> {
                    val size = when (block.level) {
                        1 -> 19
                        2 -> 17
                        3 -> 16
                        else -> 15
                    }
                    if (index > 0) Spacer(Modifier.height(if (block.level <= 2) 10.dp else 6.dp))
                    Text(
                        inlineMarkdown(block.text),
                        fontSize = size.sp,
                        lineHeight = (size * 1.35f).sp,
                        fontWeight = FontWeight.Medium,
                        fontFamily = FontFamily.Serif,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }

                is MdBlock.Para -> {
                    if (index > 0) Spacer(Modifier.height(12.dp))
                    Text(
                        inlineMarkdown(block.text),
                        fontSize = 17.sp,
                        lineHeight = 28.sp,
                        fontFamily = FontFamily.Serif,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }

                is MdBlock.Item -> {
                    if (index > 0) Spacer(Modifier.height(2.dp))
                    Row(Modifier.fillMaxWidth().padding(start = (block.level * 14).dp)) {
                        Text(
                            block.marker,
                            fontSize = 14.sp,
                            lineHeight = 22.sp,
                            color = dim,
                            modifier = Modifier.width(if (block.marker.length > 1) 24.dp else 16.dp),
                        )
                        Text(
                            inlineMarkdown(block.text),
                            fontSize = 17.sp,
                            lineHeight = 26.sp,
                            fontFamily = FontFamily.Serif,
                            color = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }

                is MdBlock.Code -> {
                    if (index > 0) Spacer(Modifier.height(8.dp))
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)),
                    ) {
                        Row(
                            Modifier.fillMaxWidth().padding(start = 10.dp, end = 6.dp, top = 6.dp, bottom = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                block.lang.ifEmpty { "code" },
                                fontSize = 10.sp,
                                color = dim,
                                fontFamily = FontFamily.Monospace,
                                modifier = Modifier.weight(1f),
                            )
                            Row(
                                Modifier
                                    .clip(RoundedCornerShape(6.dp))
                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(Icons.Default.Check, null, tint = dim, modifier = Modifier.size(11.dp))
                                Spacer(Modifier.width(3.dp))
                                Text(
                                    "复制",
                                    fontSize = 10.sp,
                                    color = dim,
                                    modifier = Modifier
                                        .padding(2.dp)
                                        .noRippleClick {
                                            clipboard.setText(AnnotatedString(block.code))
                                            onToast.fn("代码已复制")
                                        },
                                )
                            }
                        }
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState())
                                .padding(start = 10.dp, end = 10.dp, bottom = 10.dp),
                        ) {
                            Text(
                                block.code,
                                fontSize = 12.sp,
                                lineHeight = 17.sp,
                                fontFamily = FontFamily.Monospace,
                                color = MaterialTheme.colorScheme.onSurface,
                                softWrap = false,
                            )
                        }
                    }
                }

                is MdBlock.Quote -> {
                    if (index > 0) Spacer(Modifier.height(6.dp))
                    Row(Modifier.fillMaxWidth()) {
                        Box(
                            Modifier
                                .width(3.dp)
                                .height(20.dp)
                                .clip(RoundedCornerShape(2.dp))
                                .background(MaterialTheme.colorScheme.outline),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            inlineMarkdown(block.text),
                            fontSize = 14.sp,
                            lineHeight = 21.sp,
                            color = dim,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }

                is MdBlock.Table -> {
                    if (index > 0) Spacer(Modifier.height(8.dp))
                    val weights = remember(block) { columnWeights(block) }
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f))
                            .padding(vertical = 4.dp),
                    ) {
                        TableRow(block.header, header = true, colors = dim, weights = weights)
                        Box(Modifier.fillMaxWidth().height(1.dp).background(hairlineColor))
                        block.rows.forEach { row ->
                            TableRow(row, header = false, colors = MaterialTheme.colorScheme.onSurface, weights = weights)
                        }
                    }
                }

                MdBlock.Rule -> {
                    Spacer(Modifier.height(10.dp))
                    Box(Modifier.fillMaxWidth().height(1.dp).background(hairlineColor))
                    Spacer(Modifier.height(10.dp))
                }
            }
        }
    }
}

/** 按各列最长内容估算宽度权重，避免等宽导致窄列被撑开、宽列被挤断。 */
private fun columnWeights(table: MdBlock.Table): List<Float> {
    val columns = maxOf(table.header.size, table.rows.maxOfOrNull { it.size } ?: 0)
    val widths = FloatArray(columns)
    fun measure(cells: List<String>) {
        cells.forEachIndexed { i, cell ->
            if (i >= columns) return@forEachIndexed
            var w = 0f
            for (ch in cell) w += if (ch.code < 0x2E80) 0.55f else 1f
            widths[i] = maxOf(widths[i], w)
        }
    }
    measure(table.header)
    table.rows.forEach(::measure)
    return widths.map { it.coerceIn(3f, 12f) }
}

@Composable
private fun TableRow(cells: List<String>, header: Boolean, colors: Color, weights: List<Float>) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 5.dp)) {
        if (cells.isEmpty()) return@Row
        cells.forEachIndexed { i, cell ->
            Text(
                inlineMarkdown(cell),
                fontSize = 12.sp,
                lineHeight = 17.sp,
                fontWeight = if (header) FontWeight.SemiBold else null,
                color = if (header) MaterialTheme.colorScheme.onSurfaceVariant else colors,
                modifier = Modifier.weight(weights.getOrElse(i) { 4f }).padding(end = 6.dp),
            )
        }
    }
}

private fun Modifier.noRippleClick(onClick: () -> Unit): Modifier = this.clickable(onClick = onClick)
