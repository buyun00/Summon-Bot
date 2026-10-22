package org.lin0.relay

import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import kotlin.math.max

@Composable
fun BotDetailsScreen(store: RelayStore, botID: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val bot = store.bots.firstOrNull { it.id == botID }
    var name by remember { mutableStateOf(bot?.name.orEmpty()) }
    var role by remember { mutableStateOf(bot?.role.orEmpty()) }
    var expertise by remember { mutableStateOf(bot?.expertise.orEmpty()) }
    var prompt by remember { mutableStateOf(bot?.prompt.orEmpty()) }
    var avatar by remember { mutableStateOf(bot?.avatar ?: RelayAvatar.defaultFor(botID)) }
    var busy by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var memories by remember { mutableStateOf<List<RelayJson>>(emptyList()) }
    var editing by remember { mutableStateOf<RelayJson?>(null) }
    var showEditor by remember { mutableStateOf(false) }
    var showAvatar by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val photos = rememberPhotoPicker { uri ->
        scope.launch {
            try { avatar = avatarFromUri(context, uri); saved = false } catch (exception: Exception) { error = exception.message }
        }
    }
    LaunchedEffect(botID) {
        bot?.let {
            name = it.name; role = it.role; expertise = it.expertise; prompt = it.prompt
            avatar = it.avatar ?: RelayAvatar.defaultFor(it.id)
        }
        try { memories = store.request("/api/bots/${RelayApiClient.component(botID)}/memories")["memories"].array.orEmpty() }
        catch (exception: Exception) { error = exception.message }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
            Text(bot?.name ?: "Bot 资料", modifier = Modifier.weight(1f))
            TextButton(onClick = onBack) { Text("完成") }
        }
        BotAvatar(avatar.shape, avatar.color, avatar.image, 112.dp)
        TextButton(onClick = { showAvatar = !showAvatar }) { Text("编辑头像") }
        if (showAvatar) {
            AvatarPicker(avatar) { avatar = it; saved = false }
            TextButton(onClick = { photos.launch(photoRequest()) }) { Icon(Icons.Filled.Image, null); Text("使用自己的图片") }
        }
        OutlinedTextField(name, { name = it; saved = false }, label = { Text("名字") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(role, { role = it; saved = false }, label = { Text("主要职责") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(expertise, { expertise = it; saved = false }, label = { Text("专业领域") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(prompt, { prompt = it; saved = false }, label = { Text("身份与工作方式") }, modifier = Modifier.fillMaxWidth(), minLines = 4)
        TextButton(enabled = !busy && name.isNotBlank(), onClick = {
            scope.launch {
                busy = true; error = null
                try { store.updateBot(botID, name, role, expertise, prompt, avatar = avatar); saved = true }
                catch (exception: Exception) { error = exception.message }
                finally { busy = false }
            }
        }) { Text(if (saved) "已保存" else "保存资料") }
        bot?.let { current ->
            TextButton(enabled = !busy, onClick = {
                scope.launch {
                    busy = true
                    try { store.updateBot(botID, status = if (current.isPaused) "active" else "paused") }
                    catch (exception: Exception) { error = exception.message }
                    finally { busy = false }
                }
            }) { Text(if (current.isPaused) "恢复 Bot" else "暂停 Bot") }
        }
        Text("长期记忆", modifier = Modifier.padding(top = 12.dp).align(Alignment.Start))
        if (memories.isEmpty()) Text("还没有长期记忆", color = Color(0xFF8E8E93), modifier = Modifier.align(Alignment.Start))
        memories.forEach { memory ->
            Column(Modifier.fillMaxWidth().clickable { editing = memory; showEditor = true }.padding(vertical = 8.dp)) {
                Text(memory["content"].string ?: memory["text"].string.orEmpty())
                Text(if (memory["status"].string == "expired") "已过期" else "有效", color = Color(0xFF8E8E93))
            }
        }
        TextButton(onClick = { editing = null; showEditor = true }) { Icon(Icons.Filled.Add, null); Text("添加记忆") }
        error?.let { Text(it, color = Color(0xFFFF9F0A)) }
        Spacer(Modifier.height(24.dp))
    }
    if (showEditor) MemoryEditor(store, botID, editing) {
        showEditor = false
        scope.launch {
            try { memories = store.request("/api/bots/${RelayApiClient.component(botID)}/memories")["memories"].array.orEmpty() }
            catch (exception: Exception) { error = exception.message }
        }
    }
}

private fun avatarFromUri(context: android.content.Context, uri: Uri): RelayAvatar {
    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: throw RelayApiException.invalidResponse
    val source = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw RelayApiException.invalidResponse
    val ratio = minOf(1f, 256f / max(source.width, source.height))
    val width = max(1, (source.width * ratio).toInt())
    val height = max(1, (source.height * ratio).toInt())
    val scaled = Bitmap.createScaledBitmap(source, width, height, true)
    val stream = ByteArrayOutputStream()
    scaled.compress(Bitmap.CompressFormat.PNG, 100, stream)
    val encoded = android.util.Base64.encodeToString(stream.toByteArray(), android.util.Base64.NO_WRAP)
    if (encoded.length > 390_000) throw RelayApiException("图片缩放后仍然过大，请选择较小的图片。")
    return RelayAvatar(image = "data:image/png;base64,$encoded")
}

@Composable
private fun MemoryEditor(store: RelayStore, botID: String, memory: RelayJson?, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var content by remember { mutableStateOf(memory?.get("content")?.string ?: memory?.get("text")?.string.orEmpty()) }
    var status by remember { mutableStateOf(memory?.get("status")?.string ?: "active") }
    var category by remember { mutableStateOf(memory?.get("category")?.string ?: "professional") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (memory == null) "添加记忆" else "修订记忆") },
        text = {
            Column {
                OutlinedTextField(content, { content = it }, label = { Text("记忆内容") }, minLines = 4)
                TextButton(onClick = { category = if (category == "professional") "private" else "professional" }) {
                    Text(if (category == "professional") "专业记忆" else "私人记忆")
                }
                TextButton(onClick = { status = if (status == "active") "expired" else "active" }) {
                    Text(if (status == "expired") "已过期" else "有效")
                }
                error?.let { Text(it, color = Color(0xFFFF9F0A)) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && content.isNotBlank(), onClick = {
                scope.launch {
                    busy = true
                    val id = memory?.get("id")?.string
                    val body = buildMap<String, RelayJson> {
                        put("content", RelayJson.Str(content))
                        put("status", RelayJson.Str(status))
                        put("category", RelayJson.Str(category))
                        memory?.get("revision")?.int?.let { put("expectedRevision", RelayJson.Num(it.toDouble())) }
                    }
                    val path = id?.let { "/api/memories/${RelayApiClient.component(it)}" } ?: "/api/bots/${RelayApiClient.component(botID)}/memories"
                    try {
                        store.request(path, if (id == null) "POST" else "PATCH", RelayJson.Obj(body))
                        onDismiss()
                    } catch (exception: Exception) { error = exception.message }
                    finally { busy = false }
                }
            }) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
fun RoomDetailsScreen(store: RelayStore, roomID: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val room = store.rooms.firstOrNull { it.id == roomID }
    var name by remember { mutableStateOf(room?.name.orEmpty()) }
    var goal by remember { mutableStateOf(room?.goal.orEmpty()) }
    var members by remember { mutableStateOf(room?.members?.filter { it != "user" }?.toSet() ?: emptySet()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
            Text("会话详情", modifier = Modifier.weight(1f))
            TextButton(onClick = onBack) { Text("完成") }
        }
        room?.let { current ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = androidx.compose.foundation.layout.Arrangement.Center) { RoomAvatar(current, store.bots, 100.dp) }
            if (current.kind == "dm") Text("名称  ${current.name}")
            else {
                OutlinedTextField(name, { name = it }, label = { Text("会话名称") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(goal, { goal = it }, label = { Text("讨论目标") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
            }
            Text("成员", modifier = Modifier.padding(vertical = 8.dp))
            store.bots.filter { current.kind != "dm" || current.members.contains(it.id) }.forEach { bot ->
                Row(Modifier.fillMaxWidth().clickable(enabled = current.kind != "dm") {
                    members = if (bot.id in members) members - bot.id else members + bot.id
                }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    MemberAvatar(bot, 32.dp); Spacer(Modifier.width(12.dp)); Text(bot.name, modifier = Modifier.weight(1f))
                    if (bot.id in members) Icon(Icons.Filled.Check, null)
                }
            }
            if (current.kind != "dm") {
                TextButton(enabled = !busy && members.isNotEmpty() && name.isNotEmpty(), onClick = {
                    scope.launch {
                        busy = true
                        try {
                            val ids = (if (current.members.contains("user")) listOf("user") else emptyList()) + members.sorted()
                            store.updateRoom(roomID, name, ids, goal)
                            onBack()
                        } catch (exception: Exception) { error = exception.message }
                        finally { busy = false }
                    }
                }) { Text("保存会话") }
            }
            TextButton(onClick = {
                val text = store.messagesForRoom(roomID).joinToString("\n\n") { "${store.name(it.senderId)}：${it.content}" }
                shareText(context, text)
            }) { Icon(Icons.Filled.Share, null); Text("分享会话文字") }
            if (current.kind == "deep" && !current.isConcluded) {
                TextButton(enabled = !busy, onClick = { confirm = true }) { Text("结束深聊并保留结论", color = Color(0xFFFF453A)) }
            }
            if (current.summary.isNotEmpty()) Text(current.summary, modifier = Modifier.padding(top = 8.dp))
        }
        error?.let { Text(it, color = Color(0xFFFF9F0A)) }
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false },
        title = { Text("结束这段深聊？") },
        confirmButton = {
            TextButton(onClick = {
                confirm = false
                scope.launch {
                    busy = true
                    try {
                        store.request("/api/rooms/${RelayApiClient.component(roomID)}/conclude", "POST", RelayJson.Obj(emptyMap()))
                        store.refresh(); onBack()
                    } catch (exception: Exception) { error = exception.message }
                    finally { busy = false }
                }
            }) { Text("结束并保留结论") }
        },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("取消") } },
    )
}
