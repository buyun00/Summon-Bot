package org.lin0.relay

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.roundToInt

private val modelGreen = Color(0xFF93AD99)
private fun SummonJson.modelNumber(): Double? = (this as? SummonJson.Num)?.value?.takeIf { it.isFinite() }
private fun modelMoney(value: SummonJson): String {
    val amount = value["amount"].modelNumber() ?: return "—"
    return runCatching { NumberFormat.getCurrencyInstance(Locale.CHINA).apply { currency = Currency.getInstance(value["currency"].stringValue.ifBlank { "USD" }); maximumFractionDigits = 2 }.format(amount) }.getOrElse { "$amount ${value["currency"].stringValue}" }
}
private class ModelBrandCatalog(context: android.content.Context) {
    private val data = SummonJson.parse(context.assets.open("ai-brands.json").bufferedReader().use { it.readText() })
    fun brand(item: SummonJson): String {
        if (item["role"].stringValue == "executor") return if (item["kind"].stringValue.contains("claude")) "claudecode" else "codex"
        val model = item["model"].stringValue.lowercase()
        for (rule in data["models"].array.orEmpty()) {
            val pair = rule.array.orEmpty()
            if (pair.size == 2 && Regex(pair[0].stringValue).containsMatchIn(model)) return pair[1].stringValue
        }
        for (key in listOf("provider", "kind")) data["aliases"][item[key].stringValue.lowercase()].string?.let { return it }
        val host = runCatching { java.net.URI(item["baseUrl"].stringValue).host?.lowercase() }.getOrNull()
        for (entry in data["hosts"].array.orEmpty()) { val pair = entry.array.orEmpty(); if (pair.size == 2 && (host == pair[0].stringValue || host?.endsWith(".${pair[0].stringValue}") == true)) return pair[1].stringValue }
        return "ai"
    }
}
@Composable private fun ModelBrand(item: SummonJson, modifier: Modifier = Modifier.size(24.dp)) {
    val context = LocalContext.current
    val catalog = remember(context) { ModelBrandCatalog(context) }
    val brand = catalog.brand(item)
    val resource = remember(brand) { context.resources.getIdentifier("ai_$brand", "drawable", context.packageName) }
    Image(painterResource(if (resource != 0) resource else R.drawable.ai_ai), null, modifier, colorFilter = ColorFilter.tint(modelGreen))
}
private data class ModelGaugeData(val ring: Double?, val dots: Int?, val value: String)
private fun modelGauge(item: SummonJson): ModelGaugeData {
    val usage = item["usage"]
    val windows = usage["windows"].array.orEmpty().filter { it["remainingPercent"].modelNumber() != null }
    val main = windows.firstOrNull { it["durationMinutes"].int == 10080 } ?: windows.firstOrNull()
    val short = windows.firstOrNull { it["durationMinutes"].int == 300 && it != main }
    val money = usage["balances"].array.orEmpty() + listOfNotNull(usage["balance"].takeIf { it is SummonJson.Obj })
    if (item["kind"].stringValue == "api") return ModelGaugeData(100.0, null, money.firstOrNull { it["currency"].stringValue == "CNY" }?.let(::modelMoney) ?: money.firstOrNull()?.let(::modelMoney) ?: "—")
    val percent = main?.get("remainingPercent")?.modelNumber()?.coerceIn(0.0, 100.0)
    return ModelGaugeData(percent, short?.let { ceil((it["remainingPercent"].modelNumber() ?: 0.0).coerceIn(0.0, 100.0) / 25).toInt() }, if (short != null) "" else percent?.let { "${it.roundToInt()}%" } ?: "—")
}
@Composable fun ModelQuotaSignal(item: SummonJson, label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val gauge = modelGauge(item)
    Column(modifier.clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick).padding(vertical = 3.dp).semantics { contentDescription = "$label ${item["name"].stringValue} ${gauge.value}，查看额度" }, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(64.dp, 59.dp)) {
            Canvas(Modifier.fillMaxSize()) {
                val scale = size.width / 64f
                val stroke = Stroke(3.2f * scale, cap = StrokeCap.Round)
                val top = androidx.compose.ui.geometry.Offset(9f * scale, 6f * scale)
                val circle = androidx.compose.ui.geometry.Size(46f * scale, 46f * scale)
                drawArc(Color(0xFF3B443D), 135f, 270f, false, top, circle, style = stroke)
                gauge.ring?.let { drawArc(if (it < 10) Color(0xFFD3A074) else modelGreen, 135f, (270 * it / 100).toFloat(), false, top, circle, style = stroke) }
                gauge.dots?.let { dots -> listOf(21f to 49f, 28.5f to 51.5f, 35.5f to 51.5f, 43f to 49f).forEachIndexed { index, (x, y) -> drawCircle(if (index < dots) modelGreen else Color(0xFF3B443D), 1.9f * scale, androidx.compose.ui.geometry.Offset(x * scale, y * scale)) } }
            }
            ModelBrand(item, Modifier.align(Alignment.TopCenter).padding(top = 16.dp).size(24.dp))
            if (gauge.value.isNotEmpty()) Text(gauge.value, modifier = Modifier.align(Alignment.TopCenter).padding(top = 43.dp), color = modelGreen, fontSize = 11.sp)
        }
        Text(label, color = modelGreen, fontSize = 10.sp, letterSpacing = 1.sp)
    }
}
@Composable fun ModelUsageDetails(item: SummonJson) {
    val usage = item["usage"]
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        ModelBrand(item, Modifier.size(32.dp))
        Column { Text(item["name"].stringValue.ifBlank { "模型与引擎" }, style = MaterialTheme.typography.titleMedium); Text(item["model"].stringValue, color = Color.Gray, style = MaterialTheme.typography.bodySmall) }
    }
    (usage["balances"].array.orEmpty() + listOfNotNull(usage["balance"].takeIf { it is SummonJson.Obj })).forEach { Text(modelMoney(it), style = MaterialTheme.typography.headlineSmall, color = modelGreen) }
    usage["windows"].array.orEmpty().forEach { window ->
        val remaining = window["remainingPercent"].modelNumber()
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(window["name"].stringValue); Text(remaining?.let { "${it.roundToInt()}% 剩余" } ?: "—", color = modelGreen) }
        if (remaining != null) LinearProgressIndicator(progress = { (remaining / 100).coerceIn(0.0, 1.0).toFloat() }, modifier = Modifier.fillMaxWidth(), color = modelGreen)
        if (window["resetsAt"].stringValue.isNotBlank()) Text("重置：${window["resetsAt"].stringValue}", color = Color.Gray, style = MaterialTheme.typography.bodySmall)
    }
    if (usage["credits"].modelNumber() != null) Text("附加点数 ${usage["credits"].stringValue} credits", color = Color.Gray, style = MaterialTheme.typography.bodySmall)
    if (usage["unlimited"].bool == true) Text("额外额度不设限", color = modelGreen)
    if (usage["status"].stringValue == "error") Text(if (usage["stale"].bool == true) "上次读取 · 当前暂未更新" else usage["error"].stringValue, color = Color(0xFFD3A074))
    else if (usage["windows"].array.orEmpty().isEmpty() && usage["balances"].array.orEmpty().isEmpty() && usage["balance"] !is SummonJson.Obj) Text("供应商未返回额度数值", color = Color.Gray)
    if (usage["checkedAt"].stringValue.isNotBlank()) Text("更新于 ${usage["checkedAt"].stringValue}", color = Color.Gray, style = MaterialTheme.typography.bodySmall)
}

@Composable fun ModelSettingsScreen(store: SummonStore, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current
    var data by remember { mutableStateOf<SummonJson>(SummonJson.Null) }
    var draft by remember { mutableStateOf<SummonJson>(SummonJson.Null) }
    var login by remember { mutableStateOf<SummonJson>(SummonJson.Null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    suspend fun reload() { data = store.request("/api/model-settings"); if (draft !is SummonJson.Obj) draft = data["connections"].array.orEmpty().firstOrNull { it["active"].bool == true } ?: SummonJson.Null; store.refreshModelUsage() }
    fun perform(block: suspend () -> Unit) { if (!busy) scope.launch { busy = true; error = null; try { block() } catch (e: Exception) { if (e is CancellationException) throw e; error = e.localizedMessage } finally { busy = false } } }
    LaunchedEffect(store.settings.baseURL) { try { reload() } catch (e: Exception) { if (e is CancellationException) throw e; error = e.localizedMessage } }
    LaunchedEffect(login["id"].stringValue, login["status"].stringValue) {
        if (login["status"].stringValue in listOf("starting", "waiting")) {
            try { while (isActive) { delay(2000); val result = store.request("/api/model-settings/connections/${SummonApiClient.component(login["id"].stringValue)}/login"); login = result; if (result["status"].stringValue !in listOf("starting", "waiting")) { if (result["status"].stringValue == "completed") reload(); break } } } catch (e: Exception) { if (e is CancellationException) throw e; error = e.localizedMessage }
        }
    }
    Scaffold(topBar = { Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { TextButton(onClick = onBack) { Text("返回") }; Text("模型与引擎", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium); TextButton(enabled = !busy, onClick = { perform { store.refreshModelUsage(true); reload() } }) { Text("刷新") } } }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            error?.let { Text(it, color = Color(0xFFD3A074)) }
            listOf(store.modelSummary["chat"], store.modelSummary["executors"].array.orEmpty().firstOrNull() ?: SummonJson.Null).filter { it is SummonJson.Obj }.forEach { item ->
                Surface(shape = RoundedCornerShape(18.dp), color = Color(0xFF1C231E)) { Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { ModelUsageDetails(item) } }
            }
            Text("聊天模型连接", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                listOf("codex" to "Codex 订阅", "grok" to "Grok 订阅", "api" to "通用 API").forEach { (kind, title) -> TextButton(enabled = !busy, onClick = { draft = SummonJson.obj("kind" to SummonJson.Str(kind), "name" to SummonJson.Str(title), "model" to SummonJson.Str(when(kind) { "codex" -> "gpt-6-luna"; "grok" -> "grok-4.7"; else -> "" })); login = SummonJson.Null }) { Text("+ $title", fontSize = 12.sp) } }
            }
            data["connections"].array.orEmpty().forEach { item ->
                Surface(shape = RoundedCornerShape(12.dp), color = if (draft["id"].stringValue == item["id"].stringValue) Color(0xFF24362A) else Color(0xFF1C1C1E), modifier = Modifier.fillMaxWidth().clickable { draft = item; login = SummonJson.Null }) {
                    Row(Modifier.padding(14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) { ModelBrand(item); Column(Modifier.weight(1f)) { Text(item["name"].stringValue); Text(item["model"].stringValue, color = Color.Gray, fontSize = 12.sp) }; if (item["active"].bool == true) Text("当前", color = modelGreen) }
                }
            }
            if (draft is SummonJson.Obj) {
                val selected = data["connections"].array.orEmpty().firstOrNull { it["id"].stringValue == draft["id"].stringValue } ?: SummonJson.Null
                key(draft["id"].stringValue, draft["kind"].stringValue, selected["configured"].bool) {
                    ModelConnectionForm(draft, selected, data["presets"].array.orEmpty(), busy,
                        onSave = { payload -> perform {
                            val oldIds = data["connections"].array.orEmpty().map { it["id"].stringValue }.toSet()
                            data = store.request("/api/model-settings/connections", "POST", payload)
                            val entry = data["connections"].array.orEmpty().first { if (payload["id"].stringValue.isNotEmpty()) it["id"].stringValue == payload["id"].stringValue else it["id"].stringValue !in oldIds }
                            draft = entry
                            val id = entry["id"].stringValue
                            if (entry["kind"].stringValue == "api") data = store.request("/api/model-settings/active", "POST", SummonJson.obj("id" to SummonJson.Str(id)))
                            else if (entry["configured"].bool != true) login = store.request("/api/model-settings/connections/${SummonApiClient.component(id)}/login", "POST", SummonJson.obj())
                            store.refreshModelUsage(true)
                        } },
                        onImport = { perform { data = store.request("/api/model-settings/local/import", "POST", SummonJson.obj("kind" to draft["kind"])); draft = data["connections"].array.orEmpty().first { it["id"].stringValue == data["importedId"].stringValue }; store.refreshModelUsage(true) } },
                        onAuthorize = { perform { login = store.request("/api/model-settings/connections/${SummonApiClient.component(selected["id"].stringValue)}/login", "POST", SummonJson.obj()) } },
                        onActivate = { perform { data = store.request("/api/model-settings/active", "POST", SummonJson.obj("id" to selected["id"])); store.refreshModelUsage(true) } },
                        onRemove = { perform { data = store.request("/api/model-settings/connections/${SummonApiClient.component(selected["id"].stringValue)}", "DELETE"); draft = data["connections"].array.orEmpty().firstOrNull { it["active"].bool == true } ?: SummonJson.Null; store.refreshModelUsage(true) } },
                        onDiscover = { store.request("/api/model-settings/connections/${SummonApiClient.component(selected["id"].stringValue)}/models?discover=1")["models"].array.orEmpty() })
                }
            }
            if (login["status"].stringValue in listOf("starting", "waiting")) {
                Text("订阅授权", style = MaterialTheme.typography.titleMedium)
                Text(login["userCode"].stringValue, style = MaterialTheme.typography.headlineMedium)
                if (login["verificationUri"].stringValue.isNotBlank()) Button(onClick = { uriHandler.openUri(login["verificationUri"].stringValue) }) { Text("打开授权页面") }
                TextButton(onClick = { perform { login = store.request("/api/model-settings/connections/${SummonApiClient.component(login["id"].stringValue)}/login", "DELETE") } }) { Text("取消授权") }
            }
            if (login["error"].stringValue.isNotBlank()) Text(login["error"].stringValue, color = Color(0xFFD3A074))
            Text("聊天模型由所有 Bot 共用，额度按账号显示。", color = Color.Gray, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable private fun ModelConnectionForm(entry: SummonJson, selected: SummonJson, presets: List<SummonJson>, busy: Boolean, onSave: (SummonJson) -> Unit, onImport: () -> Unit, onAuthorize: () -> Unit, onActivate: () -> Unit, onRemove: () -> Unit, onDiscover: suspend () -> List<SummonJson>) {
    val scope = rememberCoroutineScope()
    val kind = entry["kind"].stringValue
    var fields by remember { mutableStateOf(entry.obj.orEmpty().toMutableMap().apply {
        putIfAbsent("provider", SummonJson.Str("openai-compatible")); putIfAbsent("api", SummonJson.Str("openai-completions")); putIfAbsent("thinkingLevel", SummonJson.Str("off")); putIfAbsent("contextWindow", SummonJson.Num(if (kind == "codex") 1050000.0 else if (kind == "grok") 500000.0 else 128000.0)); putIfAbsent("maxTokens", SummonJson.Num(8192.0)); put("apiKey", SummonJson.Str(""))
    }.toMap()) }
    var choices by remember { mutableStateOf<List<SummonJson>>(emptyList()) }
    var localError by remember { mutableStateOf<String?>(null) }
    fun set(key: String, value: SummonJson) { fields = fields + (key to value) }
    @Composable fun field(title: String, key: String, secret: Boolean = false) {
        OutlinedTextField(value = fields[key]?.stringValue.orEmpty(), onValueChange = { set(key, SummonJson.Str(it)) }, label = { Text(title) }, singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth(), visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None)
    }
    field("连接名称", "name")
    if (kind == "api") {
        ModelChoice("服务商", fields["provider"]?.stringValue.orEmpty(), presets.map { it["id"].stringValue to it["name"].stringValue }) { id -> val preset = presets.first { it["id"].stringValue == id }; fields = fields + mapOf("provider" to preset["id"], "api" to preset["api"], "baseUrl" to preset["baseUrl"]) }
        ModelChoice("接口协议", fields["api"]?.stringValue.orEmpty(), listOf("openai-completions" to "OpenAI Chat Completions", "openai-responses" to "OpenAI Responses", "anthropic-messages" to "Anthropic Messages")) { set("api", SummonJson.Str(it)) }
        field("API 地址", "baseUrl"); field(if (selected["configured"].bool == true) "API Key（留空保留）" else "API Key", "apiKey", true)
        Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(checked = fields["allowNoKey"]?.bool == true, onCheckedChange = { set("allowNoKey", SummonJson.Bool(it)) }); Text("这个服务无需 API Key") }
    } else {
        Text(if (selected["configured"].bool == true) "订阅已连接" else "保存后通过设备码授权", color = modelGreen)
        if (selected !is SummonJson.Obj) TextButton(enabled = !busy, onClick = onImport) { Text("导入服务器上的 ${if (kind == "codex") "Codex" else "Grok"} 登录") }
        if (selected is SummonJson.Obj && selected["authMode"].stringValue !in setOf("codex-local", "grok-local")) TextButton(enabled = !busy, onClick = onAuthorize) { Text("授权订阅") }
    }
    field("聊天模型 ID", "model")
    if (selected is SummonJson.Obj) TextButton(enabled = !busy, onClick = { scope.launch { try { choices = onDiscover() } catch (e: Exception) { localError = e.localizedMessage } } }) { Text("获取模型目录") }
    if (choices.isNotEmpty()) ModelChoice("选择模型", fields["model"]?.stringValue.orEmpty(), choices.map { it["id"].stringValue to it["name"].stringValue.ifBlank { it["id"].stringValue } }) { set("model", SummonJson.Str(it)) }
    ModelChoice("思考强度", fields["thinkingLevel"]?.stringValue.orEmpty(), listOf("off" to "关闭 / 默认快速", "low" to "低", "medium" to "中", "high" to "高", "xhigh" to "很高", "max" to "最高")) { set("thinkingLevel", SummonJson.Str(it)) }
    field("上下文上限 · Token", "contextWindow"); field("输出上限 · Token", "maxTokens")
    if (kind == "api") { field("余额查询路径（可选）", "balancePath"); field("余额 JSON 字段（可选）", "balanceField"); field("余额币种（默认 USD）", "balanceCurrency") }
    localError?.let { Text(it, color = Color(0xFFD3A074)) }
    Button(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = { onSave(SummonJson.Obj(fields - listOf("usage", "identity", "configured", "active") + mapOf("contextWindow" to SummonJson.Num(fields["contextWindow"]?.stringValue?.toDoubleOrNull() ?: 128000.0), "maxTokens" to SummonJson.Num(fields["maxTokens"]?.stringValue?.toDoubleOrNull() ?: 8192.0)))) }) { Text(if (busy) "正在保存…" else "保存配置") }
    if (selected["configured"].bool == true && selected["active"].bool != true) Button(enabled = !busy, onClick = onActivate) { Text("用于 Pi 聊天") }
    if (selected is SummonJson.Obj && selected["active"].bool != true) TextButton(enabled = !busy, onClick = onRemove) { Text("移除此连接") }
}
@Composable private fun ModelChoice(title: String, current: String, choices: List<Pair<String, String>>, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box { OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) { Text("$title：${choices.firstOrNull { it.first == current }?.second ?: current}") }; DropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.heightIn(max = 300.dp)) { choices.forEach { (id, name) -> DropdownMenuItem(text = { Text(name) }, onClick = { open = false; onSelect(id) }) } } }
}
