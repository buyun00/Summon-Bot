package org.lin0.relay

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

fun parseRelayDate(value: String?): Instant? {
    if (value.isNullOrBlank()) return null
    return runCatching { java.time.OffsetDateTime.parse(value).toInstant() }
        .recoverCatching { Instant.parse(value) }
        .getOrNull()
}

fun formatRelayTime(value: String?): String {
    val instant = parseRelayDate(value) ?: return ""
    val zoned = instant.atZone(ZoneId.systemDefault())
    val date = zoned.toLocalDate()
    val today = LocalDate.now()
    return when {
        date == today -> DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT).withLocale(Locale.getDefault()).format(zoned)
        date == today.minusDays(1) -> "昨天"
        else -> DateTimeFormatter.ofPattern("M月d日").format(zoned)
    }
}

fun formatRelayDate(value: String?, full: Boolean = false): String {
    val instant = parseRelayDate(value) ?: return value ?: "—"
    val zoned = instant.atZone(ZoneId.systemDefault())
    return if (full) {
        DateTimeFormatter.ofPattern("M月d日 HH:mm").format(zoned)
    } else {
        DateTimeFormatter.ofPattern("HH:mm").format(zoned)
    }
}

fun formatBytes(size: Int): String {
    val units = arrayOf("B", "KB", "MB", "GB")
    var value = size.toDouble()
    var index = 0
    while (value >= 1000 && index < units.lastIndex) {
        value /= 1000
        index += 1
    }
    val shown = if (index == 0) size.toString() else if (value >= 10) "%.0f".format(value) else "%.1f".format(value)
    return "$shown ${units[index]}"
}

fun relayStatus(value: String): String = mapOf(
    "queued" to "等待执行", "running" to "进行中", "waiting" to "等待答复",
    "completed" to "已完成", "failed" to "失败", "cancelled" to "已取消",
    "interrupted" to "已中断", "active" to "活跃", "paused" to "已暂停",
    "concluded" to "已结束",
)[value] ?: value

fun workspaceStatus(value: String): String = mapOf(
    "queued" to "等待执行", "running" to "进行中", "waiting" to "待答复", "completed" to "已完成",
    "failed" to "失败", "cancelled" to "已取消", "interrupted" to "已中断", "active" to "有效",
    "expired" to "已过期", "disputed" to "有争议", "fact" to "事实", "hypothesis" to "假设",
    "opinion" to "观点", "unverified" to "待核查", "accepted" to "已接收",
)[value] ?: value
