package org.lin0.relay

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.Image
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant

@Composable
fun ChatScreen(store: SummonStore, roomID: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val room = store.room(roomID)
    val directBot = room?.takeIf { !it.isGroup }?.members?.firstNotNullOfOrNull { store.bot(it) }
    val title = room?.name ?: "聊天"
    val messages = store.messagesForRoom(roomID)
    val text = store.draft(roomID)
    val attachments = store.draftAttachments[roomID].orEmpty()
    val mentions = store.draftMentions[roomID].orEmpty()
    val references = store.draftReferences[roomID].orEmpty()
    val replyID = store.draftReplies[roomID]
    var staging by remember(roomID) { mutableStateOf(false) }
    var localError by remember(roomID) { mutableStateOf<String?>(null) }
    var showDetails by remember(roomID) { mutableStateOf(false) }
    var showReferences by remember(roomID) { mutableStateOf(false) }
    var attachMenu by remember { mutableStateOf(false) }
    var targetMenu by remember { mutableStateOf(false) }
    var nearBottom by remember { mutableStateOf(true) }
    val listState = rememberLazyListState()
    val dragging by listState.interactionSource.collectIsDraggedAsState()
    var sentRevision by remember(roomID) { mutableStateOf(0) }

    fun stage(uris: List<Uri>) {
        if (staging || uris.isEmpty()) return
        staging = true
        localError = null
        val settings = store.settings
        scope.launch {
            try {
                for (uri in uris) {
                    val current = store.draftAttachments[roomID].orEmpty()
                    if (current.size >= 8) { localError = "每条消息最多添加 8 个附件。"; break }
                    val file = store.stageAttachment(uri)
                    if (settings.baseURL != store.settings.baseURL || settings.workspaceID != store.settings.workspaceID) {
                        store.discardStagedAttachment(file)
                        break
                    }
                    store.setDraftAttachments(store.draftAttachments[roomID].orEmpty() + file, roomID)
                }
            } catch (error: kotlinx.coroutines.CancellationException) { throw error }
            catch (error: Exception) { localError = error.localizedMessage }
            finally { staging = false }
        }
    }

    val photos = rememberPhotoPicker { uri -> stage(listOf(uri)) }
    val files = androidx.activity.compose.rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments(), ::stage)

    LaunchedEffect(roomID) { store.selectRoom(roomID) }
    androidx.compose.runtime.DisposableEffect(roomID) {
        onDispose { store.deactivateRoom(roomID) }
    }
    LaunchedEffect(messages.lastOrNull()?.id, sentRevision) {
        val last = listState.layoutInfo.totalItemsCount - 1
        if (nearBottom && last >= 0) listState.animateScrollToItem(last)
    }
    LaunchedEffect(dragging, listState.canScrollForward) {
        if (dragging || !listState.canScrollForward) nearBottom = !listState.canScrollForward
    }
    LaunchedEffect(roomID) {
        snapshotFlow { listState.layoutInfo.let { Triple(it.viewportEndOffset, it.totalItemsCount, it.visibleItemsInfo.lastOrNull()?.size) } }
            .distinctUntilChanged().collect {
                if (nearBottom && !listState.isScrollInProgress && listState.layoutInfo.totalItemsCount > 0) {
                    listState.scrollToItem(listState.layoutInfo.totalItemsCount - 1)
                }
            }
    }

    Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = Color.White) }
            Text(title, modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            IconButton(onClick = { showDetails = true }) {
                if (directBot != null) MemberAvatar(directBot, 30.dp) else Icon(Icons.Filled.Info, "会话详情", tint = Color.White)
            }
        }
        Box(Modifier.weight(1f)) {
            LazyColumn(state = listState, modifier = Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(18.dp)) {
                if (messages.isEmpty() && !store.isLoading) {
                    item { Text("开始聊天\n发一条消息给 $title。", color = Color(0xFF8E8E93), modifier = Modifier.padding(top = 70.dp)) }
                }
                if (store.canLoadOlder(roomID)) {
                    item { TextButton(onClick = { scope.launch { store.loadRoom(roomID, older = true) } }, enabled = store.protocolReady) { Text("加载更早消息") } }
                }
                items(messages, key = { it.id }) { message ->
                    MessageRow(store, roomID, message) { store.setDraftReply(message.id, roomID) }
                    Spacer(Modifier.height(20.dp))
                }
            }
            if (!nearBottom && messages.isNotEmpty()) {
                Surface(shape = CircleShape, color = Color(0xFF2C2C2E), modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp).clickable {
                    nearBottom = true
                    scope.launch { listState.animateScrollToItem((listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0)) }
                }) { Icon(Icons.Filled.ArrowDownward, "回到最新消息", modifier = Modifier.padding(10.dp)) }
            }
        }
        Column(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
            localError?.let { Text(it, color = Color(0xFFFF9F0A), modifier = Modifier.padding(horizontal = 20.dp)) }
            store.protocolNotice?.let { notice ->
                Text(notice, color = Color(0xFFFF9F0A), modifier = Modifier.padding(horizontal = 20.dp))
            }
            replyID?.let { id ->
                val quoted = messages.firstOrNull { it.id == id }
                Row(Modifier.padding(horizontal = 22.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.AutoMirrored.Filled.Reply, null, tint = Color(0xFF8E8E93))
                    Text(quoted?.content?.take(90) ?: "回复消息", color = Color(0xFF8E8E93), modifier = Modifier.weight(1f).padding(horizontal = 8.dp), maxLines = 2)
                    IconButton(onClick = { store.setDraftReply(null, roomID) }) { Icon(Icons.Filled.Close, "取消回复") }
                }
            }
            if (attachments.isNotEmpty() || references.isNotEmpty() || mentions.isNotEmpty()) {
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
                    attachments.forEach { item ->
                        DraftToken(item.name) {
                            store.setDraftAttachments(attachments.filterNot { it.id == item.id }, roomID)
                            store.discardStagedAttachment(item)
                        }
                    }
                    references.forEach { ref ->
                        DraftToken(store.label(ref)) { store.setDraftReferences(references.filterNot { it == ref }, roomID) }
                    }
                    mentions.forEach { id ->
                        DraftToken("@" + store.name(id)) { store.setDraftMentions(mentions.filterNot { it == id }, roomID) }
                    }
                }
            }
            when {
                room != null && !room.members.contains("user") -> Row(Modifier.padding(16.dp)) { Icon(Icons.Filled.Visibility, null, tint = Color(0xFF8E8E93)); Spacer(Modifier.width(8.dp)); Text("正在查看 Bot 之间的对话", color = Color(0xFF8E8E93)) }
                else -> Row(Modifier.padding(horizontal = 10.dp), verticalAlignment = Alignment.Bottom) {
                    Box {
                        Surface(shape = CircleShape, color = Color(0xFF2C2C2E), modifier = Modifier.size(44.dp).clickable(enabled = !staging) { attachMenu = true }) {
                            Box(contentAlignment = Alignment.Center) {
                                if (staging) CircularProgressIndicator(Modifier.size(18.dp)) else Icon(Icons.Filled.Add, "添加附件")
                            }
                        }
                        DropdownMenu(attachMenu, { attachMenu = false }) {
                            DropdownMenuItem(text = { Text("选择文件") }, enabled = attachments.size < 8, leadingIcon = { Icon(Icons.Filled.Folder, null) }, onClick = { attachMenu = false; files.launch(arrayOf("*/*")) })
                            DropdownMenuItem(text = { Text("照片图库") }, enabled = attachments.size < 8, leadingIcon = { Icon(Icons.Filled.Image, null) }, onClick = { attachMenu = false; photos.launch(photoRequest()) })
                            DropdownMenuItem(text = { Text("引用资料") }, enabled = store.protocolReady, onClick = { attachMenu = false; showReferences = true })
                        }
                    }
                    Surface(shape = RoundedCornerShape(25.dp), color = Color(0xFF2C2C2E), modifier = Modifier.weight(1f).padding(horizontal = 8.dp)) {
                        Row(verticalAlignment = Alignment.Bottom) {
                            TextField(text, { store.setDraft(it, roomID) }, modifier = Modifier.weight(1f), placeholder = { Text("发消息") }, maxLines = 6)
                            if (room != null) {
                                Box {
                                    IconButton(onClick = { targetMenu = true }) {
                                        Icon(Icons.Filled.AlternateEmail, "@ 成员", tint = if (mentions.isEmpty()) Color(0xFF8E8E93) else Color.White)
                                    }
                                    DropdownMenu(targetMenu, { targetMenu = false }) {
                                        room.members.mapNotNull(store::bot).forEach { bot ->
                                            DropdownMenuItem(text = { Text(if (bot.id in mentions) "✓  " + bot.name else bot.name) }, onClick = {
                                                val next = if (bot.id in mentions) mentions.filterNot { it == bot.id } else mentions + bot.id
                                                store.setDraftMentions(next, roomID)
                                            })
                                        }
                                    }
                                }
                            }
                        }
                    }
                    val canSend = store.protocolReady && room?.members?.contains("user") == true && roomID !in store.sendingRoomIDs &&
                        !staging && (text.isNotBlank() || attachments.isNotEmpty() || references.isNotEmpty())
                    Surface(shape = CircleShape, color = if (canSend) Color.White else Color(0xFF3A3A3C), modifier = Modifier.size(44.dp).clickable(enabled = canSend) {
                        nearBottom = true; sentRevision += 1; localError = null
                        scope.launch { store.sendMessage(roomID) }
                    }) {
                        Box(contentAlignment = Alignment.Center) { Icon(Icons.AutoMirrored.Filled.Send, "发送消息", tint = Color.Black) }
                    }
                }
            }
        }
    }
    if (showDetails) {
        BackHandler { showDetails = false }
        Surface(Modifier.fillMaxSize(), color = Color.Black) {
            RoomDetailsScreen(store, roomID) { showDetails = false }
        }
    }
    if (showReferences) SummonReferencePicker(store, roomID, onSelect = { ref ->
        if (ref !in references) store.setDraftReferences(references + ref, roomID)
        showReferences = false
    }, onDismiss = { showReferences = false })
}

@Composable
private fun DraftToken(title: String, remove: () -> Unit) {
    Surface(shape = RoundedCornerShape(20.dp), color = Color(0xFF1C1C1E), modifier = Modifier.padding(end = 8.dp)) {
        Row(Modifier.padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, maxLines = 1, modifier = Modifier.width(120.dp))
            IconButton(onClick = remove) { Icon(Icons.Filled.Close, "移除 $title") }
        }
    }
}

@Composable
private fun MessageRow(store: SummonStore, roomID: String, message: SummonMessage, onReply: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val bot = store.bot(message.senderId)
    val pending = store.pendingMessage(message)
    val room = store.room(roomID)
    val ref = SummonReference("event", message.id)
    val saved = pending == null || pending.status == "sent"
    var reference by remember { mutableStateOf<SummonReference?>(null) }
    var menu by remember { mutableStateOf(false) }
    var showDelivery by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (message.isOwn) Alignment.End else Alignment.Start) {
        Row(verticalAlignment = Alignment.Top) {
            if (!message.isOwn) {
                if (bot != null) MemberAvatar(bot, 28.dp) else Icon(Icons.Filled.Info, null, Modifier.size(28.dp))
                Spacer(Modifier.width(10.dp))
            }
            Column(horizontalAlignment = if (message.isOwn) Alignment.End else Alignment.Start, modifier = Modifier.weight(1f, fill = false)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(store.name(message.senderId), style = MaterialTheme.typography.labelMedium, color = Color(0xFF8E8E93))
                    Spacer(Modifier.width(8.dp))
                    Text(formatSummonTime(message.createdAt), style = MaterialTheme.typography.labelSmall, color = Color(0xFF636366))
                    if (saved) {
                        TextButton(onClick = { menu = true }) { Text("操作", style = MaterialTheme.typography.labelSmall) }
                        DropdownMenu(menu, { menu = false }) {
                            DropdownMenuItem(text = { Text("回复") }, onClick = { menu = false; onReply() })
                            if (room != null && store.protocolReady) {
                                val pinned = ref in room.pins
                                DropdownMenuItem(text = { Text(if (pinned) "取消置顶" else "置顶") }, onClick = {
                                    menu = false
                                    scope.launch {
                                        try { store.setPin(ref, room, pinned); error = null }
                                        catch (failure: Exception) { error = failure.localizedMessage }
                                    }
                                })
                            }
                            if (message.content.isNotEmpty()) {
                                DropdownMenuItem(text = { Text("复制") }, onClick = { menu = false; clipboard.setText(AnnotatedString(message.content)) })
                                DropdownMenuItem(text = { Text("分享") }, onClick = { menu = false; shareText(context, message.content) })
                            }
                        }
                    }
                }
                message.replyTo?.let { id ->
                    val quoted = store.messagesForRoom(roomID).firstOrNull { it.id == id }
                    if (quoted != null) Text(store.name(quoted.senderId) + " · " + quoted.content, color = Color(0xFF8E8E93),
                        maxLines = 3, modifier = Modifier.padding(vertical = 4.dp).background(Color(0xFF1C1C1E), RoundedCornerShape(12.dp)).padding(10.dp))
                    else TextButton(onClick = { reference = SummonReference("event", id) }) { Text("查看引用的消息") }
                }
                if (message.mentions.isNotEmpty()) {
                    Text(message.mentions.joinToString(" ") { "@" + store.name(it) }, style = MaterialTheme.typography.labelSmall)
                }
                if (message.content.isNotEmpty()) {
                    SelectionContainer {
                        Text(message.content, Modifier.background(Color(0xFF1C1C1E), RoundedCornerShape(21.dp)).padding(14.dp))
                    }
                }
                message.attachments.forEach { AttachmentRow(store, it) }
                message.references.forEach { item -> TextButton(onClick = { reference = item }) { Text(store.label(item)) } }
                if (pending != null && pending.status != "sent") {
                    if (pending.status == "sending") Text("正在发送…", style = MaterialTheme.typography.labelSmall)
                    else {
                        Text(pending.error ?: "保存状态待确认", color = Color(0xFFFF9F0A), style = MaterialTheme.typography.labelSmall)
                        if (pending.status == "rejected") TextButton(onClick = {
                            try { store.restoreRejectedMessage(pending) }
                            catch (failure: Exception) { error = failure.localizedMessage }
                        }) { Text("转回草稿") }
                        else TextButton(enabled = store.protocolReady && roomID !in store.sendingRoomIDs,
                            onClick = { scope.launch { store.retryMessage(pending.clientID) } }) { Text("查询并重试") }
                    }
                } else if (message.isOwn) {
                    val deliveries = store.deliveryFacts(message.id)
                    if (deliveries.isEmpty()) Text("消息已保存", style = MaterialTheme.typography.labelSmall, color = Color.Gray)
                    else TextButton(onClick = { showDelivery = !showDelivery }) { Text("消息已保存", style = MaterialTheme.typography.labelSmall) }
                    if (showDelivery) deliveries.forEach { fact ->
                        Text(store.name(fact.botId) + " · " + summonStatus(fact.status), style = MaterialTheme.typography.labelSmall)
                    }
                }
                error?.let { Text(it, color = Color(0xFFFF9F0A)) }
            }
        }
    }
    reference?.let { SummonReferenceDialog(store, it) { reference = null } }
}

@Composable
private fun AttachmentRow(store: SummonStore, attachment: SummonAttachment) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var preview by remember(attachment.id) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var downloading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var file by remember { mutableStateOf<java.io.File?>(null) }
    LaunchedEffect(attachment.id, store.protocolReady) {
        if (attachment.previewUrl == null || !store.protocolReady) return@LaunchedEffect
        runCatching {
            val bytes = store.attachmentPreview(attachment)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull()?.let { preview = it }
    }
    Column {
        preview?.let {
            Image(it.asImageBitmap(), null, Modifier.fillMaxWidth().heightIn(max = 260.dp).clip(RoundedCornerShape(14.dp)))
        }
        Row(Modifier.fillMaxWidth().clickable(enabled = !downloading && !attachment.staged && !attachment.unavailable && store.protocolReady) {
            scope.launch {
                downloading = true
                try {
                    val saved = store.attachmentFile(attachment)
                    file = saved
                    shareFile(context, saved, attachment.mimeType)
                } catch (exception: Exception) { error = exception.message }
                finally { downloading = false }
            }
        }.background(Color(0xFF1C1C1E), RoundedCornerShape(16.dp)).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (downloading) CircularProgressIndicator(Modifier.size(18.dp)) else Icon(if (attachment.mimeType.startsWith("image/")) Icons.Filled.Image else Icons.Filled.Description, null)
            Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                Text(attachment.name, maxLines = 2)
                Text(if (attachment.unavailable) "附件不可用" else formatBytes(attachment.size), color = Color(0xFF8E8E93), style = MaterialTheme.typography.labelSmall)
            }
            Icon(Icons.Filled.Download, null, tint = Color(0xFF8E8E93))
        }
        file?.let { saved -> TextButton(onClick = { shareFile(context, saved, attachment.mimeType) }) { Icon(Icons.Filled.Share, null); Text("分享文件") } }
        error?.let { Text(it, color = Color(0xFFFF9F0A)) }
    }
}
