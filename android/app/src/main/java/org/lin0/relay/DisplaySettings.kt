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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Typography
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt

class RelayDisplayPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("RelayNative.display", Context.MODE_PRIVATE)
    var zoom by mutableStateOf(prefs.getInt("zoom", 100).coerceIn(50, 160))
        private set
    var font by mutableStateOf(prefs.getInt("font", 100).coerceIn(90, 160))
        private set

    fun setZoom(value: Int) {
        zoom = value.coerceIn(50, 160)
        prefs.edit().putInt("zoom", zoom).apply()
    }

    fun setFont(value: Int) {
        font = value.coerceIn(90, 160)
        prefs.edit().putInt("font", font).apply()
    }

    fun reset() { setZoom(100); setFont(100) }
}

val LocalRelayDisplay = staticCompositionLocalOf<RelayDisplayPreferences> { error("Display preferences unavailable") }

val relayTypography = Typography().let { base ->
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
fun RelayDisplay(preferences: RelayDisplayPreferences, content: @Composable () -> Unit) {
    val density = LocalDensity.current
    CompositionLocalProvider(
        LocalRelayDisplay provides preferences,
        LocalDensity provides Density(density.density * preferences.zoom / 100f, density.fontScale * preferences.font / 100f),
        content = content,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DisplaySettingsControls() {
    val display = LocalRelayDisplay.current
    Text("界面缩放  ${display.zoom}%", style = MaterialTheme.typography.titleSmall)
    Text("一起调整头像、控件、间距与文字的大小。", style = MaterialTheme.typography.bodySmall)
    Slider(value = display.zoom.toFloat(), onValueChange = { display.setZoom(it.roundToInt()) },
        valueRange = 50f..160f, steps = 109, modifier = Modifier.semantics { contentDescription = "界面缩放" })
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("紧凑 85%" to 85, "默认 100%" to 100, "宽松 115%" to 115).forEach { (title, value) ->
            TextButton(onClick = { display.setZoom(value) }) { Text(title) }
        }
    }
    Spacer(Modifier.height(16.dp))
    Text("文字大小  ${display.font}%", style = MaterialTheme.typography.titleSmall)
    Text("统一调整聊天、统计、管理页面及操作记录的文字大小，同时保留系统文字大小设置。", style = MaterialTheme.typography.bodySmall)
    Slider(value = display.font.toFloat(), onValueChange = { display.setFont((it / 5).roundToInt() * 5) },
        valueRange = 90f..160f, steps = 13, modifier = Modifier.semantics { contentDescription = "文字大小" })
    Spacer(Modifier.height(16.dp))
    Text("显示效果预览", style = MaterialTheme.typography.titleSmall)
    Text("聊天内容、工具调用与操作结果", style = MaterialTheme.typography.bodyLarge)
    Text("Bot 正在读取文件…", style = MaterialTheme.typography.bodySmall)
    Text("即时生效并保存到当前设备，手机和电脑分别设置。", style = MaterialTheme.typography.bodySmall)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DisplaySettingsSheet(onDismiss: () -> Unit) {
    val display = LocalRelayDisplay.current
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("显示设置", style = MaterialTheme.typography.titleLarge)
            DisplaySettingsControls()
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(onClick = { display.reset() }) { Text("恢复默认") }
                TextButton(onClick = onDismiss) { Text("完成") }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
