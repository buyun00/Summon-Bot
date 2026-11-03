package org.lin0.relay

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.URLEncoder
import java.text.NumberFormat
import java.util.Locale
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private fun usageNumber(value: SummonJson): String = (value as? SummonJson.Num)?.value?.let { NumberFormat.getIntegerInstance(Locale.CHINA).format(it) } ?: "—"
private fun usageRate(value: SummonJson): String = (value as? SummonJson.Num)?.value?.let { String.format(Locale.CHINA, "%.1f%%", it * 100) } ?: "—"
private fun usageAmount(value: SummonJson): String = (value as? SummonJson.Num)?.value?.let { String.format(Locale.CHINA, "%.4f", it) } ?: "—"
private fun usageTime(value: SummonJson): String = runCatching { Instant.parse(value.stringValue).atZone(ZoneId.of("Asia/Shanghai")).format(DateTimeFormatter.ofPattern("MM-dd HH:mm")) }.getOrDefault("—")
private val usagePurposes = mapOf("chat" to "聊天", "work" to "工作执行", "routing" to "群聊路由", "compress" to "上下文压缩", "compact" to "上下文压缩", "organize" to "记忆整理", "assemble" to "上下文组装", "other" to "其他调用")
private val usageStatuses = mapOf("succeeded" to "完成", "failed" to "失败", "cancelled" to "取消", "pending" to "调用中", "unknown" to "结果未知")

@Composable
fun TokenUsageScreen(store: SummonStore, onBack: () -> Unit) {
    var period by remember { mutableStateOf("today") }
    var dimension by remember { mutableStateOf("bots") }
    var sort by remember { mutableStateOf("totalTokens") }
    var sortMenu by remember { mutableStateOf(false) }
    var selectedKind by remember { mutableStateOf<String?>(null) }
    var selectedID by remember { mutableStateOf("") }
    var selectedName by remember { mutableStateOf("") }
    var offset by remember { mutableIntStateOf(0) }
    var revision by remember { mutableIntStateOf(0) }
    var overview by remember { mutableStateOf<SummonJson>(SummonJson.Null) }
    var detail by remember { mutableStateOf<SummonJson>(SummonJson.Null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(period, selectedKind, selectedID, offset, revision, store.settings.baseURL) {
        loading = true; error = null; detail = SummonJson.Null
        try {
            val result = withContext(Dispatchers.IO) {
                val client = SummonApiClient(SummonApiClient.normalized(store.settings.baseURL), store.savedToken)
                val all = client.requestJson("/api/usage?period=$period&limit=25")
                val filter = selectedKind?.let { "&${if (it == "bot") "botId" else "roomId"}=${URLEncoder.encode(selectedID, "UTF-8")}" }.orEmpty()
                val current = if (selectedKind == null && offset == 0) all else client.requestJson("/api/usage?period=$period&limit=25&offset=$offset$filter")
                all to current
            }
            overview = result.first; detail = result.second
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            error = failure.message ?: "暂时无法读取统计。"
        } finally { loading = false }
    }
    val ranking = (if (dimension == "bots") overview["bots"].array.orEmpty() else overview["rooms"].array.orEmpty().filter {
        if (dimension == "dm") it["kind"].stringValue == "dm" else it["kind"].stringValue !in listOf("dm", "unassigned")
    }).sortedByDescending { (it[sort] as? SummonJson.Num)?.value ?: 0.0 }
    Scaffold(containerColor = Color.Black, topBar = {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
            Text("Token 统计", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = { revision++ }, enabled = !loading) { Text("刷新") }
        }
    }) { padding ->
        LazyColumn(Modifier.padding(padding), contentPadding = androidx.compose.foundation.layout.PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            item {
                Row(Modifier.horizontalScroll(rememberScrollState())) {
                    listOf("today" to "今天", "yesterday" to "昨天", "7d" to "近 7 天", "all" to "累计").forEach { (id, title) ->
                        TextButton(onClick = { period = id; selectedKind = null; offset = 0; overview = SummonJson.Null; detail = SummonJson.Null }) { Text(if (period == id) "● $title" else title) }
                    }
                }
            }
            if (loading) item { CircularProgressIndicator() }
            error?.let { item { Text(it, color = Color(0xFFFF9F0A)) } }
            items(overview["providerReports"].array.orEmpty()) { report ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("${report["day"].stringValue} · 供应商用量对照", style = MaterialTheme.typography.titleMedium)
                    Text("DeepSeek · ${report["billingLabel"].stringValue} · 用户截图人工记录", color = Color(0xFF8E8E93), style = MaterialTheme.typography.bodySmall)
                    UsageLine("截图请求 / Token", "${usageNumber(report["calls"])} / ${usageNumber(report["totalTokens"])}")
                    UsageLine("截图消费 · CNY", "¥${(report["amount"] as? SummonJson.Num)?.value?.let { String.format(Locale.CHINA, "%.2f", it) }.orEmpty()}")
                    UsageLine("本机请求 / Token", "${usageNumber(report["localCalls"])} / ${usageNumber(report["localTokens"])}")
                    UsageLine("差额 · 请求 / Token", "${usageNumber(report["differenceCalls"])} / ${usageNumber(report["differenceTokens"])}")
                    Text("本机明细覆盖 ${usageRate(report["tokenCoverage"])}。缺失部分未分摊到 Bot 或会话，不能据此计算全天缓存命中率。", style = MaterialTheme.typography.bodySmall, color = Color(0xFF8E8E93))
                }
            }
            if (overview["coverage"]["includesUntrackedHistory"].bool == true) item {
                Text("采集启用前只回填仍保留的调用，历史已清理部分无法追溯。", style = MaterialTheme.typography.bodySmall, color = Color(0xFFFF9F0A))
            }
            item { Text("本机已记录用量", style = MaterialTheme.typography.titleMedium); UsageTotals(overview["totals"]) }
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    listOf("bots" to "Bot", "dm" to "单聊", "group" to "群聊").forEach { (id, title) ->
                        TextButton(onClick = { dimension = id; selectedKind = null; offset = 0 }) { Text(if (dimension == id) "● $title" else title) }
                    }
                    androidx.compose.foundation.layout.Box {
                        TextButton(onClick = { sortMenu = true }) { Text("排序") }
                        DropdownMenu(expanded = sortMenu, onDismissRequest = { sortMenu = false }) {
                            listOf("totalTokens" to "Token", "costMax" to "参考费用", "cacheMissTokens" to "缓存未命中", "calls" to "调用次数").forEach { (id, title) ->
                                DropdownMenuItem(text = { Text(title) }, onClick = { sort = id; sortMenu = false })
                            }
                        }
                    }
                }
            }
            items(ranking) { row ->
                Column(Modifier.fillMaxWidth().clickable { selectedKind = if (dimension == "bots") "bot" else "room"; selectedID = row["id"].stringValue; selectedName = row["name"].stringValue; offset = 0 }.padding(vertical = 8.dp)) {
                    UsageLine(row["name"].stringValue, "${usageNumber(row["totalTokens"])} Token")
                    Text("输入 ${usageNumber(row["inputTokens"])} / 输出 ${usageNumber(row["outputTokens"])} · 命中 ${usageRate(row["cacheHitRate"])} · ${usageNumber(row["calls"])} 次", color = Color(0xFF8E8E93), style = MaterialTheme.typography.bodySmall)
                }
            }
            item {
                HorizontalDivider(); Text(selectedKind?.let { selectedName } ?: "全部调用明细", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp))
                if (selectedKind != null) { TextButton(onClick = { selectedKind = null; offset = 0 }) { Text("查看全部") }; UsageTotals(detail["totals"]) }
            }
            if ((detail["totals"]["unreportedCalls"].int ?: 0) > 0) item { Text("部分调用没有完整 Token 回执，缺失部分不按零消耗计算。", color = Color(0xFFFF9F0A), style = MaterialTheme.typography.bodySmall) }
            listOf("purposes" to "消耗来源", "models" to "模型", "days" to "每日用量").forEach { (key, title) ->
                item { Text(title, style = MaterialTheme.typography.titleSmall) }
                items(detail[key].array.orEmpty()) { row -> UsageLine(if (key == "purposes") usagePurposes[row["key"].stringValue] ?: row["key"].stringValue else row["key"].stringValue, "${usageNumber(row["totalTokens"])} · ${usageNumber(row["calls"])} 次") }
            }
            item { Text("逐次调用", style = MaterialTheme.typography.titleMedium) }
            items(detail["requests"].array.orEmpty()) { request ->
                var expanded by remember(request["botId"].stringValue, request["id"].stringValue) { mutableStateOf(false) }
                Column(Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    UsageLine("${request["botName"].stringValue} · ${usagePurposes[request["purpose"].stringValue] ?: request["purpose"].stringValue}", usageNumber(request["totalTokens"]))
                    Text("${usageTime(request["startedAt"])} · ${usageStatuses[request["status"].stringValue] ?: request["status"].stringValue}", style = MaterialTheme.typography.bodySmall, color = Color(0xFF8E8E93))
                    if (expanded) {
                        UsageLine("模型", request["model"].stringValue)
                        UsageLine("输入 / 输出", "${usageNumber(request["inputTokens"])} / ${usageNumber(request["outputTokens"])}")
                        UsageLine("缓存命中 / 未命中", "${usageNumber(request["cacheHitTokens"])} / ${usageNumber(request["cacheMissTokens"])}")
                        UsageLine("推理 Token（包含在输出内）", usageNumber(request["reasoningTokens"]))
                        if (request["error"].stringValue.isNotBlank()) Text(request["error"].stringValue, color = Color(0xFFFF9F0A), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { offset = (offset - 25).coerceAtLeast(0) }, enabled = offset > 0 && !loading) { Text("上一页") }
                    TextButton(onClick = { offset += 25 }, enabled = detail["hasMore"].bool == true && !loading) { Text("下一页") }
                }
                Text("命中率只代表留存明细。输入缓存与输出分别统计，推理 Token 包含在输出内。USD 参考费与截图 CNY 消费不直接比较。", color = Color(0xFF8E8E93), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun UsageLine(title: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun UsageTotals(totals: SummonJson) {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp), modifier = Modifier.padding(vertical = 10.dp)) {
        UsageLine("输入 / 输出", "${usageNumber(totals["inputTokens"])} / ${usageNumber(totals["outputTokens"])}")
        UsageLine("输入缓存命中 / 未命中", "${usageNumber(totals["cacheHitTokens"])} / ${usageNumber(totals["cacheMissTokens"])}")
        UsageLine("留存明细缓存命中率", usageRate(totals["cacheHitRate"]))
        UsageLine("API 调用", usageNumber(totals["calls"]))
        UsageLine("参考费 · USD", if ((totals["pricedCalls"].int ?: 0) > 0) "${usageAmount(totals["costMin"])}–${usageAmount(totals["costMax"])}" else "—")
    }
}
