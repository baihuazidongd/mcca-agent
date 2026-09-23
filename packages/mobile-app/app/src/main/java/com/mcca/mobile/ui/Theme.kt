package com.mcca.mobile.ui

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

/**
 * 暖中性底 + 陶土强调色，接近 Claude 的阅读感：
 * 浅色是米纸，深色是暖炭灰，正文近黑但不发青。
 */
val AccentDark = Color(0xFFD97757)
val AccentLight = Color(0xFFC96442)
val Blue = Color(0xFF8A8478)
val Violet = Color(0xFF8A7568)
val Amber = Color(0xFFC4843A)
val Danger = Color(0xFFC4504A)

/** 深浅底：深色不用纯黑，浅色不用纯白，减少对比疲劳。 */
private val DarkColors = darkColorScheme(
    primary = AccentDark,
    onPrimary = Color(0xFF2A120C),
    primaryContainer = Color(0xFF4A2C24),
    onPrimaryContainer = Color(0xFFF6E6DF),
    secondary = Blue,
    onSecondary = Color(0xFF1C1B18),
    secondaryContainer = Color(0xFF3A3834),
    onSecondaryContainer = Color(0xFFE8E4DA),
    tertiary = Violet,
    onTertiary = Color(0xFF1C1B18),
    background = Color(0xFF262624),
    onBackground = Color(0xFFF4F1EA),
    surface = Color(0xFF30302E),
    onSurface = Color(0xFFF4F1EA),
    surfaceVariant = Color(0xFF3A3935),
    onSurfaceVariant = Color(0xFFA8A59C),
    surfaceContainer = Color(0xFF2C2C2A),
    surfaceContainerHigh = Color(0xFF333330),
    surfaceContainerHighest = Color(0xFF3A3935),
    outline = Color(0xFF4A4944),
    outlineVariant = Color(0xFF35342F),
    error = Danger,
    onError = Color(0xFF2A0D0D),
    errorContainer = Color(0xFF3A221F),
    onErrorContainer = Color(0xFFFFDAD7),
)

private val LightColors = lightColorScheme(
    primary = AccentLight,
    onPrimary = Color(0xFFFFFBF8),
    primaryContainer = Color(0xFFF3E3DB),
    onPrimaryContainer = Color(0xFF3D241C),
    secondary = Color(0xFF6B655C),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFEDE9E0),
    onSecondaryContainer = Color(0xFF2C2924),
    tertiary = Color(0xFF7A6A60),
    onTertiary = Color.White,
    background = Color(0xFFFAF9F5),
    onBackground = Color(0xFF141413),
    surface = Color(0xFFF7F6F2),
    onSurface = Color(0xFF141413),
    surfaceVariant = Color(0xFFF0EEE6),
    onSurfaceVariant = Color(0xFF6B6960),
    surfaceContainer = Color(0xFFF3F1EA),
    surfaceContainerHigh = Color(0xFFEDEBE3),
    surfaceContainerHighest = Color(0xFFE6E4DB),
    outline = Color(0xFFE4E1D6),
    outlineVariant = Color(0xFFECEAE2),
    error = Color(0xFFB5453E),
    onError = Color.White,
    errorContainer = Color(0xFFF8E6E3),
    onErrorContainer = Color(0xFF4A1612),
)

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

private val AppTypography = Typography(
    titleLarge = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Normal, letterSpacing = (-0.3).sp),
    titleMedium = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Medium, letterSpacing = (-0.2).sp),
    bodyLarge = TextStyle(fontSize = 17.sp, lineHeight = 28.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 23.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 12.sp),
    labelSmall = TextStyle(fontSize = 11.sp),
)

@Composable
fun MccaTheme(themeMode: String, content: @Composable () -> Unit) {
    val dark = when (themeMode) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }
    val scheme = if (dark) DarkColors else LightColors
    val view = LocalView.current
    val context = LocalContext.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (context as? Activity)?.window ?: return@SideEffect
            window.statusBarColor = scheme.background.value.toInt()
            window.navigationBarColor = scheme.background.value.toInt()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !dark
            WindowCompat.getInsetsController(window, view).isAppearanceLightNavigationBars = !dark
        }
    }
    MaterialTheme(colorScheme = scheme, typography = AppTypography, shapes = AppShapes, content = content)
}

val accent: Color
    @Composable get() = MaterialTheme.colorScheme.primary

/** 分隔线：比 outline 再淡一档，列表里只做「提示」，不抢视线。 */
val hairline: Color
    @Composable get() = MaterialTheme.colorScheme.outlineVariant

/** 运行中/等待类状态统一用琥珀，失败用红，其余中性。 */
fun statusColor(status: String, running: Boolean): Color = when {
    running -> Amber
    status == "error" -> Danger
    else -> Color.Unspecified
}
