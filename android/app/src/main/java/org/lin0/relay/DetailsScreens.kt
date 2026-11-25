package org.lin0.relay

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
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
    var avatar by remember(botID) { mutableStateOf(current?.resolvedAvatar ?: SummonAvatar()) }
    var access by remember(botID) { mutableStateOf<SummonJson>(SummonJson.Null) }
    var models by remember(botID) { mutableStateOf<List<SummonJson>>(emptyList()) }
    var directories by remember(botID) { mutableStateOf<List<SummonJson>>(emptyList()) }
    var selectedModels by remember(botID) { mutableStateOf<Set<String>>(emptySet()) }
    var selectedDirs by remember(botID) { mutableStateOf<Set<String>>(emptySet()) }
    var detail by remember(botID) { mutableStateOf<ResourceSection?>(null) }
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
            access = store.request(accessPath)
            selectedModels = access["model_ids"].array.orEmpty().mapNotNull { it.string }.toSet()
            selectedDirs = access["workspace_ids"].array.orEmpty().mapNotNull { it.string }.toSet()
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.localizedMessage }
    }
    LaunchedEffect(botID, store.protocolReady) {
        if (!store.protocolReady) return@LaunchedEffect
        try {
            val latest = SummonBot.parse(store.read(ref))
            if (current?.revision == null) {
                name = latest.name; instructions = latest.instructions.orEmpty(); avatar = latest.resolvedAvatar
                connection = latest.model["connection_id"].string.orEmpty()
                model = latest.model["id"].string.orEmpty()
                thinking = latest.model["thinking_level"].string.orEmpty()
            }
            current = latest
            models = store.request("/api/model-settings")["connections"].array.orEmpty()
            directories = store.list("/api/workspaces")
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.localizedMessage }
    }
    val page = detail
    if (page != null) {
        ResourcesScreen(store, page, onBack = { detail = null }, space = ref)
        return
    }

    SummonDetailsPage(current?.name ?: "Bot", onBack) {
        MemberAvatar(current?.copy(avatar = avatar), 92.dp)
        AvatarPicker(avatar) { avatar = it }
        TextButton(enabled = !busy, onClick = { photo.launch(photoRequest()) }) { Text("使用自己的图片") }
        val enabled = !busy && store.protocolReady && current?.revision != null
        Button(enabled = !busy && store.protocolReady, onClick = {
            run { current = store.setAvatar(avatar, botID) }
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
        val retainedConnection = current?.model?.get("connection_id")?.string
        val connectionOptions = if (retainedConnection != null && connections.none { it.first == retainedConnection }) {
            connections + (retainedConnection to "$retainedConnection · 当前绑定")
        } else connections
        SummonChoice("模型连接", connection, connectionOptions) { connection = it }
        if (connection.isNotEmpty()) {
            SummonTextField("模型名称", model, { model = it })
            val entry = models.firstOrNull { it["id"].string == connection }
            val known = model.isBlank() || model == entry?.get("model")?.string
            ModelThinkingField("推理强度", "继承连接", thinking, entry?.get("thinkingLevels")?.array.takeIf { known }) { thinking = it }
        }
        Button(enabled = enabled && name.isNotBlank(), onClick = {
            val before = current ?: return@Button
            val changes = mutableMapOf<String, SummonJson>("name" to SummonJson.Str(name.trim()), "instructions" to SummonJson.Str(instructions))
            if (connection != before.model["connection_id"].string.orEmpty() || model.trim() != before.model["id"].string.orEmpty() ||
                thinking.trim() != before.model["thinking_level"].string.orEmpty()) {
                changes["model"] = if (connection.isEmpty()) SummonJson.Null else SummonJson.Obj(buildMap {
                    put("connection_id", SummonJson.Str(connection))
                    if (model.isNotBlank()) put("id", SummonJson.Str(model.trim()))
                    if (thinking.isNotBlank()) put("thinking_level", SummonJson.Str(thinking.trim()))
                })
            }
            run { current = store.updateBot(before, *changes.toList().toTypedArray()) }
        }) { Text("保存 Bot 设置") }

        current?.let { bot ->
            if (bot.memoryItems.isNotEmpty()) {
                Text("长期记忆与约定（${bot.memoryItems.size}）", style = MaterialTheme.typography.titleMedium)
                bot.memoryItems.forEach { item ->
                    val scopes = item["applies_to"].array.orEmpty().joinToString(" · ") { s ->
                        if (s["kind"].string == "bot") "全群通用" else "仅限群 " + s["id"].stringValue.take(8)
                    }
                    Text("${item["item_id"].stringValue} · v${item["revision"].int ?: 1}（${scopes.ifEmpty { "默认范围" }}）",
                        fontWeight = FontWeight.SemiBold)
                    item["note"].string?.takeIf { it.isNotEmpty() }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall)
                    }
                    val deprecated = listOfNotNull(item["supersedes"].string, item["deprecated_note"].string)
                        .filter { it.isNotEmpty() }.joinToString(" · ")
                    if (deprecated.isNotEmpty()) {
                        Text("失效/退役：$deprecated", style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                    }
                }
            }
            Text("控制 · " + if (bot.isPaused) "已暂停" else "启用")
            if (bot.isPaused) bot.control["stop_status"].string?.let { Text("停止结果 · " + summonStatus(it)) }
            Button(enabled = enabled, onClick = {
                run {
                    current = store.updateBot(bot, "enabled" to SummonJson.Bool(bot.isPaused))
                }
            }) { Text(if (bot.isPaused) "恢复 Bot" else "暂停 Bot") }
        }
        access["revision"].int?.let { revision ->
            Text("资源权限", style = MaterialTheme.typography.titleMedium)
            SummonResourceSelection("模型连接", models, selectedModels, access["model_ids"].array.orEmpty().mapNotNull { it.string }.toSet()) { selectedModels = it }
            SummonResourceSelection("执行目录", directories, selectedDirs, access["workspace_ids"].array.orEmpty().mapNotNull { it.string }.toSet()) { selectedDirs = it }
            Button(enabled = !busy && store.protocolReady, onClick = {
                run {
                    access = store.request(accessPath, "PATCH", SummonJson.obj("revision" to revision.numOrNull(),
                        "model_ids" to selectedModels.sorted().toJsonStrings(), "workspace_ids" to selectedDirs.sorted().toJsonStrings()))
                }
            }) { Text("保存资源权限") }
        }
        TextButton(onClick = { detail = ResourceSection.Files }) { Text("私有资料") }
        TextButton(onClick = { detail = ResourceSection.Executions }) { Text("内部对话和执行会话") }
        TextButton(onClick = { detail = ResourceSection.Wakeups }) { Text("订阅与提醒") }
        if (busy) CircularProgressIndicator()
        error?.let { SummonError(it) }
    }
}

@Composable
internal fun SummonResourceSelection(title: String, items: List<SummonJson>, selected: Set<String>, retained: Set<String> = selected, update: (Set<String>) -> Unit) {
    Text(title, style = MaterialTheme.typography.labelLarge)
    val visible = items.mapNotNull { item -> item["id"].string?.let { it to (item["name"].string ?: it) } }
    val hidden = (retained - visible.map { it.first }.toSet()).sorted().map { it to "$it · 现有授权" }
    (visible + hidden).forEach { (id, name) ->
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = id in selected, onCheckedChange = { update(if (it) selected + id else selected - id) })
            Text(name)
        }
    }
}

@Composable
fun RoomDetailsScreen(store: SummonStore, roomID: String, onBack: () -> Unit) {
    val palette = LocalSummonPalette.current
    val scope = rememberCoroutineScope()
    val room = store.room(roomID)
    val directBot = room?.takeIf { !it.isGroup }?.members?.firstNotNullOfOrNull { store.bot(it) }
    val canEdit = room != null && store.protocolReady && room.revision != null
    var editing by remember(roomID) { mutableStateOf<SummonRoom?>(null) }
    var leave by remember(roomID) { mutableStateOf<SummonRoom?>(null) }
    var deletingGroup by remember(roomID) { mutableStateOf(false) }
    var leaving by remember(roomID) { mutableStateOf(false) }
    var botID by remember(roomID) { mutableStateOf<String?>(null) }
    var section by remember(roomID) { mutableStateOf<ResourceSection?>(null) }
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
        ResourcesScreen(store, page, onBack = { section = null }, space = space)
        return
    }
    if (editingRoom != null) {
        RoomEditor(store, editingRoom) { editing = null }
        return
    }

    BackHandler(onBack = onBack)
    Column(Modifier.fillMaxSize().background(palette.background).statusBarsPadding().navigationBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Surface(
                shape = CircleShape,
                color = palette.glassPill,
                border = BorderStroke(0.8.dp, palette.bubbleStroke),
                modifier = Modifier.size(40.dp).clip(CircleShape).clickable(onClick = onBack),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = MaterialTheme.colorScheme.onBackground, modifier = Modifier.size(20.dp))
                }
            }
            if (canEdit) {
                val editableRoom = room!!
                Surface(
                    shape = CircleShape,
                    color = palette.glassPill,
                    border = BorderStroke(0.8.dp, palette.bubbleStroke),
                    modifier = Modifier.clip(CircleShape).clickable { editing = editableRoom },
                ) {
                    Text(
                        "编辑",
                        style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
            }
        }

        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            if (room != null) {
                // Hero
                Column(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (directBot != null) {
                        MemberAvatar(directBot, 86.dp)
                    } else {
                        RoomAvatar(room, store.bots, 90.dp)
                    }
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            room.name,
                            style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold),
                            textAlign = TextAlign.Center,
                        )
                        Text(
                            if (room.isGroup) "${room.members.size} 位成员" else if (directBot?.isPaused == true) "已暂停" else "私聊 · 启用",
                            style = MaterialTheme.typography.bodySmall,
                            color = palette.textSecondary,
                        )
                    }
                }

                // Quick action tiles
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (directBot != null) {
                        QuickActionTile("Bot 设置", Icons.Filled.Tune, Modifier.weight(1f)) { botID = directBot.id }
                    }
                    QuickActionTile(if (room.isGroup) "群资料" else "资料", Icons.Filled.Folder, Modifier.weight(1f)) { section = ResourceSection.Files }
                    QuickActionTile("提醒", Icons.Filled.Schedule, Modifier.weight(1f)) { section = ResourceSection.Wakeups }
                    QuickActionTile("执行", Icons.Filled.Terminal, Modifier.weight(1f)) { section = ResourceSection.Executions }
                }

                // Visual 4-column member grid (group rooms only)
                if (room.isGroup || directBot == null) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text("成员", style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = palette.textSecondary)
                            Text("${room.members.size}", style = MaterialTheme.typography.labelSmall, color = palette.textTertiary)
                        }
                        Surface(
                            shape = RoundedCornerShape(22.dp),
                            color = palette.surfaceElevated,
                            border = BorderStroke(0.7.dp, palette.bubbleStroke),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            val entries = buildList<String?> {
                                addAll(room.members)
                                if (canEdit) add(null) // null = manage/add tile
                            }
                            Column(Modifier.padding(horizontal = 14.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                                entries.chunked(4).forEach { rowItems ->
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                        rowItems.forEach { memberId ->
                                            if (memberId == null) {
                                                Column(
                                                    Modifier.weight(1f).clip(RoundedCornerShape(12.dp)).clickable { editing = room }.padding(vertical = 2.dp),
                                                    horizontalAlignment = Alignment.CenterHorizontally,
                                                    verticalArrangement = Arrangement.spacedBy(6.dp),
                                                ) {
                                                    Box(
                                                        Modifier.size(48.dp).clip(CircleShape).background(palette.surface).border(1.dp, palette.hairline, CircleShape),
                                                        contentAlignment = Alignment.Center,
                                                    ) {
                                                        Icon(Icons.Filled.Add, "管理成员", tint = palette.textSecondary, modifier = Modifier.size(20.dp))
                                                    }
                                                    Text("管理", style = MaterialTheme.typography.labelSmall, color = palette.textSecondary, maxLines = 1)
                                                }
                                            } else if (memberId == "user") {
                                                Column(
                                                    Modifier.weight(1f).padding(vertical = 2.dp),
                                                    horizontalAlignment = Alignment.CenterHorizontally,
                                                    verticalArrangement = Arrangement.spacedBy(6.dp),
                                                ) {
                                                    OwnerAvatar(
                                                        name = store.settings.hubUsername ?: store.settings.userName,
                                                        signedIn = store.settings.hubUsername != null,
                                                        size = 48.dp,
                                                        modifier = Modifier.border(0.8.dp, palette.bubbleStroke, CircleShape),
                                                    )
                                                    Text(store.name(memberId), style = MaterialTheme.typography.labelSmall, color = palette.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                                }
                                            } else {
                                                val memberBot = store.bot(memberId)
                                                Column(
                                                    Modifier.weight(1f).clip(RoundedCornerShape(12.dp)).clickable(enabled = memberBot != null) { botID = memberId }.padding(vertical = 2.dp),
                                                    horizontalAlignment = Alignment.CenterHorizontally,
                                                    verticalArrangement = Arrangement.spacedBy(6.dp),
                                                ) {
                                                    if (memberBot != null) {
                                                        MemberAvatar(memberBot, 48.dp, modifier = Modifier.alpha(if (memberBot.isPaused) 0.45f else 1f))
                                                    } else {
                                                        Box(Modifier.size(48.dp).clip(CircleShape).background(palette.surface), contentAlignment = Alignment.Center) {
                                                            Text(store.name(memberId).take(1), color = palette.textSecondary)
                                                        }
                                                    }
                                                    Text(store.name(memberId), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                                }
                                            }
                                        }
                                        repeat(4 - rowItems.size) { Spacer(Modifier.weight(1f)) }
                                    }
                                }
                            }
                        }
                    }
                }

                // Pinned items — only displayed when pins actually exist
                if (room.pins.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text("置顶", style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = palette.textSecondary)
                            Text("${room.pins.size}", style = MaterialTheme.typography.labelSmall, color = palette.textTertiary)
                        }
                        Surface(
                            shape = RoundedCornerShape(20.dp),
                            color = palette.surfaceElevated,
                            border = BorderStroke(0.7.dp, palette.bubbleStroke),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column {
                                room.pins.forEachIndexed { idx, pin ->
                                    Row(
                                        Modifier.fillMaxWidth().clickable { ref = pin }.padding(start = 14.dp, end = 6.dp, top = 8.dp, bottom = 8.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                                    ) {
                                        Icon(Icons.Filled.PushPin, null, tint = palette.ok, modifier = Modifier.size(15.dp))
                                        Text(store.label(pin), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                        IconButton(
                                            enabled = store.protocolReady,
                                            onClick = {
                                                scope.launch {
                                                    try { store.setPin(pin, room, remove = true); error = null }
                                                    catch (failure: Exception) { error = failure.localizedMessage }
                                                }
                                            },
                                            modifier = Modifier.size(32.dp),
                                        ) {
                                            Icon(Icons.Filled.Close, "取消置顶", tint = palette.textTertiary, modifier = Modifier.size(16.dp))
                                        }
                                    }
                                    if (idx < room.pins.lastIndex) {
                                        HorizontalDivider(Modifier.padding(start = 38.dp), thickness = 0.6.dp, color = palette.hairline)
                                    }
                                }
                            }
                        }
                    }
                }

                error?.let { SummonError(it) }

                if (room.archivable) {
                    Surface(
                        shape = RoundedCornerShape(16.dp),
                        color = palette.surfaceElevated,
                        border = BorderStroke(0.7.dp, palette.bubbleStroke),
                        modifier = Modifier.fillMaxWidth().padding(top = 4.dp).clip(RoundedCornerShape(16.dp))
                            .clickable(enabled = canEdit && !leaving) {
                                leaving = true
                                scope.launch {
                                    try {
                                        if (room.isArchived) store.restoreRoom(room) else store.archiveRoom(room)
                                        onBack()
                                    } catch (failure: Exception) {
                                        error = failure.localizedMessage
                                    } finally {
                                        leaving = false
                                    }
                                }
                            },
                    ) {
                        Box(Modifier.fillMaxWidth().padding(vertical = 14.dp), contentAlignment = Alignment.Center) {
                            Text(if (room.isArchived) "移出归档" else "归档群聊", style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium))
                        }
                    }
                }

                if (room.isGroup && "user" in room.members) {
                    Surface(
                        shape = RoundedCornerShape(16.dp),
                        color = Color(0x18E53935),
                        modifier = Modifier.fillMaxWidth().padding(top = 4.dp).clip(RoundedCornerShape(16.dp))
                            .clickable(enabled = canEdit && !leaving) { deletingGroup = false; leave = room },
                    ) {
                        Box(Modifier.fillMaxWidth().padding(vertical = 14.dp), contentAlignment = Alignment.Center) {
                            Text("退出群聊", color = Color(0xFFE53935), style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium))
                        }
                    }
                }
                if (room.deletable) {
                    TextButton(enabled = canEdit && !leaving, onClick = { deletingGroup = true; leave = room }) {
                        Text("删除群聊", color = Color(0xFFE53935))
                    }
                }
                Spacer(Modifier.height(16.dp))
            }
        }
    }
    ref?.let { SummonReferenceDialog(store, it) { ref = null } }
    leave?.let { target ->
        val action = if (deletingGroup) "删除群聊" else "退出群聊"
        androidx.compose.material3.AlertDialog(onDismissRequest = { if (!leaving) leave = null }, title = { Text(action + "？") },
            text = { Text(if (deletingGroup) "删除「${target.name}」后，所有成员都无法再打开这个群聊。" else target.name) },
            confirmButton = { TextButton(enabled = !leaving, onClick = {
                leaving = true
                scope.launch {
                    try {
                        if (deletingGroup) store.deleteGroup(target) else store.leaveRoom(target)
                        leave = null
                        onBack()
                    }
                    catch (failure: Exception) { leave = null; error = failure.localizedMessage }
                    finally { leaving = false }
                }
            }) { Text(action) } },
            dismissButton = { TextButton(enabled = !leaving, onClick = { leave = null }) { Text("取消") } })
    }
}

@Composable
private fun QuickActionTile(title: String, icon: ImageVector, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val palette = LocalSummonPalette.current
    Surface(
        shape = RoundedCornerShape(18.dp),
        color = palette.surfaceElevated,
        border = BorderStroke(0.7.dp, palette.bubbleStroke),
        modifier = modifier.clip(RoundedCornerShape(18.dp)).clickable(onClick = onClick),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(vertical = 14.dp, horizontal = 6.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(icon, title, tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(20.dp))
            Text(title, style = MaterialTheme.typography.labelSmall, color = palette.textSecondary, maxLines = 1)
        }
    }
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
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = bot.id in members, onCheckedChange = { members = if (it) members + bot.id else members - bot.id })
                MemberAvatar(bot, 30.dp)
                Spacer(Modifier.width(10.dp))
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
    Text(error, color = LocalSummonPalette.current.warn, style = MaterialTheme.typography.bodySmall)
}
