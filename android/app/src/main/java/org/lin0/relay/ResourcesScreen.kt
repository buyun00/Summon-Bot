package org.lin0.relay

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun ResourcesScreen(store: SummonStore, section: ResourceSection, onBack: () -> Unit, space: SummonReference? = null) {
    val scope = rememberCoroutineScope()
    val path = section.path + (space?.let { "?" + it.kind + "=" + SummonApiClient.component(it.id) }).orEmpty()
    var items by remember(path) { mutableStateOf<List<SummonJson>>(emptyList()) }
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
            if (section == ResourceSection.Bots) store.refresh()
            else if (section == ResourceSection.Connections) {
                items = store.request("/api/engines")["items"].array.orEmpty()
                directories = store.list("/api/workspaces")
            } else items = store.list(path)
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
                ResourceSection.Bots -> TextButton(onClick = { createBot = true }) { Text("创建 Bot") }
                ResourceSection.Executions -> if (space == null) TextButton(onClick = { editor = EditorRoute("execution") }) { Text("打开执行会话") }
                ResourceSection.Files -> TextButton(onClick = { editor = EditorRoute("file") }) { Text("新增资料") }
                ResourceSection.Wakeups -> TextButton(onClick = { editor = EditorRoute("wakeup") }) { Text("新增订阅或提醒") }
                ResourceSection.Connections -> {
                    TextButton(onClick = { editor = EditorRoute("directory") }) { Text("登记执行目录") }
                }
            }
        }
        if (loading) CircularProgressIndicator()
        error?.let { SummonError(it) }
        if (!store.protocolReady) store.protocolNotice?.let { SummonError(it) }
        when (section) {
            ResourceSection.Bots -> store.bots.forEach { bot ->
                TextButton(onClick = { detail = SummonReference("bot", bot.id) }) {
                    MemberAvatar(bot, 32.dp)
                    Text(bot.name + if (bot.isPaused) " · 已暂停" else "", Modifier.padding(start = 10.dp))
                }
            }
            ResourceSection.Executions -> items.forEach { item ->
                val ref = SummonReference.parse(item["execution_ref"]) ?: return@forEach
                SummonRecordRow(executionTitle(store, item),
                    summonStatus(item["status"].stringValue) + " · " + summonStatus(item["control"]["state"].stringValue)) { detail = ref }
            }
            ResourceSection.Files -> items.forEach { item ->
                val ref = SummonReference.parse(item["ref"]) ?: return@forEach
                SummonRecordRow(item["path"].string ?: store.label(ref), "v" + item["revision"].stringValue) { detail = ref }
            }
            ResourceSection.Wakeups -> {
                val extra = items.filter { it["rule"]["kind"].string != "room_base" }
                WakeupRows(store, "定时提醒与自定义订阅", extra) { editor = EditorRoute("wakeup", it) }
                Text("各群聊的基础消息关注规则请在对应群聊详情中调整。", color = Color.Gray, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
            }
            ResourceSection.Connections -> {
                Text("工作引擎", style = MaterialTheme.typography.titleMedium)
                items.forEach { item ->
                    val id = item["id"].string ?: return@forEach
                    val enabled = item["enabled"].bool == true
                    val available = item["available"].bool == true
                    val statusText = if (available) "已就绪" else if (!enabled) "已停用" else "未检测到 CLI"
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
                            Text("${item["name"].string ?: id} · $statusText", style = MaterialTheme.typography.titleSmall)
                            item["summary"].string?.takeIf { it.isNotEmpty() }?.let {
                                Text(it, color = Color.Gray, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        TextButton(enabled = store.protocolReady && !loading, onClick = {
                            scope.launch {
                                try {
                                    store.request("/api/engines/${SummonApiClient.component(id)}/check", "POST", SummonJson.obj("wake" to SummonJson.Bool(true)))
                                    store.refresh()
                                } catch (failure: Exception) { error = failure.localizedMessage }
                            }
                        }) { Text("自检") }
                        TextButton(enabled = store.protocolReady && !loading, onClick = {
                            scope.launch {
                                try {
                                    store.request("/api/engines/${SummonApiClient.component(id)}", "PATCH", SummonJson.obj("enabled" to SummonJson.Bool(!enabled)))
                                    store.refresh()
                                    reload()
                                } catch (failure: Exception) { error = failure.localizedMessage }
                            }
                        }) { Text(if (enabled) "停用" else "启用") }
                    }
                }
                Text("执行目录", style = MaterialTheme.typography.titleMedium)
                directories.forEach { item ->
                    SummonRecordRow(item["name"].stringValue, item["path"].stringValue) {
                        if (store.protocolReady && item["revision"].int != null) editor = EditorRoute("directory", item)
                    }
                }
            }
        }
        if (!loading && items.isEmpty() && section in listOf(ResourceSection.Files, ResourceSection.Executions)) Text("暂无记录", color = Color.Gray)
    }

    if (createBot) CreateBotSheet(store, onCreated = { scope.launch { reload() } }, onDismiss = { createBot = false })
    editor?.let { route ->
        val close = { editor = null; scope.launch { reload() }; Unit }
        when (route.kind) {
            "execution" -> ExecutionEditor(store, close)
            "file" -> FileEditor(store, space = space, close = close)
            "wakeup" -> WakeupEditor(store, route.record, space, close)
            "directory" -> DirectoryEditor(store, route.record, close)
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
    var fileID by remember(roomID) { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(roomID, store.protocolReady) {
        try { files = store.list("/api/files?room=" + SummonApiClient.component(roomID)) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.localizedMessage }
        finally { loading = false }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("引用资料") }, confirmButton = {
        TextButton(enabled = fileID.isNotBlank(), onClick = { onSelect(SummonReference("file", fileID.trim())) }) { Text("加入消息") }
    }, dismissButton = {
        TextButton(onClick = onDismiss) { Text("取消") }
    }, text = {
        Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
            if (loading) CircularProgressIndicator()
            error?.let { SummonError(it) }
            if (!loading && error == null && files.isEmpty()) Text("暂无可引用的群资料")
            SummonTextField("文件 ID", fileID, { fileID = it })
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
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var detail by remember(ref) { mutableStateOf<SummonJson>(SummonJson.Null) }
    var busy by remember(ref) { mutableStateOf(false) }
    var error by remember(ref) { mutableStateOf<String?>(null) }
    if (ref.kind == "workspace_file" && !ref.workspaceId.isNullOrBlank() && !ref.filePath.isNullOrBlank()) {
        SummonDetailsPage(store.label(ref), close) {
            Text(ref.filePath, style = MaterialTheme.typography.titleMedium)
            error?.let { SummonError(it) }
            if (busy) CircularProgressIndicator()
            TextButton(enabled = !busy && store.protocolReady, onClick = {
                busy = true; error = null
                scope.launch {
                    try {
                        val file = store.downloadWorkspaceFile(ref.workspaceId, ref.filePath)
                        shareFile(context, file, "application/octet-stream")
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (failure: Exception) { error = failure.localizedMessage }
                    finally { busy = false }
                }
            }) { Text("下载最新工作区文件") }
        }
        return
    }
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
            } else if (ref.kind == "call") {
                val execStatus = detail["result"]["status"].string ?: detail["status"].string ?: "unknown"
                val httpStatus = detail["result"]["status"].int
                val exitCode = detail["result"]["exit_code"].int ?: detail["result"]["native"]["exit_code"].int ?: detail["result"]["output"]["exit_code"].int
                val errCode = detail["result"]["code"].string ?: detail["result"]["output"]["code"].string
                val errText = detail["result"]["error"].string ?: detail["result"]["output"]["error"].string
                val outText = detail["result"]["output"].string ?: detail["result"]["output"]["text"].string ?: detail["result"]["output"]["message"].string
                var showRaw by remember(ref) { mutableStateOf(false) }
                Text("工具：${detail["tool"].string ?: "—"}", style = MaterialTheme.typography.titleSmall)
                Text("状态：${summonStatus(execStatus)}")
                if (httpStatus != null) Text("HTTP 状态：$httpStatus")
                if (exitCode != null) Text("退出码：$exitCode")
                detail["submitted_by"]["id"].string?.let { Text("发起者：${store.name(it)}") }
                SummonReference.parse(detail["target"])?.let { Text("目标：${store.label(it)}") }
                if (errCode != null || errText != null) {
                    Text("错误信息：${listOfNotNull(errCode, errText).joinToString(" · ")}", color = LocalSummonPalette.current.warn)
                }
                if (!outText.isNullOrBlank()) {
                    Text("结果摘要", style = MaterialTheme.typography.titleSmall)
                    SelectionContainer { Text(outText.take(2000), fontFamily = FontFamily.Monospace) }
                }
                TextButton(onClick = { showRaw = !showRaw }) { Text(if (showRaw) "收起原始数据" else "查看原始数据") }
                if (showRaw) SelectionContainer { Text(detail.pretty, fontFamily = FontFamily.Monospace) }
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
    var selectedRevision by remember(ref) { mutableStateOf<Int?>(null) }
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

    suspend fun load(append: Boolean = false, rev: Int? = selectedRevision) {
        val params = mutableListOf<String>()
        if (append && cursor != null) params.add("cursor=" + SummonApiClient.component(cursor!!))
        if (rev != null) params.add("revision=$rev")
        val base = ref.path ?: ("/api/files/" + SummonApiClient.component(ref.id))
        val next = store.request(if (params.isEmpty()) base else base + "?" + params.joinToString("&"))
        if (append && value["revision"] != next["revision"]) throw SummonApiException("资料已修订，请刷新后读取。")
        value = next
        text = (if (append) text else "") + next["content"].string.orEmpty()
        cursor = next["next_cursor"].string
    }

    LaunchedEffect(ref, store.protocolReady) { run { load() } }
    SummonDetailsPage(value["name"].string ?: "资料", close) {
        value["path"].string?.let { Text(it, style = MaterialTheme.typography.titleMedium) }
        value["revision"].int?.let { rev ->
            val latest = value["latest_revision"].int ?: rev
            val scopeLabel = when (value["space"]["kind"].string) {
                "bot" -> " · 私有记忆/资料"
                "room" -> " · 本群共享资料"
                else -> ""
            }
            Text((if (rev == latest) "v$rev" else "v$rev（历史版本 · 最新 v$latest）") + scopeLabel, color = Color.Gray)
        }
        val revisions = value["revisions"].array.orEmpty()
        if (revisions.size > 1) {
            Row {
                revisions.forEach { revItem ->
                    val r = revItem["revision"].int ?: return@forEach
                    val latest = value["latest_revision"].int ?: value["revision"].int ?: r
                    TextButton(enabled = !busy && r != value["revision"].int, onClick = {
                        selectedRevision = if (r == latest) null else r
                        run { load(append = false, rev = selectedRevision) }
                    }) { Text(if (r == latest) "v$r (正式版)" else "v$r") }
                }
            }
        }
        if (busy) CircularProgressIndicator()
        error?.let { SummonError(it) }
        Row {
            TextButton(enabled = !busy && store.protocolReady, onClick = { run { load(rev = selectedRevision) } }) { Text("刷新") }
            if (value["url"].string != null) TextButton(enabled = !busy && store.protocolReady, onClick = {
                run {
                    val name = value["name"].string ?: "资料"
                    val file = if (value["url"].string?.startsWith("/api/attachments/") == true) {
                        store.attachmentFile(SummonAttachment.parse(value))
                    } else store.downloadFile(ref.id, name, selectedRevision)
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
        val rawSources = value["sources"].array.orEmpty()
        if (rawSources.isNotEmpty()) Text("来源", style = MaterialTheme.typography.titleSmall)
        rawSources.forEach { src ->
            if (src["access"].string == "redacted") {
                Text("受限来源（" + src["id"].stringValue.take(8) + "）", color = Color.Gray, style = MaterialTheme.typography.bodySmall)
            } else {
                SummonReference.parse(src)?.let { source -> TextButton(onClick = { nested = source }) { Text(store.label(source)) } }
            }
        }
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
    var showRawLogs by remember(ref) { mutableStateOf(false) }

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

    fun command(kind: String, input: SummonJson? = null, requestId: String? = null, stopScope: String? = null) {
        val version = detail["control_version"].int ?: return
        val execution = SummonReference.parse(detail["execution_ref"]) ?: return
        if (execution != ref || busy || !store.protocolReady) return
        val body = SummonJson.Obj(buildMap {
            put("target", execution.toJson()); put("control_version", version.numOrNull())
            if (kind == "stop" && stopScope != null) put("scope", SummonJson.Str(stopScope))
            else {
                put("kind", SummonJson.Str(kind))
                if (input != null) put("input", input)
                if (!requestId.isNullOrEmpty()) put("request_id", SummonJson.Str(requestId))
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
        }
        if (busy) CircularProgressIndicator()
        error?.let { SummonError(it) }
        if (detail != SummonJson.Null) {
            val readableSummary = executionReadableSummary(detail)
            if (readableSummary.isNotBlank()) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = LocalSummonPalette.current.surface,
                    border = BorderStroke(0.6.dp, LocalSummonPalette.current.hairline),
                    modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                ) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("任务摘要", style = MaterialTheme.typography.labelSmall, color = LocalSummonPalette.current.textSecondary)
                        SelectionContainer { Text(readableSummary, style = MaterialTheme.typography.bodyMedium) }
                    }
                }
            }
        }
        detail["status"].string?.let { Text("状态 · " + summonStatus(it)) }
        val lastError = detail["last_error"]
        val errorText = listOfNotNull(lastError["code"].string, lastError["message"].string)
            .filter { it.isNotEmpty() }.joinToString(" · ")
        if (errorText.isNotEmpty()) SummonError("最近错误 · " + errorText)
        detail["control"]["state"].string?.let { Text("控制 · " + summonStatus(it)) }
        detail["control"]["stop_status"].string?.let { Text("停止结果 · " + summonStatus(it)) }
        (detail["execution_actor"]["id"].string ?: detail["bot_id"].string)?.let { Text("执行身份 · " + store.name(it)) }
        detail["submitted_by"]["id"].string?.let { Text("提交者 · " + store.name(it)) }
        detail["latest_call_id"].string?.let { id -> TextButton(onClick = { nested = SummonReference("call", id) }) { Text("调用 $id") } }
        stopResults.forEach { row ->
            val target = SummonReference.parse(row["target"]) ?: return@forEach
            Text(store.label(target) + " · " + summonStatus(row["control"]["stop_status"].stringValue))
        }
        SummonInputOption.options(detail).forEach { option ->
            key(detail["control_version"], option.kind, option.requestId) {
                NativeInput(option, busy || !store.protocolReady) { value -> command(option.kind, value, option.requestId) }
            }
        }
        if (pages.isNotEmpty() || detail["native"].obj != null) {
            TextButton(onClick = { showRawLogs = !showRawLogs }) {
                Text(if (showRawLogs) "收起原始执行日志" else "查看原始执行日志（排障）")
            }
            if (showRawLogs) {
                if (detail["native"].obj != null) SelectionContainer { Text(detail["native"].pretty, fontFamily = FontFamily.Monospace) }
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
    HorizontalDivider()
    Text(option.label, style = MaterialTheme.typography.titleMedium)
    option.requestId?.takeIf { it.isNotEmpty() }?.let {
        SelectionContainer { Text(it, color = Color.Gray, style = MaterialTheme.typography.bodySmall) }
    }
    option.question?.let { Text(it) }
    if (option.choices.isEmpty()) {
        SummonTextField("输入", input, { input = it }, multiline = true, enabled = !disabled)
    } else SummonChoice("回答", input, option.choices.mapNotNull {
        it["id"].string?.let { id -> id to (it["label"].string ?: id) }
    }) { input = it }
    Button(enabled = !disabled && input.isNotBlank(), onClick = { submit(SummonJson.Str(input)) }) { Text(option.label) }
}

private val overviewLiveStatuses = setOf(
    "opening", "running", "submitted", "waiting", "queued", "needs_input", "awaiting_input"
)

private fun cleanSummaryLine(raw: String?, fallback: String = ""): String {
    val trimmed = (raw ?: "").replace('\n', ' ').replace(Regex("\\s+"), " ").trim()
    if (trimmed.isEmpty()) return fallback
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        val parsed = runCatching { SummonJson.parse(trimmed) }.getOrNull()
        if (parsed != null) {
            for (k in listOf("summary", "title", "message", "text", "result")) {
                val extracted = parsed[k].string?.replace('\n', ' ')?.trim()
                if (!extracted.isNullOrEmpty()) {
                    return if (extracted.length > 100) extracted.take(98) + "…" else extracted
                }
            }
            return fallback.ifEmpty { "结构化执行输出（点开可查看详情）" }
        }
    }
    return if (trimmed.length > 100) trimmed.take(98) + "…" else trimmed
}

private fun executionReadableSummary(item: SummonJson): String {
    val status = item["status"].stringValue
    if (status == "needs_input" || status == "awaiting_input") {
        return cleanSummaryLine(
            item["waiting_summary"].string ?: item["live_progress"].string ?: item["work_summary"].string,
            "等待确认或输入",
        )
    }
    if (status in overviewLiveStatuses) {
        return cleanSummaryLine(
            item["live_progress"].string ?: item["work_summary"].string ?: item["waiting_summary"].string,
            "正在执行任务…",
        )
    }
    if (status == "failed") {
        val err = item["last_error"]["message"].string
        if (!err.isNullOrBlank()) return cleanSummaryLine(item["work_summary"].string ?: err)
    }
    val fallback = (if (item["kind"].string == "conversation") "内部对话" else item["engine"].string ?: "执行会话") +
        " · " + summonStatus(status)
    return cleanSummaryLine(
        item["work_summary"].string ?: item["last_output_summary"].string ?: item["live_progress"].string,
        fallback,
    )
}

private fun memorySummaryText(item: SummonJson): String {
    item.string?.let { return cleanSummaryLine(it) }
    for (k in listOf("summary", "content", "text", "title", "note", "fact")) {
        val text = item[k].string?.trim()
        if (!text.isNullOrEmpty()) return cleanSummaryLine(text)
    }
    return "长期记忆条目"
}

private fun memoryScopeLabel(item: SummonJson, rooms: List<SummonRoom>): String {
    val scopes = item["applies_to"].array.orEmpty()
    if (scopes.isEmpty()) return "默认范围"
    return scopes.joinToString(" · ") { scope ->
        when (scope["kind"].stringValue) {
            "bot" -> "全群通用"
            "room" -> {
                val rid = scope["id"].stringValue
                val name = rooms.firstOrNull { it.id == rid }?.name ?: rid.take(8)
                "仅限 $name"
            }
            else -> scope["kind"].stringValue
        }
    }
}

@Composable
fun WorkspacePanelScreen(
    store: SummonStore,
    onBack: () -> Unit,
    onOpenRoom: (String) -> Unit,
) {
    val palette = LocalSummonPalette.current
    var selectedTab by remember { mutableStateOf(0) } // 0 = 工作总览, 1 = Token 用量
    var showCreateBot by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = palette.background,
        topBar = {
            Column(Modifier.fillMaxWidth().statusBarsPadding()) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
                    Text("面板", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    if (selectedTab == 0) {
                        IconButton(enabled = store.protocolReady, onClick = { showCreateBot = true }) {
                            Icon(Icons.Filled.Add, "创建 Bot")
                        }
                    }
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 6.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(palette.surface)
                        .padding(3.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    listOf("工作总览", "Token 用量").forEachIndexed { idx, label ->
                        val active = selectedTab == idx
                        Surface(
                            shape = RoundedCornerShape(9.dp),
                            color = if (active) palette.surfaceElevated else Color.Transparent,
                            shadowElevation = if (active) 1.dp else 0.dp,
                            modifier = Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(9.dp))
                                .clickable { selectedTab = idx },
                        ) {
                            Box(Modifier.padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                                Text(
                                    label,
                                    style = MaterialTheme.typography.labelLarge,
                                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                                    color = if (active) MaterialTheme.colorScheme.onSurface else palette.textSecondary,
                                )
                            }
                        }
                    }
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (selectedTab == 0) {
                WorkspaceOverviewBody(store = store, onOpenRoom = onOpenRoom)
            } else {
                TokenUsageScreen(store = store, onBack = onBack, embedded = true)
            }
        }
    }

    if (showCreateBot) {
        CreateBotSheet(store = store, onCreated = { showCreateBot = false }, onDismiss = { showCreateBot = false })
    }
}

@Composable
private fun WorkspaceOverviewBody(
    store: SummonStore,
    onOpenRoom: (String) -> Unit,
) {
    val palette = LocalSummonPalette.current
    val scope = rememberCoroutineScope()
    var executions by remember { mutableStateOf<List<SummonJson>>(emptyList()) }
    var files by remember { mutableStateOf<List<SummonJson>>(emptyList()) }
    var expandedRooms by remember { mutableStateOf<Set<String>>(emptySet()) }
    var expandedBots by remember { mutableStateOf<Set<String>>(emptySet()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var detail by remember { mutableStateOf<SummonReference?>(null) }
    var detailRoom by remember { mutableStateOf<SummonReference?>(null) }

    suspend fun reload() {
        if (loading || !store.protocolReady) return
        loading = true; error = null
        try {
            executions = store.list("/api/executions")
            files = store.list("/api/files")
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            error = failure.localizedMessage
        } finally {
            loading = false
        }
    }

    LaunchedEffect(store.protocolReady) { reload() }

    detail?.let { selected ->
        when (selected.kind) {
            "bot" -> BotDetailsScreen(store, selected.id) { detail = null }
            "session", "conversation" -> ExecutionDetail(store, selected) { detail = null }
            "file" -> FileDetail(store, selected, detailRoom) { detail = null; detailRoom = null }
            else -> ReferenceDetail(store, selected) { detail = null }
        }
        return
    }

    fun execsForRoom(roomId: String) = executions.filter {
        it["space"]["kind"].string == "room" && it["space"]["id"].string == roomId
    }

    fun execsForBot(roomId: String, botId: String) = execsForRoom(roomId).filter {
        (it["execution_actor"]["id"].string ?: it["bot_id"].string) == botId
    }

    fun filesForRoom(roomId: String) = files.filter {
        it["deleted_room"].bool != true && it["space"]["kind"].string == "room" && it["space"]["id"].string == roomId
    }

    fun filesForBot(botId: String) = files.filter {
        it["deleted_room"].bool != true && it["space"]["kind"].string == "bot" && it["space"]["id"].string == botId
    }

    fun memoriesForBot(bot: SummonBot, roomId: String) = bot.memoryItems.filter { item ->
        val scopes = item["applies_to"].array.orEmpty()
        scopes.isEmpty() || scopes.any { it["kind"].string == "bot" || (it["kind"].string == "room" && it["id"].string == roomId) }
    }

    fun roleOrder(bot: SummonBot, room: SummonRoom): Int = when {
        room.leadBotId == bot.id || bot.roleId == "group-lead" -> 0
        bot.roleId == "eggbot" -> 2
        bot.roleId == "tool-onboarding" -> 3
        else -> 1
    }

    fun roleBadge(bot: SummonBot, room: SummonRoom): String? = when {
        room.leadBotId == bot.id || bot.roleId == "group-lead" -> "主控"
        bot.roleId == "eggbot" -> "孵化"
        bot.roleId == "tool-onboarding" -> "接口"
        else -> null
    }

    val activeGroups = store.rooms
        .filter { it.isGroup && !it.isArchived }
        .sortedWith(
            compareByDescending<SummonRoom> { r -> execsForRoom(r.id).any { it["status"].stringValue in overviewLiveStatuses } }
                .thenByDescending { it.lastMessage?.createdAt ?: it.updatedAt.orEmpty() },
        )
    val assignedBotIds = activeGroups.flatMap { it.members }.toSet()
    val unassignedBots = store.bots.filter { it.id !in assignedBotIds }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text("群聊（点击逐层展开）", style = MaterialTheme.typography.labelMedium, color = palette.textSecondary)
            TextButton(enabled = !loading && store.protocolReady, onClick = { scope.launch { reload() } }) { Text("刷新") }
        }
        if (loading && executions.isEmpty() && files.isEmpty()) {
            CircularProgressIndicator(Modifier.size(22.dp))
        }
        error?.let { SummonError(it) }
        if (activeGroups.isEmpty() && !loading) {
            Text("暂无活跃群聊", color = palette.textSecondary, style = MaterialTheme.typography.bodyMedium)
        }

        activeGroups.forEach { room ->
            OverviewRoomCard(
                store = store,
                room = room,
                isOpen = room.id in expandedRooms,
                expandedBots = expandedBots,
                execsForRoom = execsForRoom(room.id),
                execsForBot = { botId -> execsForBot(room.id, botId) },
                filesForRoom = filesForRoom(room.id),
                filesForBot = { botId -> filesForBot(botId) },
                memoriesForBot = { bot -> memoriesForBot(bot, room.id) },
                roleOrder = { bot -> roleOrder(bot, room) },
                roleBadge = { bot -> roleBadge(bot, room) },
                onToggleRoom = {
                    expandedRooms = if (room.id in expandedRooms) expandedRooms - room.id else expandedRooms + room.id
                },
                onToggleBot = { key ->
                    expandedBots = if (key in expandedBots) expandedBots - key else expandedBots + key
                },
                onOpenRoom = { onOpenRoom(room.id) },
                onOpenDetail = { ref, rRef ->
                    detailRoom = rRef
                    detail = ref
                },
            )
        }

        if (store.archivedRooms.isNotEmpty() || unassignedBots.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Text("归档与未分组", style = MaterialTheme.typography.labelMedium, color = palette.textSecondary)
            store.archivedRooms.forEach { room ->
                OverviewRoomCard(
                    store = store,
                    room = room,
                    isOpen = room.id in expandedRooms,
                    expandedBots = expandedBots,
                    execsForRoom = execsForRoom(room.id),
                    execsForBot = { botId -> execsForBot(room.id, botId) },
                    filesForRoom = filesForRoom(room.id),
                    filesForBot = { botId -> filesForBot(botId) },
                    memoriesForBot = { bot -> memoriesForBot(bot, room.id) },
                    roleOrder = { bot -> roleOrder(bot, room) },
                    roleBadge = { bot -> roleBadge(bot, room) },
                    onToggleRoom = {
                        expandedRooms = if (room.id in expandedRooms) expandedRooms - room.id else expandedRooms + room.id
                    },
                    onToggleBot = { key ->
                        expandedBots = if (key in expandedBots) expandedBots - key else expandedBots + key
                    },
                    onOpenRoom = { onOpenRoom(room.id) },
                    onOpenDetail = { ref, rRef ->
                        detailRoom = rRef
                        detail = ref
                    },
                )
            }
            unassignedBots.forEach { bot ->
                Surface(
                    shape = RoundedCornerShape(14.dp),
                    color = palette.surface,
                    border = BorderStroke(0.6.dp, palette.hairline),
                    modifier = Modifier.fillMaxWidth().clickable { detail = SummonReference("bot", bot.id) },
                ) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        MemberAvatar(bot, 32.dp)
                        Column {
                            Text(bot.name, style = MaterialTheme.typography.bodyMedium)
                            Text("未加入活跃群聊", style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun OverviewRoomCard(
    store: SummonStore,
    room: SummonRoom,
    isOpen: Boolean,
    expandedBots: Set<String>,
    execsForRoom: List<SummonJson>,
    execsForBot: (String) -> List<SummonJson>,
    filesForRoom: List<SummonJson>,
    filesForBot: (String) -> List<SummonJson>,
    memoriesForBot: (SummonBot) -> List<SummonJson>,
    roleOrder: (SummonBot) -> Int,
    roleBadge: (SummonBot) -> String?,
    onToggleRoom: () -> Unit,
    onToggleBot: (String) -> Unit,
    onOpenRoom: () -> Unit,
    onOpenDetail: (SummonReference, SummonReference?) -> Unit,
) {
    val palette = LocalSummonPalette.current
    val members = room.members
        .filter { it != "user" }
        .mapNotNull { id -> store.bots.firstOrNull { it.id == id } }
        .sortedBy { roleOrder(it) }
    val liveCount = execsForRoom.count { it["status"].stringValue in overviewLiveStatuses }
    val meta = listOfNotNull(
        "${members.size} 位伙伴",
        when {
            liveCount > 0 -> "$liveCount 进行中"
            execsForRoom.isNotEmpty() -> "${execsForRoom.size} 条执行"
            else -> null
        },
        filesForRoom.takeIf { it.isNotEmpty() }?.let { "${it.size} 份资料" },
    ).joinToString(" · ")

    Surface(
        shape = RoundedCornerShape(16.dp),
        color = palette.surface,
        border = BorderStroke(0.7.dp, if (liveCount > 0) palette.ok.copy(alpha = 0.45f) else palette.hairline),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onToggleRoom)
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                RoomAvatar(room, store.bots, 40.dp, showOutline = false)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(room.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (room.isArchived) Text("归档", style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                        if (liveCount > 0) Box(Modifier.size(7.dp).clip(CircleShape).background(palette.ok))
                    }
                    Text(meta, style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
                }
                Icon(if (isOpen) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, null, tint = palette.textSecondary)
            }

            if (isOpen) {
                HorizontalDivider(color = palette.hairline)
                Column(Modifier.padding(start = 16.dp, end = 14.dp, top = 8.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = onOpenRoom) { Text("进入群聊 →") }

                    members.forEach { bot ->
                        val botKey = "${room.id}:${bot.id}"
                        val botOpen = botKey in expandedBots
                        val execs = execsForBot(bot.id)
                        val mems = memoriesForBot(bot)
                        val bFiles = filesForBot(bot.id)
                        val botLive = execs.count { it["status"].stringValue in overviewLiveStatuses }
                        val badge = roleBadge(bot)
                        val bits = listOfNotNull(
                            execs.takeIf { it.isNotEmpty() }?.let { "${it.size} 执行" },
                            mems.takeIf { it.isNotEmpty() }?.let { "${it.size} 记忆" },
                            bFiles.takeIf { it.isNotEmpty() }?.let { "${it.size} 资料" },
                        ).joinToString(" · ").ifEmpty { "空闲" }

                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = palette.background,
                            border = BorderStroke(0.6.dp, palette.hairline),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column {
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .clickable { onToggleBot(botKey) }
                                        .padding(horizontal = 12.dp, vertical = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    MemberAvatar(bot, 32.dp)
                                    Column(Modifier.weight(1f)) {
                                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                            Text(bot.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                            badge?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = palette.textSecondary) }
                                            if (botLive > 0) Box(Modifier.size(6.dp).clip(CircleShape).background(palette.ok))
                                        }
                                        Text(bits, style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                                    }
                                    Icon(if (botOpen) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, null, tint = palette.textSecondary, modifier = Modifier.size(18.dp))
                                }

                                if (botOpen) {
                                    HorizontalDivider(color = palette.hairline)
                                    Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        TextButton(onClick = { onOpenDetail(SummonReference("bot", bot.id), null) }) { Text("查看 / 编辑 Bot") }

                                        if (execs.isNotEmpty()) {
                                            Text("执行对话（${execs.size}）", style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                                            execs.take(8).forEach { ex ->
                                                val ref = SummonReference.parse(ex["execution_ref"]) ?: return@forEach
                                                val status = ex["status"].stringValue
                                                Column(
                                                    Modifier
                                                        .fillMaxWidth()
                                                        .clip(RoundedCornerShape(10.dp))
                                                        .background(palette.surface)
                                                        .clickable { onOpenDetail(ref, null) }
                                                        .padding(10.dp),
                                                    verticalArrangement = Arrangement.spacedBy(4.dp),
                                                ) {
                                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                                        Text(
                                                            summonStatus(status),
                                                            style = MaterialTheme.typography.labelSmall,
                                                            color = when {
                                                                status in overviewLiveStatuses -> palette.ok
                                                                status == "failed" -> palette.warn
                                                                else -> palette.textSecondary
                                                            },
                                                        )
                                                        Text(
                                                            if (ex["kind"].string == "conversation") "内部对话" else ex["engine"].string ?: "执行",
                                                            style = MaterialTheme.typography.labelSmall,
                                                            color = palette.textSecondary,
                                                        )
                                                    }
                                                    Text(
                                                        executionReadableSummary(ex),
                                                        style = MaterialTheme.typography.bodySmall,
                                                        maxLines = 2,
                                                        overflow = TextOverflow.Ellipsis,
                                                    )
                                                }
                                            }
                                        }

                                        if (mems.isNotEmpty()) {
                                            Text("沉淀记忆（${mems.size}）", style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                                            mems.take(8).forEach { mem ->
                                                Column(
                                                    Modifier
                                                        .fillMaxWidth()
                                                        .clip(RoundedCornerShape(10.dp))
                                                        .background(palette.surface)
                                                        .padding(10.dp),
                                                    verticalArrangement = Arrangement.spacedBy(3.dp),
                                                ) {
                                                    Text(memoryScopeLabel(mem, store.rooms), style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                                                    Text(memorySummaryText(mem), style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
                                                }
                                            }
                                        }

                                        if (bFiles.isNotEmpty()) {
                                            Text("私有资料（${bFiles.size}）", style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                                            bFiles.forEach { file ->
                                                val ref = SummonReference.parse(file["ref"]) ?: return@forEach
                                                SummonRecordRow(file["name"].string ?: file["path"].string ?: store.label(ref), "v${file["revision"].int ?: 1}") {
                                                    onOpenDetail(ref, null)
                                                }
                                            }
                                        }

                                        if (execs.isEmpty() && mems.isEmpty() && bFiles.isEmpty()) {
                                            Text("暂无执行对话或沉淀记忆", style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (filesForRoom.isNotEmpty()) {
                        Text("群共享资料（${filesForRoom.size}）", style = MaterialTheme.typography.labelSmall, color = palette.textSecondary, modifier = Modifier.padding(top = 4.dp))
                        filesForRoom.forEach { file ->
                            val ref = SummonReference.parse(file["ref"]) ?: return@forEach
                            SummonRecordRow(file["name"].string ?: file["path"].string ?: store.label(ref), "v${file["revision"].int ?: 1}") {
                                onOpenDetail(ref, SummonReference("room", room.id))
                            }
                        }
                    }
                }
            }
        }
    }
}
