package org.lin0.relay

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun WorkspaceScreen(store: SummonStore, section: WorkspaceSection, onBack: () -> Unit, space: SummonReference? = null) {
    val scope = rememberCoroutineScope()
    val path = section.path + (space?.let { "?" + it.kind + "=" + SummonApiClient.component(it.id) }).orEmpty()
    var items by remember(path) { mutableStateOf<List<SummonJson>>(emptyList()) }
    var hosts by remember(path) { mutableStateOf<SummonJson>(SummonJson.Null) }
    var directories by remember(path) { mutableStateOf<List<SummonJson>>(emptyList()) }
    var detail by remember(path) { mutableStateOf<SummonReference?>(null) }
    var editor by remember(path) { mutableStateOf<EditorRoute?>(null) }
    var createBot by remember(path) { mutableStateOf(false) }
    var loading by remember(path) { mutableStateOf(false) }
    var error by remember(path) { mutableStateOf<String?>(null) }

    suspend fun reload() {
        if (loading || !store.protocolReady) return
        loading = true; error = null
        try {
            if (section == WorkspaceSection.Bots) store.refresh()
            else items = store.list(path)
            if (section == WorkspaceSection.Connections) {
                hosts = store.request("/api/connections")
                directories = store.list("/api/workspaces")
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.localizedMessage }
        finally { loading = false }
    }

    LaunchedEffect(path, store.protocolReady) { reload() }
    detail?.let { selected ->
        when (selected.kind) {
            "bot" -> BotDetailsScreen(store, selected.id) { detail = null }
            "session", "conversation" -> ExecutionDetail(store, selected) { detail = null }
            "file" -> FileDetail(store, selected, space?.takeIf { it.kind == "room" }) { detail = null }
            else -> ReferenceDetail(store, selected) { detail = null }
        }
        return
    }

    SummonDetailsPage(section.title, onBack) {
        Row {
            TextButton(enabled = !loading && store.protocolReady, onClick = { scope.launch { reload() } }) { Text("刷新") }
            if (store.protocolReady) when (section) {
                WorkspaceSection.Bots -> TextButton(onClick = { createBot = true }) { Text("创建 Bot") }
                WorkspaceSection.Executions -> if (space == null) TextButton(onClick = { editor = EditorRoute("execution") }) { Text("打开执行会话") }
                WorkspaceSection.Files -> TextButton(onClick = { editor = EditorRoute("file") }) { Text("新增资料") }
                WorkspaceSection.Wakeups -> TextButton(onClick = { editor = EditorRoute("wakeup") }) { Text("新增订阅或提醒") }
                WorkspaceSection.Connections -> {
                    TextButton(onClick = { editor = EditorRoute("connection") }) { Text("新增连接") }
                    TextButton(onClick = { editor = EditorRoute("directory") }) { Text("登记执行目录") }
                }
            }
        }
        if (loading) CircularProgressIndicator()
        error?.let { SummonError(it) }
        if (!store.protocolReady) store.protocolNotice?.let { SummonError(it) }
        when (section) {
            WorkspaceSection.Bots -> store.bots.forEach { bot ->
                TextButton(onClick = { detail = SummonReference("bot", bot.id) }) {
                    MemberAvatar(bot, 32.dp)
                    Text(bot.name + if (bot.isPaused) " · 已暂停" else "", Modifier.padding(start = 10.dp))
                }
            }
            WorkspaceSection.Executions -> items.forEach { item ->
                val ref = SummonReference.parse(item["execution_ref"]) ?: return@forEach
                SummonRecordRow(executionTitle(store, item),
                    summonStatus(item["status"].stringValue) + " · " + summonStatus(item["control"]["state"].stringValue)) { detail = ref }
            }
            WorkspaceSection.Files -> items.forEach { item ->
                val ref = SummonReference.parse(item["ref"]) ?: return@forEach
                SummonRecordRow(item["path"].string ?: store.label(ref), "修订 " + item["revision"].stringValue) { detail = ref }
            }
            WorkspaceSection.Wakeups -> {
                val (basic, extra) = items.partition { it["rule"]["kind"].string == "room_base" }
                WakeupRows(store, "基础关注", basic) { editor = EditorRoute("wakeup", it) }
                WakeupRows(store, "自定义订阅与提醒", extra) { editor = EditorRoute("wakeup", it) }
            }
            WorkspaceSection.Connections -> {
                Text("执行连接", style = MaterialTheme.typography.titleMedium)
                items.forEach { item ->
                    val id = item["id"].string ?: return@forEach
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = { detail = SummonReference("connection", id) }, modifier = Modifier.weight(1f)) { Text(item["name"].string ?: id) }
                        if (id != "pi" && item["revision"].int != null) {
                            TextButton(enabled = store.protocolReady, onClick = { editor = EditorRoute("connection", item) }) { Text("设置") }
                        }
                    }
                }
                Text("宿主额度", style = MaterialTheme.typography.titleMedium)
                hosts["limits"].obj.orEmpty().forEach { (key, limit) ->
                    val used = hosts["usage"][key].takeUnless { it == SummonJson.Null }?.stringValue
                    Text(resourceName(key) + " · " + (used?.let { "$it / " } ?: "") + limit.stringValue)
                }
                hosts["usage"]["resets_at"].string?.let { Text("本周期截止 · " + formatSummonDate(it, full = true)) }
                TextButton(enabled = store.protocolReady && hosts["limits_revision"].int != null,
                    onClick = { editor = EditorRoute("limits") }) { Text("编辑额度") }
                Text("执行目录", style = MaterialTheme.typography.titleMedium)
                directories.forEach { item ->
                    SummonRecordRow(item["name"].stringValue, item["path"].stringValue) {
                        if (store.protocolReady && item["revision"].int != null) editor = EditorRoute("directory", item)
                    }
                }
            }
        }
        if (!loading && items.isEmpty() && section in listOf(WorkspaceSection.Files, WorkspaceSection.Executions)) Text("暂无记录", color = Color.Gray)
    }

    if (createBot) CreateBotSheet(store, onOpenRoom = { }, onDismiss = { createBot = false })
    editor?.let { route ->
        val close = { editor = null; scope.launch { reload() }; Unit }
        when (route.kind) {
            "execution" -> ExecutionEditor(store, close)
            "file" -> FileEditor(store, space = space, close = close)
            "wakeup" -> WakeupEditor(store, route.record, space, close)
            "connection" -> ConnectionEditor(store, route.record, close)
            "directory" -> DirectoryEditor(store, route.record, close)
            "limits" -> LimitsEditor(store, close)
        }
    }
}

private data class EditorRoute(val kind: String, val record: SummonJson = SummonJson.Null)

@Composable
private fun WakeupRows(store: SummonStore, title: String, items: List<SummonJson>, onEdit: (SummonJson) -> Unit) {
    Text(title, style = MaterialTheme.typography.titleMedium)
    if (items.isEmpty()) Text("暂无规则", color = Color.Gray)
    items.forEach { item ->
        val rule = item["rule"]
        val name = when (rule["kind"].string) {
            "room_base" -> if (rule["mode"].string == "all") "所有消息" else "仅 @ 或回复"
            "time" -> formatSummonDate(rule["at"].string, full = true) +
                (rule["interval_ms"].int?.let { " · 每 " + (it / 60_000.0) + " 分钟" } ?: "")
            else -> listOfNotNull(rule["type"].string, rule["author"]["id"].string?.let(store::name), rule["room"].string).joinToString(" · ")
        }
        SummonRecordRow(store.name(item["bot_id"].stringValue) + " · " + name,
            if (item["enabled"].bool == true) "启用" else "已停用") { if (store.protocolReady) onEdit(item) }
    }
}

@Composable
private fun SummonRecordRow(title: String, subtitle: String, open: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = open).padding(9.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        if (subtitle.isNotEmpty()) Text(subtitle, color = Color.Gray, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun SummonReferencePicker(store: SummonStore, roomID: String, onSelect: (SummonReference) -> Unit, onDismiss: () -> Unit) {
    var files by remember(roomID) { mutableStateOf<List<SummonJson>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(roomID, store.protocolReady) {
        try { files = store.list("/api/files?room=" + SummonApiClient.component(roomID)) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.localizedMessage }
        finally { loading = false }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("引用资料") }, confirmButton = {
        TextButton(onClick = onDismiss) { Text("取消") }
    }, text = {
        Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
            if (loading) CircularProgressIndicator()
            error?.let { SummonError(it) }
            if (!loading && error == null && files.isEmpty()) Text("暂无可引用的群资料")
            files.forEach { file ->
                val ref = SummonReference.parse(file["ref"]) ?: return@forEach
                TextButton(onClick = { onSelect(ref) }) { Text(file["path"].string ?: store.label(ref)) }
            }
        }
    })
}

@Composable
fun SummonReferenceDialog(store: SummonStore, ref: SummonReference, close: () -> Unit) {
    androidx.compose.ui.window.Dialog(onDismissRequest = close, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            when (ref.kind) {
                "session", "conversation" -> ExecutionDetail(store, ref, close)
                "file" -> FileDetail(store, ref, null, close)
                "bot" -> BotDetailsScreen(store, ref.id, close)
                "room" -> RoomDetailsScreen(store, ref.id, close)
                else -> ReferenceDetail(store, ref, close)
            }
        }
    }
}

@Composable
private fun ReferenceDetail(store: SummonStore, ref: SummonReference, close: () -> Unit) {
    var detail by remember(ref) { mutableStateOf<SummonJson>(SummonJson.Null) }
    var error by remember(ref) { mutableStateOf<String?>(null) }
    LaunchedEffect(ref, store.protocolReady) {
        if (!store.protocolReady) return@LaunchedEffect
        try { detail = store.read(ref); error = null }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.localizedMessage }
    }
    SummonDetailsPage(store.label(ref), close) {
        error?.let { SummonError(it) }
        if (detail != SummonJson.Null) {
            if (ref.kind == "event") {
                Text(store.name(detail["senderId"].string ?: "platform"))
                SelectionContainer { Text(detail["content"].stringValue) }
                detail["mentions"].array.orEmpty().forEach { Text("@" + store.name(it.stringValue)) }
                detail["attachments"].array.orEmpty().map(SummonAttachment::parse).forEach { Text(it.name) }
            } else SelectionContainer { Text(detail.pretty, fontFamily = FontFamily.Monospace) }
        } else if (error == null && store.protocolReady) CircularProgressIndicator()
    }
}

@Composable
private fun FileDetail(store: SummonStore, ref: SummonReference, room: SummonReference?, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var value by remember(ref) { mutableStateOf<SummonJson>(SummonJson.Null) }
    var text by remember(ref) { mutableStateOf("") }
    var cursor by remember(ref) { mutableStateOf<String?>(null) }
    var editing by remember(ref) { mutableStateOf(false) }
    var nested by remember(ref) { mutableStateOf<SummonReference?>(null) }
    var busy by remember(ref) { mutableStateOf(false) }
    var error by remember(ref) { mutableStateOf<String?>(null) }

    fun run(action: suspend () -> Unit) {
        if (!store.protocolReady || busy) return
        busy = true; error = null
        scope.launch {
            try { action() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.localizedMessage }
            finally { busy = false }
        }
    }

    suspend fun load(append: Boolean = false) {
        val next = store.read(ref, if (append) cursor else null)
        if (append && value["revision"] != next["revision"]) throw SummonApiException("资料已修订，请刷新后读取。")
        value = next
        text = (if (append) text else "") + next["content"].string.orEmpty()
        cursor = next["next_cursor"].string
    }

    LaunchedEffect(ref, store.protocolReady) { run { load() } }
    SummonDetailsPage(value["name"].string ?: "资料", close) {
        value["path"].string?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
        value["revision"].int?.let { Text("修订 $it", color = Color.Gray) }
        if (busy) CircularProgressIndicator()
        error?.let { SummonError(it) }
        Row {
            TextButton(enabled = !busy && store.protocolReady, onClick = { run { load() } }) { Text("刷新") }
            if (value["url"].string != null) TextButton(enabled = !busy && store.protocolReady, onClick = {
                run {
                    val name = value["name"].string ?: "资料"
                    val file = if (value["url"].string?.startsWith("/api/attachments/") == true) {
                        store.attachmentFile(SummonAttachment.parse(value))
                    } else store.downloadFile(ref.id, name)
                    shareFile(context, file, value["mimeType"].string ?: "application/octet-stream")
                }
            }) { Text("下载文件") }
            if (cursor == null && value["path"].string != null && value["content"].string != null) {
                TextButton(enabled = !busy && store.protocolReady, onClick = { editing = true }) { Text("编辑资料") }
            }
        }
        room?.let { space ->
            val record = store.room(space.id)
            if (record != null) {
                val pinned = ref in record.pins
                TextButton(enabled = !busy && store.protocolReady, onClick = { run { store.setPin(ref, record, pinned) } }) {
                    Text(if (pinned) "取消置顶" else "在群里置顶")
                }
            }
        }
        val sources = value["sources"].array.orEmpty().mapNotNull(SummonReference::parse)
        if (sources.isNotEmpty()) Text("来源", style = MaterialTheme.typography.titleSmall)
        sources.forEach { source -> TextButton(onClick = { nested = source }) { Text(store.label(source)) } }
        if (text.isNotEmpty()) SelectionContainer { Text(text) }
        if (value["content_status"].string == "unavailable") Text("正文不可用", color = Color.Gray)
        if (cursor != null) TextButton(enabled = !busy && store.protocolReady, onClick = { run { load(true) } }) { Text("读取后续正文") }
    }
    if (editing) FileEditor(store, before = value, original = text, close = { editing = false; run { load() } })
    nested?.let { SummonReferenceDialog(store, it) { nested = null } }
}

private fun executionTitle(store: SummonStore, value: SummonJson): String {
    val title = if (value["kind"].string == "conversation") "内部对话" else value["engine"].string ?: "执行会话"
    return title + (value["bot_id"].string?.let { " · " + store.name(it) } ?: "")
}

@Composable
private fun ExecutionDetail(store: SummonStore, ref: SummonReference, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var detail by remember(ref) { mutableStateOf<SummonJson>(SummonJson.Null) }
    var pages by remember(ref) { mutableStateOf<List<SummonJson>>(emptyList()) }
    var stopResults by remember(ref) { mutableStateOf<List<SummonJson>>(emptyList()) }
    var pending by remember(ref) { mutableStateOf<ExecutionRequest?>(null) }
    var showStop by remember(ref) { mutableStateOf(false) }
    var busy by remember(ref) { mutableStateOf(false) }
    var error by remember(ref) { mutableStateOf<String?>(null) }
    var nested by remember(ref) { mutableStateOf<SummonReference?>(null) }

    fun run(work: suspend () -> Unit) {
        if (busy || !store.protocolReady) return
        busy = true; error = null
        scope.launch {
            try { work() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.localizedMessage }
            finally { busy = false }
        }
    }

    suspend fun load(append: Boolean = false) {
        val cursor = if (append) pages.lastOrNull()?.get("next_cursor")?.string else null
        val next = store.read(ref, cursor)
        detail = next
        if (!append) pages = listOf(next)
        else if (next["next_cursor"].string != cursor || next["output_page"]["text"].stringValue.isNotEmpty() ||
            next["messages"].array.orEmpty().isNotEmpty() || next["output_events"].array.orEmpty().isNotEmpty()) pages = pages + next
    }

    fun command(kind: String, input: SummonJson? = null, target: SummonJson? = null, stopScope: String? = null) {
        val version = detail["control_version"].int ?: return
        val execution = SummonReference.parse(detail["execution_ref"]) ?: return
        if (execution != ref || busy || !store.protocolReady) return
        val body = SummonJson.Obj(buildMap {
            put("target", execution.toJson()); put("control_version", version.numOrNull())
            if (kind == "stop" && stopScope != null) put("scope", SummonJson.Str(stopScope))
            else {
                put("kind", SummonJson.Str(kind))
                if (kind == "resume") put("resume_ref", detail["resume_ref"])
                else if (input != null && target != null) { put("input", input); put("input_target", target) }
            }
        })
        val request = pending?.takeIf { it.kind == kind && it.body == body } ?: ExecutionRequest(kind, body, SummonStore.newID())
        pending = request
        run {
            val result = store.request("/api/executions/" + (if (kind == "stop") "stop" else "input"), "POST", request.body, request.id)
            if (result["status"].string in listOf("unknown", "prepared", "not_submitted", "failed", "unsupported")) {
                error = summonStatus(result["status"].stringValue) + (result["call_id"].string?.let { " · " + it } ?: "")
            } else pending = null
            if (kind == "stop") stopResults = result["targets"].array.orEmpty()
            load()
        }
    }

    LaunchedEffect(ref, store.protocolReady) { run { load() } }
    SummonDetailsPage(if (detail == SummonJson.Null) store.label(ref) else executionTitle(store, detail), close) {
        Row {
            TextButton(enabled = !busy && store.protocolReady, onClick = { run { load() } }) { Text("刷新") }
            if (detail["can_stop"].bool == true && detail["control"]["state"].string != "paused") {
                TextButton(enabled = !busy && store.protocolReady, onClick = { showStop = true }) { Text("暂停并请求停止") }
            }
            if (detail["resume_ref"].obj != null && detail["control"]["stop_status"].string == "stopped") {
                TextButton(enabled = !busy && store.protocolReady, onClick = { command("resume") }) { Text("恢复控制") }
            }
        }
        if (busy) CircularProgressIndicator()
        error?.let { SummonError(it) }
        detail["status"].string?.let { Text("连接状态 · " + summonStatus(it)) }
        detail["control"]["state"].string?.let { Text("控制 · " + summonStatus(it)) }
        detail["control"]["stop_status"].string?.let { Text("停止结果 · " + summonStatus(it)) }
        (detail["execution_actor"]["id"].string ?: detail["bot_id"].string)?.let { Text("执行身份 · " + store.name(it)) }
        detail["submitted_by"]["id"].string?.let { Text("提交者 · " + store.name(it)) }
        detail["latest_call_id"].string?.let { id -> TextButton(onClick = { nested = SummonReference("call", id) }) { Text("调用 $id") } }
        if (detail["native"].obj != null) SelectionContainer { Text(detail["native"].pretty, fontFamily = FontFamily.Monospace) }
        stopResults.forEach { row ->
            val target = SummonReference.parse(row["target"]) ?: return@forEach
            Text(store.label(target) + " · " + summonStatus(row["control"]["stop_status"].stringValue))
        }
        SummonInputOption.options(detail).forEach { option ->
            key(detail["control_version"], option.kind, option.target) {
                NativeInput(option, busy || !store.protocolReady) { value -> command(option.kind, value, option.target) }
            }
        }
        if (pages.isNotEmpty()) Text("输入与输出", style = MaterialTheme.typography.titleMedium)
        pages.forEach { page ->
            val outputs = page["output_pages"].array ?: listOfNotNull(page["output_page"].takeUnless { it == SummonJson.Null })
            if (outputs.isEmpty() && page["output"] != SummonJson.Null) {
                SelectionContainer { Text(page["output"].string ?: page["output"].pretty, fontFamily = FontFamily.Monospace) }
            }
            outputs.forEach { output -> SelectionContainer { Text(output["text"].stringValue, fontFamily = FontFamily.Monospace) } }
            (page["messages"].array.orEmpty() + page["output_events"].array.orEmpty()).forEach { entry ->
                val message = entry["message"].takeUnless { it == SummonJson.Null } ?: entry
                val content = message["content"].array?.joinToString("\n") { it["text"].string ?: it.pretty }
                    ?: message["content"].string ?: message["text"].string ?: message.pretty
                Text(message["role"].string ?: entry["type"].string ?: "输出", style = MaterialTheme.typography.labelSmall, color = Color.Gray)
                SelectionContainer { Text(content, fontFamily = FontFamily.Monospace) }
            }
        }
        if (pages.lastOrNull()?.get("next_cursor")?.string != null) {
            TextButton(enabled = !busy && store.protocolReady, onClick = { run { load(append = true) } }) { Text("读取后续日志") }
        }
    }
    if (showStop) AlertDialog(onDismissRequest = { showStop = false }, title = { Text("选择停止范围") },
        confirmButton = { TextButton(onClick = { showStop = false; command("stop", stopScope = "target") }) { Text("当前目标") } },
        dismissButton = { TextButton(onClick = { showStop = false; command("stop", stopScope = "target_and_owned_calls") }) { Text("当前目标及其独占调用") } })
    nested?.let { SummonReferenceDialog(store, it) { nested = null } }
}

private data class ExecutionRequest(val kind: String, val body: SummonJson, val id: String)

@Composable
private fun NativeInput(option: SummonInputOption, disabled: Boolean, submit: (SummonJson) -> Unit) {
    var input by remember { mutableStateOf("") }
    var json by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    HorizontalDivider()
    Text(option.label, style = MaterialTheme.typography.titleMedium)
    val target = listOf("kind", "turn_id", "run_id", "instance_id", "launch_call_id", "call_id", "operation_id", "request_id", "input_revision")
        .mapNotNull { option.target[it].takeUnless { it == SummonJson.Null }?.stringValue }
    SelectionContainer { Text(target.joinToString(" · "), color = Color.Gray, style = MaterialTheme.typography.bodySmall) }
    option.question?.let { Text(it) }
    if (option.choices.isEmpty()) {
        SummonTextField("输入", input, { input = it }, multiline = true, enabled = !disabled)
        Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(checked = json, onCheckedChange = { json = it }); Text("JSON 输入") }
    } else SummonChoice("回答", input, option.choices.mapNotNull {
        it["id"].string?.let { id -> id to (it["label"].string ?: id) }
    }) { input = it }
    Button(enabled = !disabled && input.isNotBlank(), onClick = {
        try {
            val value = if (json) SummonJson.parse(input) else SummonJson.Str(input)
            error = null
            submit(value)
        } catch (_: Exception) { error = "JSON 输入格式无效。" }
    }) { Text(option.label) }
    error?.let { SummonError(it) }
}
