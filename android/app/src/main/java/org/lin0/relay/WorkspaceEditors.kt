package org.lin0.relay

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.Instant

@Composable
internal fun SummonChoice(label: String, value: String, choices: List<Pair<String, String>>, update: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column {
        val selected = choices.firstOrNull { it.first == value }?.second ?: value.ifEmpty { "请选择" }
        TextButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) { Text("$label · $selected") }
        DropdownMenu(expanded, { expanded = false }, modifier = Modifier.heightIn(max = 320.dp)) {
            choices.forEach { (id, text) ->
                DropdownMenuItem(text = { Text(text) }, onClick = { update(id); expanded = false })
            }
        }
    }
}

@Composable
private fun SummonEditDialog(
    store: SummonStore, title: String, close: () -> Unit, valid: Boolean = true,
    load: (suspend () -> Unit)? = null, save: suspend () -> Unit,
    fields: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(load != null) }
    var loaded by remember { mutableStateOf(load == null) }
    var retry by remember { mutableStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(retry, store.protocolReady) {
        if (load == null || !store.protocolReady) { busy = false; return@LaunchedEffect }
        busy = true; error = null
        try { load(); loaded = true }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.localizedMessage }
        finally { busy = false }
    }
    AlertDialog(onDismissRequest = { if (!busy) close() }, title = { Text(title) }, text = {
        Column(Modifier.heightIn(max = 500.dp).verticalScroll(rememberScrollState())) {
            fields()
            if (busy) CircularProgressIndicator()
            error?.let { SummonError(it) }
        }
    }, confirmButton = {
        TextButton(enabled = !busy && store.protocolReady && (valid || !loaded), onClick = {
            if (!loaded) { retry++; return@TextButton }
            busy = true; error = null
            scope.launch {
                try { save(); close() }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) { error = failure.localizedMessage }
                finally { busy = false }
            }
        }) { Text(if (loaded) "保存" else "重新加载") }
    }, dismissButton = { TextButton(enabled = !busy, onClick = close) { Text("取消") } })
}

@Composable
internal fun ExecutionEditor(store: SummonStore, close: () -> Unit) {
    var engines by remember { mutableStateOf<List<SummonJson>>(emptyList()) }
    var directories by remember { mutableStateOf<List<SummonJson>>(emptyList()) }
    var engine by remember { mutableStateOf("") }
    var workspace by remember { mutableStateOf("") }
    var input by remember { mutableStateOf("") }
    var json by remember { mutableStateOf(false) }
    val requestID = remember(engine, workspace, input, json) { SummonStore.newID() }
    SummonEditDialog(store, "打开执行会话", close, valid = engine.isNotBlank() && input.isNotBlank(), load = {
        engines = store.list("/api/connections").filter { it["id"].string != "pi" && it["available"].bool != false }
        directories = store.list("/api/workspaces")
        if (engine.isEmpty()) engine = engines.firstOrNull()?.get("id")?.string.orEmpty()
    }, save = {
        val payload = SummonJson.Obj(buildMap {
            put("engine", SummonJson.Str(engine))
            put("input", if (json) SummonJson.parse(input) else SummonJson.Str(input))
            if (workspace.isNotEmpty()) put("workspace", SummonReference("workspace", workspace).toJson())
        })
        store.request("/api/executions", "POST", payload, requestID)
    }) {
        SummonChoice("连接", engine, engines.choices()) { engine = it }
        SummonChoice("执行目录", workspace, listOf("" to "选择目录") + directories.choices()) { workspace = it }
        SummonToggle("JSON 输入", json) { json = it }
        SummonTextField("输入", input, { input = it }, multiline = true)
    }
}

@Composable
internal fun FileEditor(store: SummonStore, space: SummonReference? = null, before: SummonJson = SummonJson.Null,
                        original: String = "", close: () -> Unit) {
    var selection by remember(before, space) { mutableStateOf(space ?: SummonReference.parse(before["space"])) }
    var path by remember(before) { mutableStateOf(before["path"].string.orEmpty()) }
    var text by remember(before, original) { mutableStateOf(original) }
    val spaces = store.rooms.map { SummonReference("room", it.id) to it.name } +
        store.bots.map { SummonReference("bot", it.id) to (it.name + " 的私有资料") }
    SummonEditDialog(store, if (before == SummonJson.Null) "新增资料" else "编辑资料", close,
        valid = path.isNotBlank() && selection != null, save = {
            val target = selection ?: return@SummonEditDialog
            val body = SummonJson.Obj(buildMap {
                put("space", target.toJson())
                put("path", SummonJson.Str(path.trim()))
                put("content_or_source", SummonJson.Str(text))
                before["revision"].int?.let {
                    put("revision", it.numOrNull())
                    if (before["sources"].array != null) put("sources", before["sources"])
                }
            })
            store.request("/api/files", "POST", body, SummonStore.newID())
        }) {
        if (before == SummonJson.Null && space == null) {
            val key = selection?.let { it.kind + ":" + it.id }.orEmpty()
            SummonChoice("资料空间", key, spaces.map { (ref, name) -> (ref.kind + ":" + ref.id) to name }) { chosen ->
                selection = spaces.firstOrNull { (ref, _) -> ref.kind + ":" + ref.id == chosen }?.first
            }
        }
        SummonTextField("文件路径", path, { path = it }, enabled = before == SummonJson.Null)
        SummonTextField("正文", text, { text = it }, multiline = true)
    }
}

@Composable
internal fun WakeupEditor(store: SummonStore, item: SummonJson, space: SummonReference?, close: () -> Unit) {
    val rule = item["rule"]
    val room = space?.takeIf { it.kind == "room" }?.let { store.room(it.id) }
    val bots = if (room != null) store.bots.filter { it.id in room.members } else store.bots
    var botID by remember(item) { mutableStateOf(item["bot_id"].string ?: space?.takeIf { it.kind == "bot" }?.id ?: bots.firstOrNull()?.id.orEmpty()) }
    var kind by remember(item) { mutableStateOf(rule["kind"].string ?: "event") }
    var roomID by remember(item) { mutableStateOf(rule["room"].string ?: rule["room"]["id"].string ?: rule["scope"]["id"].string ?: room?.id.orEmpty()) }
    var mode by remember(item) { mutableStateOf(rule["mode"].string ?: "all") }
    var eventType by remember(item) { mutableStateOf(rule["type"].string ?: "message") }
    var author by remember(item) { mutableStateOf(rule["author"]["id"].string.orEmpty()) }
    var at by remember(item) { mutableStateOf(initialWakeupTime(rule["at"].string)) }
    var interval by remember(item) { mutableStateOf(rule["interval_ms"].int?.let { (it / 60_000.0).toString() }.orEmpty()) }
    var enabled by remember(item) { mutableStateOf(item["enabled"].bool ?: true) }

    SummonEditDialog(store, if (item == SummonJson.Null) "新增订阅或提醒" else "编辑订阅", close, valid = botID.isNotEmpty(), save = {
        val settings = SummonJson.Obj(buildMap {
            put("kind", SummonJson.Str(kind))
            when (kind) {
                "room_base" -> { put("room", SummonJson.Str(roomID)); put("mode", SummonJson.Str(mode)) }
                "time" -> {
                    val purpose = try { parseWakeupTime(at) }
                    catch (_: Exception) { throw SummonApiException("请输入有效的提醒时间。") }
                    put("at", SummonJson.Str(purpose.toString()))
                    if (interval.isNotBlank()) {
                        val minutes = interval.toDoubleOrNull()
                        if (minutes == null || !minutes.isFinite() || minutes < 1 || minutes > 9_007_199_254_740_991.0 / 60_000) {
                            throw SummonApiException("请输入有效的重复间隔。")
                        }
                        put("interval_ms", SummonJson.Num(kotlin.math.round(minutes * 60_000)))
                    }
                    if (roomID.isNotEmpty()) put("scope", SummonReference("room", roomID).toJson())
                    else if (rule["scope"].obj != null && rule["scope"]["kind"].string != "room") put("scope", rule["scope"])
                }
                else -> {
                    put("type", SummonJson.Str(eventType.trim()))
                    if (roomID.isNotEmpty()) put("room", SummonJson.Str(roomID))
                    if (author.isNotEmpty()) put("author", SummonReference(if (author == "user") "user" else "bot", author).toJson())
                    if (rule["ref"].obj != null) put("ref", rule["ref"])
                }
            }
        })
        val body = SummonJson.Obj(buildMap {
            put("bot", SummonJson.Str(botID)); put("event_or_time", settings); put("enabled", SummonJson.Bool(enabled))
            item["id"].string?.let { put("id", SummonJson.Str(it)); put("revision", item["revision"]) }
        })
        store.request("/api/wakeups", "POST", body, SummonStore.newID())
    }) {
        if (item == SummonJson.Null) {
            SummonChoice("接收 Bot", botID, bots.map { it.id to it.name }) { botID = it }
            SummonChoice("类型", kind, listOf("event" to "事件订阅", "time" to "定时提醒")) { kind = it }
        }
        if (kind == "room_base") {
            SummonChoice("关注范围", mode, listOf("all" to "所有消息", "mentions" to "仅 @ 或回复")) { mode = it }
        } else {
            if (room == null) SummonChoice("会话范围", roomID, listOf("" to "全部可访问空间") + store.rooms.map { it.id to it.name }) { roomID = it }
            if (kind == "time") {
                SummonTextField("提醒时间（年-月-日 时:分）", at, { at = it })
                SummonTextField("重复间隔（分钟，可选）", interval, { interval = it })
            } else {
                SummonTextField("事件类型", eventType, { eventType = it })
                SummonChoice("作者", author, listOf("" to "任意", "user" to store.settings.userName) + bots.map { it.id to it.name }) { author = it }
            }
        }
        SummonToggle("启用", enabled) { enabled = it }
    }
}

private val wakeupTimeFormat = java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm")
    .withResolverStyle(java.time.format.ResolverStyle.STRICT)

private fun initialWakeupTime(value: String?): String =
    (parseSummonDate(value) ?: Instant.now()).atZone(java.time.ZoneId.systemDefault()).format(wakeupTimeFormat)

private fun parseWakeupTime(value: String): Instant =
    java.time.LocalDateTime.parse(value.trim(), wakeupTimeFormat).atZone(java.time.ZoneId.systemDefault()).toInstant()

@Composable
internal fun ConnectionEditor(store: SummonStore, item: SummonJson, close: () -> Unit) {
    var name by remember(item) { mutableStateOf(item["name"].string.orEmpty()) }
    var description by remember(item) { mutableStateOf(item["description"].string.orEmpty()) }
    var kind by remember(item) { mutableStateOf("codex") }
    var config by remember(item) { mutableStateOf("{}") }
    var enabled by remember(item) { mutableStateOf(item["enabled"].bool ?: true) }
    var allowed by remember(item) { mutableStateOf(item["allowed_bot_ids"].array.orEmpty().mapNotNull { it.string }.toSet()) }
    SummonEditDialog(store, if (item == SummonJson.Null) "新增连接" else "执行连接设置", close, name.isNotBlank(), save = {
        val body = mutableMapOf<String, SummonJson>(
            "name" to SummonJson.Str(name.trim()), "description" to SummonJson.Str(description),
            "enabled" to SummonJson.Bool(enabled), "allowed_bot_ids" to allowed.sorted().toJsonStrings(),
        )
        val id = item["id"].string
        if (id != null) {
            body["revision"] = item["revision"]
            store.request("/api/connections/" + SummonApiClient.component(id), "PATCH", SummonJson.Obj(body))
        } else {
            val value = SummonJson.parse(config)
            if (value.obj == null) throw SummonApiException("连接配置需要一个 JSON 对象。")
            body["kind"] = SummonJson.Str(kind); body["config"] = value
            store.request("/api/connections", "POST", SummonJson.Obj(body))
        }
    }) {
        SummonTextField("名称", name, { name = it })
        SummonTextField("说明", description, { description = it })
        if (item == SummonJson.Null) {
            SummonChoice("协议", kind, listOf("codex", "cli", "mcp", "http").map { it to it }) { kind = it }
            SummonTextField("连接配置 JSON", config, { config = it }, multiline = true)
        }
        SummonToggle("启用", enabled) { enabled = it }
        SummonResourceSelection("允许使用的 Bot", store.bots.map(SummonBot::toJson), allowed) { allowed = it }
    }
}

@Composable
internal fun DirectoryEditor(store: SummonStore, item: SummonJson, close: () -> Unit) {
    var name by remember(item) { mutableStateOf(item["name"].string.orEmpty()) }
    var path by remember(item) { mutableStateOf(item["path"].string.orEmpty()) }
    var write by remember(item) { mutableStateOf(item["write"].bool ?: false) }
    SummonEditDialog(store, if (item == SummonJson.Null) "登记执行目录" else "编辑执行目录", close, name.isNotBlank() && path.isNotBlank(), save = {
        val id = item["id"].string
        val body = SummonJson.Obj(buildMap {
            put("name", SummonJson.Str(name.trim())); put("path", SummonJson.Str(path.trim())); put("write", SummonJson.Bool(write))
            if (id != null) put("revision", item["revision"])
        })
        store.request(if (id == null) "/api/workspaces" else "/api/workspaces/" + SummonApiClient.component(id), if (id == null) "POST" else "PATCH", body)
    }) {
        SummonTextField("目录名称", name, { name = it })
        SummonTextField("绝对路径", path, { path = it })
        SummonToggle("允许写入", write) { write = it }
    }
}

@Composable
internal fun LimitsEditor(store: SummonStore, close: () -> Unit) {
    var revision by remember { mutableStateOf<SummonJson>(SummonJson.Null) }
    var values by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    SummonEditDialog(store, "宿主额度", close, revision.int != null, load = {
        val response = store.request("/api/connections/limits")
        revision = response["revision"]
        values = response["limits"].obj.orEmpty().mapValues { it.value.stringValue }
    }, save = {
        val limits = values.mapValues { (key, text) ->
            val value = text.trim().toLongOrNull()
            if (value == null || value < (if (key == "period_ms") 1000L else 0L) || value > 9_007_199_254_740_991L) {
                throw SummonApiException("请输入有效的 " + resourceName(key))
            }
            SummonJson.Num(value.toDouble())
        }
        store.request("/api/connections/limits", "PATCH", SummonJson.obj("revision" to revision, "limits" to SummonJson.Obj(limits)))
    }) {
        values.toSortedMap().forEach { (key, value) -> SummonTextField(resourceName(key), value, { values = values + (key to it) }) }
    }
}

@Composable
private fun SummonToggle(label: String, enabled: Boolean, update: (Boolean) -> Unit) {
    Row(Modifier.padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(enabled, update)
        Text(label)
    }
}

internal fun resourceName(key: String): String = mapOf(
    "bots" to "Bot 数量", "sessions" to "活动会话", "models" to "并发模型请求", "external" to "并发外部执行",
    "queue" to "待处理事件", "reserved_calls" to "回执容量", "period_ms" to "周期（毫秒）", "calls" to "调用次数",
    "tokens" to "Token", "active_ms" to "活跃时间（毫秒）",
)[key] ?: key

private fun List<SummonJson>.choices(): List<Pair<String, String>> =
    mapNotNull { item -> item["id"].string?.let { id -> id to (item["name"].string ?: id) } }
