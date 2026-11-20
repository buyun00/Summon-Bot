package org.lin0.relay

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

fun parseSummonDate(value: String?): Instant? {
    if (value.isNullOrBlank()) return null
    return runCatching { java.time.OffsetDateTime.parse(value).toInstant() }
        .recoverCatching { Instant.parse(value) }
        .getOrNull()
}

private val fmtTime = DateTimeFormatter.ofPattern("HH:mm", Locale.SIMPLIFIED_CHINESE)
private val fmtWeekday = DateTimeFormatter.ofPattern("EEEE", Locale.SIMPLIFIED_CHINESE)
private val fmtMonthDay = DateTimeFormatter.ofPattern("M月d日", Locale.SIMPLIFIED_CHINESE)
private val fmtFull = DateTimeFormatter.ofPattern("M月d日 HH:mm", Locale.SIMPLIFIED_CHINESE)

fun formatSummonTime(value: String?): String {
    val instant = parseSummonDate(value) ?: return ""
    val zoned = instant.atZone(ZoneId.systemDefault())
    val date = zoned.toLocalDate()
    val today = LocalDate.now()
    return when {
        date == today -> fmtTime.format(zoned)
        date == today.minusDays(1) -> "昨天"
        date.isAfter(today.minusDays(7)) -> fmtWeekday.format(zoned)
        else -> fmtMonthDay.format(zoned)
    }
}

fun formatSummonDate(value: String?, full: Boolean = false): String {
    val instant = parseSummonDate(value) ?: return value ?: "—"
    val zoned = instant.atZone(ZoneId.systemDefault())
    return if (full) fmtFull.format(zoned) else fmtTime.format(zoned)
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

fun summonStatus(value: String): String = mapOf(
    "queued" to "等待投递", "pending" to "等待确认", "submitted" to "已提交", "accepted" to "已受理",
    "received" to "Bot 已接收", "processed" to "本轮已处理", "access_revoked" to "访问已撤销", "rejected" to "未受理",
    "running" to "运行中", "waiting" to "等待结果", "needs_input" to "待输入", "completed" to "执行已结束",
    "failed" to "失败", "cancelled" to "已取消", "active" to "启用", "paused" to "已暂停", "suspended" to "运行已挂起",
    "stopping" to "停止中", "stopped" to "已停止", "idle" to "空闲", "unknown" to "状态未知", "unsupported" to "连接不支持",
)[value] ?: value
