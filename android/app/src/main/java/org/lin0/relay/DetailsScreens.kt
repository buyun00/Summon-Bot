package org.lin0.relay

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

@Composable
fun BotDetailsScreen(store: SummonStore, botID: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var current by remember(botID) { mutableStateOf(store.bot(botID)) }
    var name by remember(botID) { mutableStateOf(current?.name.orEmpty()) }
    var instructions by remember(botID) { mutableStateOf(current?.instructions.orEmpty()) }
    var connection by remember(botID) { mutableStateOf(current?.model?.get("connection_id")?.string.orEmpty()) }
    var model by remember(botID) { mutableStateOf(current?.model?.get("id")?.string.orEmpty()) }
    var thinking by remember(botID) { mutableStateOf(current?.model?.get("thinking_level")?.string.orEmpty()) }
    var index by remember(botID) { mutableStateOf(current?.materialIndex?.id.orEmpty()) }
    var avatar by remember(botID) { mutableStateOf(current?.resolvedAvatar ?: SummonAvatar()) }
    var access by remember(botID) { mutableStateOf<SummonJson>(SummonJson.Null) }
    var models by remember(botID) { mutableStateOf<List<SummonJson>>(emptyList()) }
    var directories by remember(botID) { mutableStateOf<List<SummonJson>>(emptyList()) }
    var files by remember(botID) { mutableStateOf<List<SummonJson>>(emptyList()) }
    var selectedModels by remember(botID) { mutableStateOf<Set<String>>(emptySet()) }
    var selectedDirs by remember(botID) { mutableStateOf<Set<String>>(emptySet()) }
    var detail by remember(botID) { mutableStateOf<WorkspaceSection?>(null) }
    var busy by remember(botID) { mutableStateOf(false) }
    var error by remember(botID) { mutableStateOf<String?>(null) }
    val ref = SummonReference("bot", botID)
    val accessPath = ref.path + "/access"
    fun run(action: suspend () -> Unit) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try { action() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.localizedMessage }
            finally { busy = false }
        }
    }
    val photo = rememberPhotoPicker { uri -> run { avatar = avatarFromUri(context, uri, avatar) } }

    LaunchedEffect(botID, store.protocolReady) {
        if (!store.protocolReady) return@LaunchedEffect
        try {
            val latest = SummonBot.parse(store.read(ref))
            if (current?.revision == null) {
                name = latest.name; instructions = latest.instructions.orEmpty(); avatar = latest.resolvedAvatar
                connection = latest.model["connection_id"].string.orEmpty()
                model = latest.model["id"].string.orEmpty()
                thinking = latest.model["thinking_level"].string.orEmpty()
                index = latest.materialIndex?.id.orEmpty()
            }
            current = latest
            access = store.request(accessPath)
            models = store.request("/api/model-settings")["connections"].array.orEmpty()
            directories = store.list("/api/workspaces")
            files = store.list("/api/files?bot=" + SummonApiClient.component(botID))
            selectedModels = access["model_ids"].array.orEmpty().mapNotNull { it.string }.toSet()
            selectedDirs = access["workspace_ids"].array.orEmpty().mapNotNull { it.string }.toSet()
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.localizedMessage }
    }
    val page = detail
    if (page != null) {
        WorkspaceScreen(store, page, onBack = { detail = null }, space = ref)
        return
    }

    SummonDetailsPage(current?.name ?: "Bot", onBack) {
        MemberAvatar(current?.copy(avatar = avatar), 92.dp)
        AvatarPicker(avatar) { avatar = it }
        TextButton(enabled = !busy, onClick = { photo.launch(photoRequest()) }) { Text("使用自己的图片") }
        val enabled = !busy && store.protocolReady && current?.revision != null
        Button(enabled = enabled, onClick = {
            run { current?.let { current = store.updateBot(it, "avatar" to avatar.toJson()) } }
        }) { Text("保存头像") }
        Text("Bot 设置", style = MaterialTheme.typography.titleMedium)
        SummonTextField("名称", name, { name = it })
        SummonTextField("行为指令", instructions, { instructions = it }, multiline = true)
        val connections = listOf("" to "未绑定模型") + models.mapNotNull { item ->
            val id = item["id"].string ?: return@mapNotNull null
            if (id == current?.model?.get("connection_id")?.string || access["model_ids"].array.orEmpty().any { it.string == id }) {
                id to (item["name"].string ?: id)
            } else null
        }
        SummonChoice("模型连接", connection, connections) { connection = it }
        if (connection.isNotEmpty()) {
            SummonTextField("模型名称", model, { model = it })
            SummonChoice("推理强度", thinking,
                listOf("" to "连接默认值") + listOf("off", "low", "medium", "high", "xhigh", "max").map { it to it }) { thinking = it }
        }
        SummonChoice("选材索引", index, listOf("" to "未选择") + files.mapNotNull { file ->
            file["id"].string?.let { it to (file["path"].string ?: it) }
        }) { index = it }
        Button(enabled = enabled && name.isNotBlank(), onClick = {
            val before = current ?: return@Button
            val changes = mutableMapOf<String, SummonJson>("name" to SummonJson.Str(name.trim()), "instructions" to SummonJson.Str(instructions))
            if (connection != before.model["connection_id"].string.orEmpty() || model != before.model["id"].string.orEmpty() ||
                thinking != before.model["thinking_level"].string.orEmpty()) {
                changes["model"] = if (connection.isEmpty()) SummonJson.Null else SummonJson.Obj(buildMap {
                    put("connection_id", SummonJson.Str(connection))
                    if (model.isNotBlank()) put("id", SummonJson.Str(model.trim()))
                    if (thinking.isNotEmpty()) put("thinking_level", SummonJson.Str(thinking))
                })
            }
            if (index != before.materialIndex?.id.orEmpty()) {
                changes["material_index_ref"] = if (index.isEmpty()) SummonJson.Null else SummonReference("file", index).toJson()
            }
            run { current = store.updateBot(before, *changes.toList().toTypedArray()) }
        }) { Text("保存 Bot 设置") }

        current?.let { bot ->
            Text("控制 · " + if (bot.isPaused) "已暂停" else "启用")
            if (bot.isPaused) bot.control["stop_status"].string?.let { Text("停止结果 · " + summonStatus(it)) }
            if (!bot.isPaused || (bot.resumeRef.obj != null && bot.control["stop_status"].string == "stopped")) {
                Button(enabled = enabled, onClick = {
                    run {
                        current = if (bot.isPaused) store.updateBot(bot, "enabled" to SummonJson.Bool(true), "resume_ref" to bot.resumeRef)
                        else store.updateBot(bot, "enabled" to SummonJson.Bool(false))
                    }
                }) { Text(if (bot.isPaused) "恢复 Bot" else "暂停 Bot") }
            }
        }
        access["revision"].int?.let { revision ->
            Text("资源权限", style = MaterialTheme.typography.titleMedium)
            SummonResourceSelection("模型连接", models, selectedModels) { selectedModels = it }
            SummonResourceSelection("执行目录", directories, selectedDirs) { selectedDirs = it }
            Button(enabled = enabled, onClick = {
                run {
                    access = store.request(accessPath, "PATCH", SummonJson.obj("revision" to revision.numOrNull(),
                        "model_ids" to selectedModels.sorted().toJsonStrings(), "workspace_ids" to selectedDirs.sorted().toJsonStrings()))
                }
            }) { Text("保存资源权限") }
        }
        TextButton(onClick = { detail = WorkspaceSection.Files }) { Text("私有资料") }
        TextButton(onClick = { detail = WorkspaceSection.Executions }) { Text("内部对话和执行会话") }
        TextButton(onClick = { detail = WorkspaceSection.Wakeups }) { Text("订阅与提醒") }
        if (busy) CircularProgressIndicator()
        error?.let { SummonError(it) }
    }
}

@Composable
internal fun SummonResourceSelection(title: String, items: List<SummonJson>, selected: Set<String>, update: (Set<String>) -> Unit) {
    Text(title, style = MaterialTheme.typography.labelLarge)
    items.forEach { item ->
        val id = item["id"].string ?: return@forEach
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = id in selected, onCheckedChange = { update(if (it) selected + id else selected - id) })
            Text(item["name"].string ?: id)
        }
    }
}

@Composable
fun RoomDetailsScreen(store: SummonStore, roomID: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val room = store.room(roomID)
    var editing by remember(roomID) { mutableStateOf<SummonRoom?>(null) }
    var botID by remember(roomID) { mutableStateOf<String?>(null) }
    var section by remember(roomID) { mutableStateOf<WorkspaceSection?>(null) }
    var ref by remember(roomID) { mutableStateOf<SummonReference?>(null) }
    var error by remember(roomID) { mutableStateOf<String?>(null) }
    val space = SummonReference("room", roomID)

    val bot = botID
    val page = section
    val editingRoom = editing
    if (bot != null) {
        BotDetailsScreen(store, bot) { botID = null }
        return
    }
    if (page != null) {
        WorkspaceScreen(store, page, onBack = { section = null }, space = space)
        return
    }
    if (editingRoom != null) {
        RoomEditor(store, editingRoom) { editing = null }
        return
    }

    SummonDetailsPage("会话详情", onBack) {
        if (room != null) {
            RoomAvatar(room, store.bots)
            Text(room.name, style = MaterialTheme.typography.titleMedium)
            TextButton(enabled = store.protocolReady && room.revision != null, onClick = { editing = room }) { Text("编辑名称和成员") }
            Text("成员", style = MaterialTheme.typography.titleMedium)
            room.members.forEach { id ->
                if (store.bot(id) != null) {
                    TextButton(onClick = { botID = id }) { Row(verticalAlignment = Alignment.CenterVertically) {
                        MemberAvatar(store.bot(id), 30.dp)
                        Text(store.name(id), Modifier.padding(start = 10.dp))
                    } }
                } else Text(store.name(id))
            }
            Text("置顶", style = MaterialTheme.typography.titleMedium)
            if (room.pins.isEmpty()) Text("暂无置顶", color = Color.Gray)
            room.pins.forEach { pin ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { ref = pin }, modifier = Modifier.weight(1f)) { Text(store.label(pin)) }
                    TextButton(enabled = store.protocolReady, onClick = {
                        scope.launch {
                            try { store.setPin(pin, room, remove = true); error = null }
                            catch (failure: Exception) { error = failure.localizedMessage }
                        }
                    }) { Text("移除") }
                }
            }
            TextButton(onClick = { section = WorkspaceSection.Files }) { Text("群资料") }
            TextButton(onClick = { section = WorkspaceSection.Wakeups }) { Text("订阅与提醒") }
            TextButton(onClick = { section = WorkspaceSection.Executions }) { Text("执行会话和内部对话") }
        }
        error?.let { SummonError(it) }
    }
    ref?.let { SummonReferenceDialog(store, it) { ref = null } }
}

@Composable
private fun RoomEditor(store: SummonStore, room: SummonRoom, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember(room) { mutableStateOf(room.name) }
    var members by remember(room) { mutableStateOf(room.members.toSet()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    SummonDetailsPage("编辑会话", onBack) {
        SummonTextField("名称", name, { name = it })
        Text("成员", style = MaterialTheme.typography.titleMedium)
        store.bots.forEach { bot ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = bot.id in members, onCheckedChange = { members = if (it) members + bot.id else members - bot.id })
                Text(bot.name)
            }
        }
        Button(enabled = !busy && store.protocolReady, onClick = {
            busy = true; error = null
            scope.launch {
                try { store.updateRoom(room, name, members.sorted()); onBack() }
                catch (failure: Exception) { error = failure.localizedMessage }
                finally { busy = false }
            }
        }) { Text("保存") }
        error?.let { SummonError(it) }
    }
}

private suspend fun avatarFromUri(context: android.content.Context, uri: Uri, avatar: SummonAvatar): SummonAvatar = withContext(Dispatchers.IO) {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw SummonApiException("无法读取图片。")
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 512) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    val bitmap = context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
        ?: throw SummonApiException("无法读取图片。")
    val ratio = minOf(1.0, 256.0 / maxOf(bitmap.width, bitmap.height))
    val resized = Bitmap.createScaledBitmap(bitmap, maxOf(1, (bitmap.width * ratio).toInt()), maxOf(1, (bitmap.height * ratio).toInt()), true)
    val output = ByteArrayOutputStream()
    resized.compress(Bitmap.CompressFormat.PNG, 100, output)
    val encoded = android.util.Base64.encodeToString(output.toByteArray(), android.util.Base64.NO_WRAP)
    if (encoded.length > 390_000) throw SummonApiException("请使用较小的头像图片。")
    avatar.copy(image = "data:image/png;base64,$encoded")
}

@Composable
internal fun SummonDetailsPage(title: String, onBack: () -> Unit, contents: @Composable () -> Unit) {
    BackHandler(onBack = onBack)
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("返回") }
            Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 10.dp))
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            contents()
        }
    }
}

@Composable
internal fun SummonTextField(label: String, text: String, update: (String) -> Unit, multiline: Boolean = false, enabled: Boolean = true) {
    OutlinedTextField(text, update, label = { Text(label) }, modifier = Modifier.fillMaxWidth(),
        singleLine = !multiline, minLines = if (multiline) 3 else 1, enabled = enabled)
}

@Composable
internal fun SummonError(error: String) {
    Text(error, color = Color(0xFFFF9F0A), style = MaterialTheme.typography.bodySmall)
}
