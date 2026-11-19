package org.lin0.relay

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Typography
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt

enum class SummonAppearance(val key: String, val label: String) {
    System("system", "跟随系统"),
    Light("light", "浅色"),
    Dark("dark", "深色");

    companion object {
        fun fromKey(value: String?): SummonAppearance =
            entries.firstOrNull { it.key == value } ?: System
    }
}

@Immutable
data class SummonPalette(
    val isDark: Boolean,
    val background: Color,
    val surface: Color,
    val surfaceElevated: Color,
    val glassPill: Color,
    val botBubble: Color,
    val userBubble: Color,
    val userBubbleText: Color,
    val bubbleStroke: Color,
    val hairline: Color,
    val textSecondary: Color,
    val textTertiary: Color,
    val ok: Color,
    val warn: Color,
    val codeBg: Color,
    val quoteBg: Color,
    val quotaTrack: Color,
    val selectionBg: Color,
)

val LightSummonPalette = SummonPalette(
    isDark = false,
    background = Color(0xFFF8F6F1),
    surface = Color(0xFFF1EEE7),
    surfaceElevated = Color(0xFFFFFDF8),
    glassPill = Color(0xEEF5F2EA),
    botBubble = Color(0xFFF0ECE4),
    userBubble = Color(0xFF252320),
    userBubbleText = Color(0xFFFAF8F4),
    bubbleStroke = Color(0x14000000),
    hairline = Color(0x12000000),
    textSecondary = Color(0xFF6B675E),
    textTertiary = Color(0xFF989388),
    ok = Color(0xFF5F7B6A),
    warn = Color(0xFFC67D3B),
    codeBg = Color(0xFFE9E4DA),
    quoteBg = Color(0x0D000000),
    quotaTrack = Color(0x1C000000),
    selectionBg = Color(0x1E5F7B6A),
)

val DarkSummonPalette = SummonPalette(
    isDark = true,
    background = Color(0xFF0B0C10),
    surface = Color(0xFF151720),
    surfaceElevated = Color(0xFF1C202B),
    glassPill = Color(0xE01B1E29),
    botBubble = Color(0xE8181B25),
    userBubble = Color(0xF22E3444),
    userBubbleText = Color(0xFFF2F4F8),
    bubbleStroke = Color(0x21FFFFFF),
    hairline = Color(0x17FFFFFF),
    textSecondary = Color(0xFFA2A8BA),
    textTertiary = Color(0xFF6E7486),
    ok = Color(0xFF7FC2A0),
    warn = Color(0xFFE3A764),
    codeBg = Color(0xFF101219),
    quoteBg = Color(0x14FFFFFF),
    quotaTrack = Color(0x26FFFFFF),
    selectionBg = Color(0x2B7FC2A0),
)

val LocalSummonIsDark = staticCompositionLocalOf { false }
val LocalSummonPalette = staticCompositionLocalOf { LightSummonPalette }

class SummonDisplayPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("SummonNative.display", Context.MODE_PRIVATE)
    var zoom by mutableStateOf(prefs.getInt("zoom", 100).coerceIn(50, 160))
        private set
    var font by mutableStateOf(prefs.getInt("font", 100).coerceIn(90, 160))
        private set
    var appearance by mutableStateOf(SummonAppearance.fromKey(prefs.getString("appearance", SummonAppearance.System.key)))
        private set

    fun updateZoom(value: Int) {
        zoom = value.coerceIn(50, 160)
        prefs.edit().putInt("zoom", zoom).apply()
    }

    fun updateFont(value: Int) {
        font = value.coerceIn(90, 160)
        prefs.edit().putInt("font", font).apply()
    }

    fun updateAppearance(value: SummonAppearance) {
        appearance = value
        prefs.edit().putString("appearance", value.key).apply()
    }

    fun reset() { updateZoom(100); updateFont(100); updateAppearance(SummonAppearance.System) }
}

val LocalSummonDisplay = staticCompositionLocalOf<SummonDisplayPreferences> { error("Display preferences unavailable") }

val summonTypography = Typography().let { base ->
    base.copy(
        bodyLarge = base.bodyLarge.copy(fontSize = 17.sp, lineHeight = 28.sp),
        bodyMedium = base.bodyMedium.copy(fontSize = 16.sp, lineHeight = 26.sp),
        bodySmall = base.bodySmall.copy(fontSize = 14.sp, lineHeight = 22.sp),
        titleLarge = base.titleLarge.copy(fontSize = 26.sp, lineHeight = 34.sp),
        titleMedium = base.titleMedium.copy(fontSize = 20.sp, lineHeight = 28.sp),
        titleSmall = base.titleSmall.copy(fontSize = 17.sp, lineHeight = 24.sp),
        labelLarge = base.labelLarge.copy(fontSize = 16.sp, lineHeight = 24.sp),
        labelMedium = base.labelMedium.copy(fontSize = 13.sp, lineHeight = 20.sp),
        labelSmall = base.labelSmall.copy(fontSize = 13.sp, lineHeight = 20.sp),
    )
}

@Composable
fun SummonDisplay(preferences: SummonDisplayPreferences, content: @Composable () -> Unit) {
    val density = LocalDensity.current
    CompositionLocalProvider(
        LocalSummonDisplay provides preferences,
        LocalDensity provides Density(density.density * preferences.zoom / 100f, density.fontScale * preferences.font / 100f),
        content = content,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DisplaySettingsControls() {
    val display = LocalSummonDisplay.current
    val palette = LocalSummonPalette.current
    Text("外观模式", style = MaterialTheme.typography.titleSmall)
    Text("浅色与深色模式均使用系统原生半透明材质，Bot 头像会自动切换纸片与暗色玻璃质感。", style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        SummonAppearance.entries.forEach { mode ->
            FilterChip(
                selected = display.appearance == mode,
                onClick = { display.updateAppearance(mode) },
                label = { Text(mode.label) },
            )
        }
    }
    Spacer(Modifier.height(12.dp))
    Text("界面缩放  ${display.zoom}%", style = MaterialTheme.typography.titleSmall)
    Text("一起调整头像、控件、间距与文字的大小。", style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
    Slider(value = display.zoom.toFloat(), onValueChange = { display.updateZoom(it.roundToInt()) },
        valueRange = 50f..160f, steps = 109, modifier = Modifier.semantics { contentDescription = "界面缩放" })
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("紧凑 85%" to 85, "默认 100%" to 100, "宽松 115%" to 115).forEach { (title, value) ->
            TextButton(onClick = { display.updateZoom(value) }) { Text(title) }
        }
    }
    Spacer(Modifier.height(16.dp))
    Text("文字大小  ${display.font}%", style = MaterialTheme.typography.titleSmall)
    Text("统一调整聊天、统计、管理页面及操作记录的文字大小，同时保留系统文字大小设置。", style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
    Slider(value = display.font.toFloat(), onValueChange = { display.updateFont((it / 5).roundToInt() * 5) },
        valueRange = 90f..160f, steps = 13, modifier = Modifier.semantics { contentDescription = "文字大小" })
    Spacer(Modifier.height(16.dp))
    Text("显示效果预览", style = MaterialTheme.typography.titleSmall)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        BotAvatar("nuage", "#867399", size = 40.dp, motion = "idle")
        Column {
            Text("聊天内容、工具调用与操作结果", style = MaterialTheme.typography.bodyLarge)
            Text("Bot 正在读取文件…", style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
        }
    }
    Text("即时生效并保存到当前设备，手机和电脑分别设置。", style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DisplaySettingsSheet(onDismiss: () -> Unit) {
    val display = LocalSummonDisplay.current
    val palette = LocalSummonPalette.current
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = palette.surfaceElevated,
    ) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("显示与外观", style = MaterialTheme.typography.titleLarge)
            DisplaySettingsControls()
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(onClick = { display.reset() }) { Text("恢复默认") }
                TextButton(onClick = onDismiss) { Text("完成") }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
