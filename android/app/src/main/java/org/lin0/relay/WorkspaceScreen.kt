package org.lin0.relay

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

private sealed interface WorkspacePage {
    data object Root : WorkspacePage
    data class Work(val record: WorkspaceRecord) : WorkspacePage
    data class Knowledge(val record: WorkspaceRecord) : WorkspacePage
    data class Bot(val id: String) : WorkspacePage
}

private sealed interface EditorKind {
    data object Work : EditorKind
    data class Node(val record: WorkspaceRecord?) : EditorKind
    data class Edge(val record: WorkspaceRecord?) : EditorKind
    data class Routine(val record: WorkspaceRecord?) : EditorKind
    data object Event : EditorKind
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceScreen(store: SummonStore, section: WorkspaceSection, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var snapshot by remember { mutableStateOf<SummonJson>(SummonJson.Null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var page by remember { mutableStateOf<WorkspacePage>(WorkspacePage.Root) }
    var editor by remember { mutableStateOf<EditorKind?>(null) }
    var workFilter by remember { mutableStateOf("all") }
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<SummonJson?>(null) }
    var overrides by remember { mutableStateOf<Map<String, Boolean>>(emptyMap()) }
    var mutating by remember { mutableStateOf<Set<String>>(emptySet()) }
    var plus by remember { mutableStateOf(false) }

    suspend fun reload() {
        loading = true
        try {
            snapshot = store.request("/api/state")
            error = null
            if (results != null) {
                val text = query.trim()
                results = if (text.isEmpty()) null else store.request("/api/knowledge/search?q=${SummonApiClient.component(text)}")
            }
        } catch (exception: Exception) { error = exception.message }
        finally { loading = false }
    }
    LaunchedEffect(section) { reload() }

    if (page is WorkspacePage.Bot) {
        BotDetailsScreen(store, (page as WorkspacePage.Bot).id) { page = WorkspacePage.Root }
        return
    }
    if (page is WorkspacePage.Work) {
        WorkDetail(store, (page as WorkspacePage.Work).record, snapshot) { page = WorkspacePage.Root }
        return
    }
    if (page is WorkspacePage.Knowledge) {
        KnowledgeDetail(store, (page as WorkspacePage.Knowledge).record, snapshot) { page = WorkspacePage.Root }
        return
    }

    Column(Modifier.fillMaxSize()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
            Text(section.title, modifier = Modifier.weight(1f))
            if (section == WorkspaceSection.Knowledge) {
                IconButton(onClick = { plus = true }, enabled = snapshot.obj != null) { Icon(Icons.Filled.Add, "新增知识或关联") }
                DropdownMenu(plus, { plus = false }) {
                    DropdownMenuItem(text = { Text("新增知识") }, onClick = { plus = false; editor = EditorKind.Node(null) })
                    DropdownMenuItem(text = { Text("建立关联") }, enabled = records(snapshot["knowledge"]["nodes"]).size >= 2, onClick = { plus = false; editor = EditorKind.Edge(null) })
                }
            } else if (section == WorkspaceSection.Works) {
                IconButton(onClick = { editor = EditorKind.Work }, enabled = snapshot.obj != null) { Icon(Icons.Filled.Add, "委托工作") }
            } else if (section == WorkspaceSection.Routines) {
                IconButton(onClick = { editor = EditorKind.Routine(null) }, enabled = snapshot.obj != null) { Icon(Icons.Filled.Add, "新增职责") }
            }
            IconButton(onClick = { scope.launch { reload() } }, enabled = !loading) { Icon(Icons.Filled.Refresh, "刷新") }
            TextButton(onClick = onBack) { Text("完成") }
        }
        PullToRefreshBox(isRefreshing = loading, onRefresh = { scope.launch { reload() } }, modifier = Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                if (loading && snapshot.obj == null) CircularProgressIndicator()
                error?.let { Text(it, color = Color(0xFFFF9F0A)) }
                when (section) {
                    WorkspaceSection.Bots -> {
                        val bots = records(snapshot["bots"])
                        if (bots.isEmpty() && !loading) Text("还没有 Bot")
                        bots.forEach { bot ->
                            Row(Modifier.fillMaxWidth().clickable { page = WorkspacePage.Bot(bot.id) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                BotAvatar(bot.value["avatar"]["shape"].string ?: "dev", bot.value["avatar"]["color"].string ?: "#FFC18E", bot.value["avatar"]["image"].string, 42.dp, secondary=bot.value["avatar"]["secondary"].string, ink=bot.value["avatar"]["ink"].string, paper=bot.value["avatar"]["paper"].string)
                                Spacer(Modifier.width(12.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(bot.value["name"].string ?: bot.id)
                                    Text(bot.value["role"].stringValue, color = Color(0xFF8E8E93))
                                }
                                if (bot.value["status"].string == "paused") Text("已暂停", color = Color(0xFF8E8E93))
                            }
                        }
                    }
                    WorkspaceSection.Works -> {
                        Row {
                            listOf("all" to "全部", "active" to "进行中", "waiting" to "等待中", "completed" to "已完成", "attention" to "待处理").forEach { (id, label) ->
                                TextButton(onClick = { workFilter = id }) { Text(if (workFilter == id) "$label ✓" else label) }
                            }
                        }
                        val works = records(snapshot["works"]).filter { record ->
                            val status = record.value["status"].stringValue
                            when (workFilter) {
                                "active" -> status in setOf("active", "queued", "running")
                                "attention" -> status in setOf("paused", "blocked", "failed", "interrupted", "cancelled")
                                "all" -> true
                                else -> status == workFilter
                            }
                        }
                        if (works.isEmpty() && !loading) Text("这里暂时没有工作\n通过右上角加号明确目标并委托给成员。", color = Color(0xFF8E8E93))
                        works.forEach { record ->
                            Column(Modifier.fillMaxWidth().clickable { page = WorkspacePage.Work(record) }.padding(vertical = 8.dp)) {
                                Text(record.value["goal"].stringValue)
                                Text("${if (record.value["status"].stringValue == "active") "进行中" else workspaceStatus(record.value["status"].stringValue)} · ${workspaceName(record.value["botId"].stringValue, snapshot["bots"])}  ${formatSummonDate(record.value["createdAt"].string)}", color = Color(0xFF8E8E93))
                            }
                        }
                    }
                    WorkspaceSection.Knowledge -> {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            OutlinedTextField(query, { query = it }, label = { Text("搜索标题和知识内容") }, modifier = Modifier.weight(1f), singleLine = true)
                            TextButton(onClick = {
                                scope.launch {
                                    val text = query.trim()
                                    if (text.isEmpty()) { results = null; return@launch }
                                    try { results = store.request("/api/knowledge/search?q=${SummonApiClient.component(text)}"); error = null }
                                    catch (exception: Exception) { error = exception.message }
                                }
                            }) { Text("搜索") }
                        }
                        val nodes = records(results?.get("nodes") ?: snapshot["knowledge"]["nodes"])
                        if (nodes.isEmpty() && !loading) Text(if (query.isEmpty()) "还没有知识记录" else "没有匹配的知识", color = Color(0xFF8E8E93))
                        nodes.forEach { node ->
                            Column(Modifier.fillMaxWidth().clickable { page = WorkspacePage.Knowledge(node) }.padding(vertical = 8.dp)) {
                                Text("${workspaceStatus(node.value["type"].stringValue)} · ${workspaceStatus(node.value["status"].stringValue)}", color = Color(0xFF8E8E93))
                                Text(node.value["title"].stringValue)
                                Text(node.value["content"].stringValue, color = Color(0xFF8E8E93), maxLines = 3)
                            }
                        }
                        val memories = results?.get("memories")?.array.orEmpty()
                        if (memories.isNotEmpty()) {
                            Text("相关成员记忆", modifier = Modifier.padding(top = 8.dp))
                            memories.forEach { memory ->
                                Text(workspaceName(memory["botId"].stringValue, snapshot["bots"]), color = Color(0xFF8E8E93))
                                Text(memory["content"].stringValue)
                            }
                        }
                    }
                    WorkspaceSection.Routines -> {
                        val routines = records(snapshot["routines"])
                        if (routines.isEmpty() && !loading) Text("还没有定时职责\n创建职责后，服务会按设定周期投递给成员。", color = Color(0xFF8E8E93))
                        routines.forEach { record ->
                            Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                                Column(Modifier.clickable { editor = EditorKind.Routine(record) }) {
                                    Text(record.value["name"].stringValue)
                                    Text(record.value["instruction"].stringValue, color = Color(0xFF8E8E93), maxLines = 4)
                                    Text(workspaceName(record.value["botId"].stringValue, snapshot["bots"]), color = Color(0xFF8E8E93))
                                }
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text("启用", modifier = Modifier.weight(1f))
                                    Switch(checked = overrides[record.id] ?: record.value["enabled"].bool ?: false, onCheckedChange = { enabled ->
                                        if (record.id in mutating) return@Switch
                                        scope.launch {
                                            mutating = mutating + record.id
                                            overrides = overrides + (record.id to enabled)
                                            try {
                                                store.request("/api/routines/${SummonApiClient.component(record.id)}", "PATCH", SummonJson.obj("enabled" to SummonJson.Bool(enabled)))
                                                reload()
                                            } catch (exception: Exception) { error = exception.message }
                                            finally { mutating = mutating - record.id; overrides = overrides - record.id }
                                        }
                                    }, enabled = record.id !in mutating)
                                }
                                Text("间隔  ${(record.value["intervalSeconds"].int ?: 3600) / 60} 分钟")
                                if (record.value["enabled"].bool == true) Text("下一次  ${formatSummonDate(record.value["nextRunAt"].string, full = true)}")
                                record.value["lastStatus"].string?.takeIf { it.isNotEmpty() }?.let { Text("最近状态  ${workspaceStatus(it)}") }
                                record.value["error"].string?.takeIf { it.isNotEmpty() }?.let { Text(it, color = Color(0xFFFF9F0A)) }
                            }
                        }
                    }
                    WorkspaceSection.Event -> {
                        if (snapshot.obj != null) WorkspaceEditor(store, EditorKind.Event, snapshot, embedded = true)
                    }
                }
            }
        }
    }
    editor?.let { kind ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { editor = null },
            confirmButton = {},
            text = { WorkspaceEditor(store, kind, snapshot, onDone = { editor = null; scope.launch { reload() } }) },
        )
    }
}

@Composable
private fun WorkDetail(store: SummonStore, initial: WorkspaceRecord, snapshot: SummonJson, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var work by remember { mutableStateOf<SummonJson>(SummonJson.Null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var answer by remember { mutableStateOf("") }
    val answerRequestID = remember(answer) { java.util.UUID.randomUUID().toString() }
    val value = if (work.obj == null) initial.value else work
    val status = value["status"].stringValue
    suspend fun load() {
        try {
            val response = store.request("/api/works/${SummonApiClient.component(initial.id)}")
            val fields = response["work"].obj?.toMutableMap()
            work = if (fields != null) {
                SummonJson.Obj(fields + ("events" to response["events"]))
            } else if (response.obj != null) response else throw SummonApiException("Work not found")
            error = null
        } catch (exception: Exception) { error = exception.message }
    }
    suspend fun perform(action: String, body: SummonJson = SummonJson.Obj(emptyMap())) {
        if (busy) return
        busy = true
        try {
            val requestBody = if (action == "send") body else SummonJson.Obj(mapOf("controlRevision" to SummonJson.Num((value["controlRevision"].int ?: 0).toDouble())))
            store.request("/api/works/${SummonApiClient.component(initial.id)}/$action", "POST", requestBody)
            if (action == "send") answer = ""
            load()
        } catch (exception: Exception) { error = exception.message }
        finally { busy = false }
    }
    LaunchedEffect(initial.id) { load() }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
            Text("工作详情", modifier = Modifier.weight(1f))
            IconButton(onClick = { scope.launch { load() } }, enabled = !busy) { Icon(Icons.Filled.Refresh, "刷新") }
        }
        error?.let { Text(it, color = Color(0xFFFF9F0A)) }
        Text(value["goal"].stringValue)
        Text("状态  ${if (status == "active") "进行中" else workspaceStatus(status)}")
        Text("委托成员  ${workspaceName(value["botId"].stringValue, snapshot["bots"])}")
        Text("来源会话  ${workspaceName(value["roomId"].stringValue, snapshot["rooms"])}")
        if (value["cwd"].stringValue.isNotEmpty()) Text("工作目录  ${value["cwd"].stringValue}")
        value["model"].string?.let { Text("执行模型  $it") }
        Text("创建时间  ${formatSummonDate(value["createdAt"].string, full = true)}")
        if (value["requirements"].stringValue.isNotEmpty()) { Text("工作要求"); Text(value["requirements"].stringValue) }
        else if (value["constraints"].stringValue.isNotEmpty()) { Text("约束与注意事项"); Text(value["constraints"].stringValue) }
        if (!value["inputRefs"].array.isNullOrEmpty()) { Text("输入资料"); Text(value["inputRefs"].stringValue) }
        if (value["error"].stringValue.isNotEmpty()) Text(value["error"].stringValue, color = Color(0xFFFF9F0A))
        if (value["lastError"].stringValue.isNotEmpty()) Text(value["lastError"]["message"].string ?: value["lastError"].stringValue, color = Color(0xFFFF9F0A))
        if (value["waitingLabel"].stringValue.isNotEmpty()) { Text("等待事项"); Text(value["waitingLabel"].stringValue) }
        else if (value["waiting"]["event"].stringValue.isNotEmpty()) { Text("等待事项"); Text(value["waiting"]["event"].stringValue) }
        if (status == "interrupted") Text("上次执行已中断。恢复会继续已有工作对话，已进行的操作仍然保留。", color = Color(0xFF8E8E93))
        if (value["historical"].bool != true && status in setOf("active", "waiting", "blocked")) {
            Text("补充要求")
            OutlinedTextField(answer, { answer = it }, label = { Text("补充信息或纠正当前要求") }, minLines = 3, modifier = Modifier.fillMaxWidth())
            Button(enabled = !busy && answer.isNotBlank(), onClick = {
                scope.launch { perform("send", SummonJson.obj("id" to SummonJson.Str(answerRequestID), "message" to SummonJson.Str(answer.trim()))) }
            }) { Text("发送给负责成员") }
        }
        if (value["summary"].stringValue.isNotEmpty()) { Text("当前进度与结果"); Text(value["summary"].stringValue) }
        if (value["historical"].bool != true && status in setOf("active", "waiting")) {
            Button(enabled = !busy, onClick = { scope.launch { perform("pause") } }) { Text("暂停工作") }
            Button(enabled = !busy, onClick = { scope.launch { perform("cancel") } }) { Text("取消工作") }
        } else if (value["historical"].bool != true && status in setOf("paused", "cancelled") && value["externalStop"]["status"].string == "pending") {
            Button(enabled = !busy, onClick = { scope.launch { perform(if (status == "paused") "pause" else "cancel") } }) { Text("重新确认执行端停止") }
        } else if (value["historical"].bool != true && status in setOf("paused", "blocked", "cancelled")) Button(enabled = !busy, onClick = { scope.launch { perform("resume") } }) { Text("恢复工作") }
        Text("进度记录", modifier = Modifier.padding(top = 8.dp))
        val events = mergeWorkEvents(value["events"].array.orEmpty())
        if (events.isEmpty()) Text("暂无详细进度", color = Color(0xFF8E8E93))
        events.forEach { event ->
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Text(eventLabel(event["type"].stringValue), modifier = Modifier.weight(1f))
                Text(formatSummonDate(event["createdAt"].string ?: event["timestamp"].string), color = Color(0xFF8E8E93))
            }
            Text(eventText(event))
        }
    }
}

@Composable
private fun KnowledgeDetail(store: SummonStore, initial: WorkspaceRecord, snapshot: SummonJson, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var graph by remember { mutableStateOf<SummonJson>(SummonJson.Null) }
    var error by remember { mutableStateOf<String?>(null) }
    var editor by remember { mutableStateOf<EditorKind?>(null) }
    val node = records(graph["nodes"]).firstOrNull { it.id == initial.id } ?: initial
    suspend fun load() {
        try { graph = store.request("/api/knowledge/graph?id=${SummonApiClient.component(initial.id)}&depth=1"); error = null }
        catch (exception: Exception) { error = exception.message }
    }
    LaunchedEffect(initial.id) { load() }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
            Text("知识详情", modifier = Modifier.weight(1f))
            TextButton(onClick = { editor = EditorKind.Node(node) }) { Text("修订") }
        }
        error?.let { Text(it, color = Color(0xFFFF9F0A)) }
        Text(node.value["title"].stringValue)
        Text("性质  ${workspaceStatus(node.value["type"].stringValue)}")
        Text("状态  ${workspaceStatus(node.value["status"].stringValue)}")
        Text(node.value["content"].stringValue)
        if (node.value["source"].stringValue.isNotEmpty()) Text("来源  ${node.value["source"].stringValue}")
        if (node.value["version"].stringValue.isNotEmpty()) Text("适用版本  ${node.value["version"].stringValue}")
        Text("关联知识", modifier = Modifier.padding(top = 8.dp))
        val edges = records(graph["edges"]).filter { it.value["from"].string == node.id || it.value["to"].string == node.id }
        if (edges.isEmpty()) Text("尚未建立关联", color = Color(0xFF8E8E93))
        edges.forEach { edge ->
            val otherID = if (edge.value["from"].string == node.id) edge.value["to"].stringValue else edge.value["from"].stringValue
            val other = records(graph["nodes"]).firstOrNull { it.id == otherID }
            if (other != null) TextButton(onClick = { /* stay; graph is one hop */ }) { Text(other.value["title"].stringValue) }
            TextButton(onClick = { editor = EditorKind.Edge(edge) }) {
                Icon(Icons.Filled.Link, null)
                Text("${workspaceName(edge.value["from"].stringValue, graph["nodes"], "title")} → ${edge.value["relation"].stringValue} → ${workspaceName(edge.value["to"].stringValue, graph["nodes"], "title")}")
            }
            if (edge.value["status"].string == "expired") Text("已过期", color = Color(0xFF8E8E93))
        }
        TextButton(enabled = records(snapshot["knowledge"]["nodes"]).size >= 2, onClick = { editor = EditorKind.Edge(null) }) { Text("建立关联") }
        val history = node.value["history"].array.orEmpty().reversed()
        if (history.isNotEmpty()) {
            Text("修订历史")
            history.forEach { entry ->
                Text(formatSummonDate(entry["updatedAt"].string ?: entry["createdAt"].string ?: entry["at"].string, full = true), color = Color(0xFF8E8E93))
                Text(entry["content"].string ?: entry["snapshot"]["content"].string ?: entry.stringValue)
            }
        }
    }
    editor?.let { kind ->
        androidx.compose.material3.AlertDialog(onDismissRequest = { editor = null }, confirmButton = {}, text = {
            WorkspaceEditor(store, kind, snapshot, onDone = { editor = null; scope.launch { load() } })
        })
    }
}

@Composable
private fun WorkspaceEditor(store: SummonStore, kind: EditorKind, snapshot: SummonJson, embedded: Boolean = false, onDone: () -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val record = when (kind) {
        is EditorKind.Node -> kind.record
        is EditorKind.Edge -> kind.record
        is EditorKind.Routine -> kind.record
        else -> null
    }?.value ?: SummonJson.Null
    var title by remember { mutableStateOf(record["title"].string ?: record["name"].string ?: record["relation"].string ?: if (kind is EditorKind.Event) "人工提醒" else "") }
    var content by remember { mutableStateOf(record["content"].string ?: record["instruction"].string.orEmpty()) }
    var botID by remember { mutableStateOf(record["botId"].string ?: records(snapshot["bots"]).firstOrNull()?.id.orEmpty()) }
    var roomID by remember { mutableStateOf(record["roomId"].string ?: records(snapshot["rooms"]).firstOrNull()?.id.orEmpty()) }
    var cwd by remember { mutableStateOf(snapshot["defaultCwd"].stringValue) }
    var constraints by remember { mutableStateOf("") }
    var inputRefs by remember { mutableStateOf("") }
    var type by remember { mutableStateOf(record["type"].string ?: "unverified") }
    var status by remember { mutableStateOf(record["status"].string ?: "active") }
    var source by remember { mutableStateOf(record["source"].stringValue) }
    var version by remember { mutableStateOf(record["version"].stringValue) }
    var fromID by remember { mutableStateOf(record["from"].string ?: records(snapshot["knowledge"]["nodes"]).firstOrNull()?.id.orEmpty()) }
    var toID by remember { mutableStateOf(record["to"].string ?: records(snapshot["knowledge"]["nodes"]).drop(1).firstOrNull()?.id.orEmpty()) }
    var interval by remember { mutableStateOf(record["intervalSeconds"].int?.let { (it / 60.0).toString() } ?: "60") }
    var enabled by remember { mutableStateOf(record["enabled"].bool ?: true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var receipt by remember { mutableStateOf<String?>(null) }
    val workRequestID = remember { java.util.UUID.randomUUID().toString() }
    val minutes = interval.toDoubleOrNull()
    val seconds = minutes?.takeIf { it.isFinite() && it >= 1 }?.times(60)
    val hasTitle = title.isNotBlank()
    val hasContent = content.isNotBlank()
    val canSave = when (kind) {
        EditorKind.Work -> hasContent && botID.isNotEmpty() && roomID.isNotEmpty()
        is EditorKind.Node -> hasTitle && hasContent
        is EditorKind.Edge -> hasTitle && fromID.isNotEmpty() && toID.isNotEmpty() && fromID != toID
        is EditorKind.Routine -> hasTitle && hasContent && botID.isNotEmpty() && roomID.isNotEmpty() && seconds != null
        EditorKind.Event -> hasTitle && hasContent && botID.isNotEmpty() && roomID.isNotEmpty()
    }
    Column(Modifier.verticalScroll(rememberScrollState())) {
        Text(when (kind) {
            EditorKind.Work -> "委托工作"
            is EditorKind.Node -> if (kind.record == null) "新增知识" else "修订知识"
            is EditorKind.Edge -> if (kind.record == null) "建立关联" else "修订关系"
            is EditorKind.Routine -> if (kind.record == null) "新增定时职责" else "修改定时职责"
            EditorKind.Event -> "投递事件"
        })
        error?.let { Text(it, color = Color(0xFFFF9F0A)) }
        receipt?.let { Text(it, color = Color(0xFF30D158)) }
        when (kind) {
            EditorKind.Work -> {
                OutlinedTextField(content, { content = it }, label = { Text("希望完成什么") }, minLines = 4, modifier = Modifier.fillMaxWidth())
                RecipientFields(snapshot, botID, roomID, { botID = it }, { roomID = it })
                OutlinedTextField(cwd, { cwd = it }, label = { Text("工作目录（选填，服务器上的绝对路径）") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(constraints, { constraints = it }, label = { Text("约束与注意事项") }, minLines = 3, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(inputRefs, { inputRefs = it }, label = { Text("每行一项：文件路径、资料说明或链接") }, minLines = 3, modifier = Modifier.fillMaxWidth())
            }
            is EditorKind.Node -> {
                OutlinedTextField(title, { title = it }, label = { Text("标题") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(content, { content = it }, label = { Text("知识内容") }, minLines = 5, modifier = Modifier.fillMaxWidth())
                TextButton(onClick = { type = listOf("fact", "hypothesis", "opinion", "unverified").let { it[(it.indexOf(type) + 1) % it.size] } }) { Text("性质 ${workspaceStatus(type)}") }
                TextButton(onClick = { status = listOf("active", "disputed", "expired").let { it[(it.indexOf(status) + 1) % it.size] } }) { Text("状态 ${workspaceStatus(status)}") }
                OutlinedTextField(source, { source = it }, label = { Text("来源") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(version, { version = it }, label = { Text("适用版本（选填）") }, modifier = Modifier.fillMaxWidth())
            }
            is EditorKind.Edge -> {
                Text("关系有方向")
                if (kind.record == null) {
                    NodePicker("起点", snapshot, fromID) { fromID = it }
                    NodePicker("终点", snapshot, toID) { toID = it }
                } else {
                    Text("起点  ${workspaceName(fromID, snapshot["knowledge"]["nodes"], "title")}")
                    Text("终点  ${workspaceName(toID, snapshot["knowledge"]["nodes"], "title")}")
                }
                OutlinedTextField(title, { title = it }, label = { Text("关系，例如：依赖、支持、来自、修订") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(source, { source = it }, label = { Text("来源（选填）") }, modifier = Modifier.fillMaxWidth())
                TextButton(onClick = { status = if (status == "active") "expired" else "active" }) { Text(if (status == "expired") "已过期" else "有效") }
            }
            is EditorKind.Routine -> {
                OutlinedTextField(title, { title = it }, label = { Text("职责名称") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(content, { content = it }, label = { Text("到期时需要关注或完成什么") }, minLines = 4, modifier = Modifier.fillMaxWidth())
                RecipientFields(snapshot, botID, roomID, { botID = it }, { roomID = it })
                OutlinedTextField(interval, { interval = it }, label = { Text("间隔（分钟，最短 1 分钟）") }, modifier = Modifier.fillMaxWidth())
                Row(verticalAlignment = Alignment.CenterVertically) { Text("立即启用", modifier = Modifier.weight(1f)); Switch(enabled, { enabled = it }) }
                Text("到期后投递给指定成员。服务重启后只补一次到期职责。", color = Color(0xFF8E8E93))
            }
            EditorKind.Event -> {
                OutlinedTextField(title, { title = it }, label = { Text("事件类型") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(content, { content = it }, label = { Text("事件内容") }, minLines = 4, modifier = Modifier.fillMaxWidth())
                RecipientFields(snapshot, botID, roomID, { botID = it }, { roomID = it })
            }
        }
        Button(enabled = !busy && canSave, onClick = {
            scope.launch {
                busy = true; error = null; receipt = null
                val existing = when (kind) {
                    is EditorKind.Node -> kind.record
                    is EditorKind.Edge -> kind.record
                    is EditorKind.Routine -> kind.record
                    else -> null
                }
                var method = if (existing == null) "POST" else "PATCH"
                val path: String
                val payload: Map<String, SummonJson>
                when (kind) {
                    EditorKind.Work -> {
                        path = "/api/works"
                        payload = mapOf(
                            "id" to SummonJson.Str(workRequestID), "goal" to SummonJson.Str(content.trim()), "botId" to SummonJson.Str(botID), "roomId" to SummonJson.Str(roomID),
                            "cwd" to SummonJson.Str(cwd.trim()), "constraints" to SummonJson.Str(constraints),
                            "inputRefs" to SummonJson.Arr(inputRefs.split('\n').map { it.trim() }.filter { it.isNotEmpty() }.map(SummonJson::Str)),
                        )
                    }
                    is EditorKind.Node -> {
                        path = existing?.let { "/api/knowledge/nodes/${SummonApiClient.component(it.id)}" } ?: "/api/knowledge/nodes"
                        payload = buildMap {
                            put("title", SummonJson.Str(title)); put("content", SummonJson.Str(content)); put("type", SummonJson.Str(type))
                            put("status", SummonJson.Str(status)); put("source", SummonJson.Str(source)); put("version", SummonJson.Str(version))
                            existing?.value?.get("revision")?.int?.let { put("expectedRevision", SummonJson.Num(it.toDouble())) }
                        }
                    }
                    is EditorKind.Edge -> {
                        path = "/api/knowledge/edges"; method = "POST"
                        payload = buildMap {
                            put("from", SummonJson.Str(fromID)); put("to", SummonJson.Str(toID)); put("relation", SummonJson.Str(title))
                            put("source", SummonJson.Str(source)); put("status", SummonJson.Str(status))
                            existing?.let { put("id", SummonJson.Str(it.id)) }
                        }
                    }
                    is EditorKind.Routine -> {
                        path = existing?.let { "/api/routines/${SummonApiClient.component(it.id)}" } ?: "/api/routines"
                        payload = mapOf(
                            "name" to SummonJson.Str(title), "instruction" to SummonJson.Str(content), "botId" to SummonJson.Str(botID),
                            "roomId" to SummonJson.Str(roomID), "intervalSeconds" to SummonJson.Num(seconds ?: 3600.0), "enabled" to SummonJson.Bool(enabled),
                        )
                    }
                    EditorKind.Event -> {
                        path = "/api/events"
                        payload = mapOf("type" to SummonJson.Str(title), "content" to SummonJson.Str(content), "botId" to SummonJson.Str(botID), "roomId" to SummonJson.Str(roomID))
                    }
                }
                try {
                    val response = store.request(path, method, SummonJson.Obj(payload))
                    if (embedded) {
                        content = ""
                        val eventID = response["event"]["id"].string ?: response["id"].string
                        receipt = eventID?.let { "事件已投递 · $it" } ?: "事件已投递"
                    } else onDone()
                } catch (exception: Exception) { error = exception.message }
                finally { busy = false }
            }
        }, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
            Text(when (kind) { EditorKind.Work -> "开始工作"; EditorKind.Event -> "投递事件"; else -> "保存" })
        }
        if (!embedded) TextButton(onClick = onDone) { Text("取消") }
    }
}

@Composable
private fun RecipientFields(snapshot: SummonJson, botID: String, roomID: String, onBot: (String) -> Unit, onRoom: (String) -> Unit) {
    var botsOpen by remember { mutableStateOf(false) }
    var roomsOpen by remember { mutableStateOf(false) }
    TextButton(onClick = { botsOpen = true }) { Text("负责成员  ${workspaceName(botID, snapshot["bots"])}") }
    DropdownMenu(botsOpen, { botsOpen = false }) {
        records(snapshot["bots"]).forEach { bot -> DropdownMenuItem(text = { Text(bot.value["name"].string ?: bot.id) }, onClick = { onBot(bot.id); botsOpen = false }) }
    }
    TextButton(onClick = { roomsOpen = true }) { Text("投递到会话  ${workspaceName(roomID, snapshot["rooms"])}") }
    DropdownMenu(roomsOpen, { roomsOpen = false }) {
        records(snapshot["rooms"]).forEach { room -> DropdownMenuItem(text = { Text(room.value["name"].string ?: room.id) }, onClick = { onRoom(room.id); roomsOpen = false }) }
    }
}

@Composable
private fun NodePicker(label: String, snapshot: SummonJson, selected: String, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    TextButton(onClick = { open = true }) { Text("$label  ${workspaceName(selected, snapshot["knowledge"]["nodes"], "title")}") }
    DropdownMenu(open, { open = false }) {
        records(snapshot["knowledge"]["nodes"]).forEach { node ->
            DropdownMenuItem(text = { Text(node.value["title"].string ?: node.id) }, onClick = { onSelect(node.id); open = false })
        }
    }
}

private fun records(value: SummonJson): List<WorkspaceRecord> = value.array.orEmpty().mapNotNull { item ->
    val id = item["id"].string?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
    WorkspaceRecord(id, item)
}

private fun workspaceName(id: String, values: SummonJson, field: String = "name"): String {
    if (id.isEmpty()) return "未指定"
    return records(values).firstOrNull { it.id == id }?.value?.get(field)?.string ?: id
}

private fun eventLabel(value: String) = mapOf(
    "thread_started" to "工作会话已建立", "thread_resumed" to "工作会话已恢复", "message_delta" to "执行端消息",
    "command_output" to "命令输出", "item_started" to "开始处理", "item_completed" to "处理完成", "consult_requested" to "中途咨询",
    "consult_answer" to "咨询答复", "consult_failed" to "咨询未完成", "interrupt_acknowledged" to "执行端已停止",
    "interrupt_error" to "停止请求异常", "resume_queued" to "等待恢复", "steered" to "补充要求已传递",
    "turn_completed" to "本轮执行结束", "connection_lost" to "执行端连接中断", "result_delivery_error" to "结果回传异常",
    "queued" to "进入队列", "started" to "开始执行", "progress" to "执行进度", "output" to "执行输出", "question" to "等待答复",
    "error" to "执行异常", "reasoning" to "正在思考", "result" to "执行结果", "work.created" to "工作已建立", "work.updated" to "工作状态更新",
)[value] ?: workspaceStatus(value)

private fun eventText(event: SummonJson): String {
    val data = if (event["payload"] == SummonJson.Null) event["data"] else event["payload"]
    if (data["work"] != SummonJson.Null) {
        val work = data["work"]
        return listOf(workspaceStatus(work["status"].stringValue), work["progress"].stringValue, work["lastError"]["message"].stringValue).filter { it.isNotEmpty() }.joinToString("\n")
    }
    if (data is SummonJson.Str) return data.value
    if (data is SummonJson.Null) return event["content"].string ?: event["message"].stringValue
    if (data["item"].obj != null) {
        val item = data["item"]
        val parts = listOf("text", "command", "aggregatedOutput").mapNotNull { item[it].string?.takeIf { text -> text.isNotEmpty() } }.toMutableList()
        item["exitCode"].int?.let { parts += "退出码：$it" }
        if (parts.isNotEmpty()) return parts.joinToString("\n")
        return mapOf("reasoning" to "执行端正在分析目标与上下文。", "fileChange" to "工作目录文件发生变更。", "dynamicToolCall" to "执行端正在调用协作工具。")[item["type"].stringValue] ?: item["type"].stringValue
    }
    for (key in listOf("text", "delta", "message", "content", "summary", "question", "answer", "error")) {
        data[key].string?.let { return it }
    }
    if (event["type"].string == "queued") return data["goal"].string ?: "等待执行端接手。"
    return data.stringValue
}

private fun mergeWorkEvents(events: List<SummonJson>): List<SummonJson> {
    val result = mutableListOf<SummonJson>()
    for (event in events) {
        val last = result.lastOrNull()
        if (last != null && event["type"].stringValue in setOf("message_delta", "command_output") && last["type"] == event["type"] && last["data"]["itemId"] == event["data"]["itemId"]) {
            val fields = last.obj?.toMutableMap() ?: continue
            val data = last["data"].obj?.toMutableMap() ?: continue
            data["text"] = SummonJson.Str(last["data"]["text"].stringValue + event["data"]["text"].stringValue)
            fields["data"] = SummonJson.Obj(data)
            result[result.lastIndex] = SummonJson.Obj(fields)
        } else result += event
    }
    return result
}
