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
    val context = LocalContext.current
    val room = store.rooms.firstOrNull { it.id == roomID }
    val directBot = room?.takeIf { it.kind == "dm" && it.members.contains("user") }?.let { current ->
        store.bots.firstOrNull { current.members.contains(it.id) }
    }
    val title = directBot?.name ?: room?.name ?: "聊天"
    val messages = store.messagesForRoom(roomID)
    var text by remember(roomID) { mutableStateOf(store.draft(roomID)) }
    var attachments by remember(roomID) { mutableStateOf(store.draftAttachments[roomID].orEmpty()) }
    var reply by remember(roomID) { mutableStateOf<SummonMessage?>(null) }
    var target by remember(roomID) { mutableStateOf(store.draftTargets[roomID].orEmpty()) }
    var uploading by remember { mutableStateOf(false) }
    var localError by remember { mutableStateOf<String?>(null) }
    var showDetails by remember { mutableStateOf(false) }
    var attachMenu by remember { mutableStateOf(false) }
    var targetMenu by remember { mutableStateOf(false) }
    var nearBottom by remember { mutableStateOf(true) }
    val listState = rememberLazyListState()
    val dragging by listState.interactionSource.collectIsDraggedAsState()
    var sentRevision by remember(roomID) { mutableStateOf(0) }
    val photos = rememberPhotoPicker { uri ->
        scope.launch { uploadUris(store, listOf(uri), attachments, { attachments = it }, { localError = it }, { uploading = it }) }
    }
    val files = androidx.activity.compose.rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        scope.launch { uploadUris(store, uris, attachments, { attachments = it }, { localError = it }, { uploading = it }) }
    }
    val working = workingBots(store, roomID, room, messages)
    val now by rememberNow()

    LaunchedEffect(roomID) {
        store.selectRoom(roomID)
        val replyID = store.draftReplies[roomID]
        reply = store.messagesForRoom(roomID).firstOrNull { it.id == replyID }
    }
    LaunchedEffect(roomID) {
        store.ensureRoomActive(roomID)
    }
    androidx.compose.runtime.DisposableEffect(roomID) {
        onDispose { store.deactivateRoom(roomID) }
    }
    LaunchedEffect(text) { store.setDraft(text, roomID) }
    LaunchedEffect(attachments) { store.setDraftAttachments(attachments, roomID) }
    LaunchedEffect(target) { store.setDraftTarget(target.ifEmpty { null }, roomID) }
    LaunchedEffect(reply?.id) { store.setDraftReply(reply?.id, roomID) }
    LaunchedEffect(messages.lastOrNull()?.id, working.map { it.id }, sentRevision) {
        if (nearBottom && (messages.isNotEmpty() || working.isNotEmpty())) {
            listState.animateScrollToItem((messages.size + working.size).coerceAtLeast(0))
        }
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
                items(messages, key = { it.id }) { message ->
                    MessageRow(store, roomID, message) { reply = message }
                    Spacer(Modifier.height(20.dp))
                }
                items(working, key = { "work-${it.id}" }) { bot ->
                    BotWorkingIndicator(bot, if (room?.kind == "dm") "" else bot.name, workingStatus(store, roomID, bot, now),
                        store.agentRuns.lastOrNull { it.roomId == roomID && it.botId == bot.id && it.isActive }?.activity?.get("motion")?.string)
                    Spacer(Modifier.height(12.dp))
                }
            }
            if (!nearBottom && messages.isNotEmpty()) {
                Surface(shape = CircleShape, color = Color(0xFF2C2C2E), modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp).clickable {
                    nearBottom = true
                    scope.launch { listState.animateScrollToItem((messages.size + working.size).coerceAtLeast(0)) }
                }) { Icon(Icons.Filled.ArrowDownward, "回到最新消息", modifier = Modifier.padding(10.dp)) }
            }
        }
        OnboardingStep(store, roomID)
        Column(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
            localError?.let { Text(it, color = Color(0xFFFF9F0A), modifier = Modifier.padding(horizontal = 20.dp)) }
            reply?.let { quoted ->
                Row(Modifier.padding(horizontal = 22.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.AutoMirrored.Filled.Reply, null, tint = Color(0xFF8E8E93))
                    Text(quoted.content.take(90), color = Color(0xFF8E8E93), modifier = Modifier.weight(1f).padding(horizontal = 8.dp), maxLines = 2)
                    IconButton(onClick = { reply = null }) { Icon(Icons.Filled.Close, "取消回复") }
                }
            }
            if (attachments.isNotEmpty()) {
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
                    attachments.forEach { item ->
                        Surface(shape = RoundedCornerShape(20.dp), color = Color(0xFF1C1C1E), modifier = Modifier.padding(end = 8.dp)) {
                            Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Filled.Description, null)
                                Text(item.name, maxLines = 1, modifier = Modifier.padding(horizontal = 6.dp).width(120.dp))
                                IconButton(onClick = { attachments = attachments.filterNot { it.id == item.id } }) { Icon(Icons.Filled.Close, "移除 ${item.name}") }
                            }
                        }
                    }
                }
            }
            when {
                room?.isConcluded == true -> Text("深聊已结束，结论已保留", color = Color(0xFF8E8E93), modifier = Modifier.padding(16.dp))
                room != null && !room.members.contains("user") -> Row(Modifier.padding(16.dp)) { Icon(Icons.Filled.Visibility, null, tint = Color(0xFF8E8E93)); Spacer(Modifier.width(8.dp)); Text("正在查看 Bot 之间的对话", color = Color(0xFF8E8E93)) }
                else -> Row(Modifier.padding(horizontal = 10.dp), verticalAlignment = Alignment.Bottom) {
                    Box {
                        Surface(shape = CircleShape, color = Color(0xFF2C2C2E), modifier = Modifier.size(44.dp).clickable(enabled = !uploading && attachments.size < 8) { attachMenu = true }) {
                            Box(contentAlignment = Alignment.Center) {
                                if (uploading) CircularProgressIndicator(Modifier.size(18.dp)) else Icon(Icons.Filled.Add, "添加附件")
                            }
                        }
                        DropdownMenu(attachMenu, { attachMenu = false }) {
                            DropdownMenuItem(text = { Text("选择文件") }, leadingIcon = { Icon(Icons.Filled.Folder, null) }, onClick = { attachMenu = false; files.launch(arrayOf("*/*")) })
                            DropdownMenuItem(text = { Text("照片图库") }, leadingIcon = { Icon(Icons.Filled.Image, null) }, onClick = { attachMenu = false; photos.launch(photoRequest()) })
                        }
                    }
                    Surface(shape = RoundedCornerShape(25.dp), color = Color(0xFF2C2C2E), modifier = Modifier.weight(1f).padding(horizontal = 8.dp)) {
                        Row(verticalAlignment = Alignment.Bottom) {
                            TextField(text, { text = it }, modifier = Modifier.weight(1f), placeholder = { Text("给 $title 发消息") }, maxLines = 6)
                            if (room?.kind != "dm") {
                                Box {
                                    IconButton(onClick = { targetMenu = true }) { Icon(Icons.Filled.AlternateEmail, "选择消息对象", tint = if (target.isEmpty()) Color(0xFF8E8E93) else Color.White) }
                                    DropdownMenu(targetMenu, { targetMenu = false }) {
                                        DropdownMenuItem(text = { Text("所有成员") }, onClick = { target = ""; targetMenu = false })
                                        store.bots.filter { room?.members?.contains(it.id) == true }.forEach { bot ->
                                            DropdownMenuItem(text = { Text(bot.name) }, onClick = { target = bot.id; targetMenu = false })
                                        }
                                    }
                                }
                            }
                        }
                    }
                    val canSend = store.isConfigured && roomID !in store.sendingRoomIDs && !uploading && (text.isNotBlank() || attachments.isNotEmpty())
                    Surface(shape = CircleShape, color = if (canSend) Color.White else Color(0xFF3A3A3C), modifier = Modifier.size(44.dp).clickable(enabled = canSend) {
                        val content = text.trim()
                        val filesNow = attachments
                        val replyID = reply?.id
                        val targetID = target.ifEmpty { null }
                        nearBottom = true; sentRevision += 1
                        text = ""; attachments = emptyList(); reply = null; localError = null
                        scope.launch { store.sendMessage(roomID, content, filesNow, targetID, replyID) }
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
            if (directBot != null) BotDetailsScreen(store, directBot.id) { showDetails = false }
            else RoomDetailsScreen(store, roomID) { showDetails = false }
        }
    }
}

private fun workingBots(store: SummonStore, roomID: String, room: SummonRoom?, messages: List<SummonMessage>): List<SummonBot> {
    val jobs = if (store.selectedRoomID == roomID) store.jobs else emptyList()
    val replied = messages.filter { !it.isOwn && it.kind != "error" }.mapNotNull { it.jobId }.toSet()
    val ids = jobs.filter { it.isActive && it.id !in replied }.map { it.botId }.toMutableSet()
    for (run in store.agentRuns) {
        if (run.roomId != roomID || !run.isActive) continue
        val botID = run.botId ?: continue
        val detail = store.agentRunDetails[run.id]
        if (detail != null && !detail.isActive) continue
        val job = jobs.firstOrNull { it.taskId == run.id || it.agentRunId == run.id }
        if (job != null) {
            if (job.isActive && job.id !in replied) ids += botID
        } else ids += botID
    }
    for (pending in store.pendingMessages) {
        if (pending.roomID != roomID || pending.status !in setOf("sending", "sent")) continue
        val chosen = pending.message.toBotId
        if (chosen != null) ids += chosen else ids += room?.members.orEmpty()
    }
    return store.bots.filter { it.id in ids && !it.isPaused }
}

private fun workingStatus(store: SummonStore, roomID: String, bot: SummonBot, now: Instant): String {
    val job = if (store.selectedRoomID == roomID) store.jobs.lastOrNull { it.botId == bot.id && it.isActive } else null
    val run = store.agentRuns.lastOrNull {
        it.roomId == roomID && it.botId == bot.id && it.isActive && (job?.taskId == null || job.taskId == it.id || job.agentRunId == it.id)
    }
    val runID = job?.taskId ?: job?.agentRunId ?: run?.id
    val detail = runID?.let { store.agentRunDetails[it] }
    val status = detail?.status ?: run?.status ?: job?.status
    (run?.activity ?: detail?.activity)?.get("label")?.string?.let { return it }
    if (status == "queued") return "等待执行"
    if (status == "accepted") return "已接收，准备处理"
    if (status == "waiting") return "正在等待答复或外部结果"
    return "正在分析任务并准备下一步"
}

@Composable
private fun rememberNow(): androidx.compose.runtime.State<Instant> {
    val state = remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(6_000)
            state.value = Instant.now()
        }
    }
    return state
}

@Composable
private fun MessageRow(store: SummonStore, roomID: String, message: SummonMessage, onReply: () -> Unit) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val bot = store.bots.firstOrNull { it.id == message.senderId }
    val pending = store.pendingMessages.firstOrNull { it.clientID == message.clientId }
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (message.isOwn) Alignment.End else Alignment.Start) {
        Row(verticalAlignment = Alignment.Top) {
            if (!message.isOwn) {
                if (bot != null) MemberAvatar(bot, 28.dp) else Box(Modifier.size(28.dp))
                Spacer(Modifier.width(10.dp))
            }
            Column(horizontalAlignment = if (message.isOwn) Alignment.End else Alignment.Start, modifier = Modifier.weight(1f, fill = false)) {
                Row {
                    Text(if (message.isOwn) store.settings.userName else bot?.name ?: "系统", style = MaterialTheme.typography.labelMedium, color = Color(0xFF8E8E93))
                    Spacer(Modifier.width(8.dp))
                    Text(formatSummonTime(message.createdAt), style = MaterialTheme.typography.labelSmall, color = Color(0xFF636366))
                }
                message.replyTo?.let { replyID ->
                    val quoted = store.messagesForRoom(roomID).firstOrNull { it.id == replyID }
                    if (quoted != null && quoted.senderId != message.senderId && store.bot(quoted.senderId) != null) {
                        Text("${store.name(quoted.senderId)}：${quoted.content}", color = Color(0xFF8E8E93), maxLines = 3, modifier = Modifier.padding(vertical = 4.dp).background(Color(0xFF1C1C1E), RoundedCornerShape(12.dp)).padding(10.dp))
                    }
                }
                if (message.content.isNotEmpty()) {
                    SelectionContainer {
                        Text(
                            message.content,
                            modifier = Modifier
                                .clickable { menu = true }
                                .background(Color(0xFF1C1C1E), RoundedCornerShape(21.dp))
                                .padding(horizontal = if (message.isOwn) 14.dp else 10.dp, vertical = if (message.isOwn) 14.dp else 12.dp),
                        )
                    }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text("回复") }, leadingIcon = { Icon(Icons.AutoMirrored.Filled.Reply, null) }, onClick = { menu = false; onReply() })
                        DropdownMenuItem(text = { Text("复制") }, leadingIcon = { Icon(Icons.Filled.ContentCopy, null) }, onClick = { menu = false; clipboard.setText(AnnotatedString(message.content)) })
                        DropdownMenuItem(text = { Text("分享") }, leadingIcon = { Icon(Icons.Filled.Share, null) }, onClick = { menu = false; shareText(context, message.content) })
                    }
                }
                message.attachments.forEach { AttachmentRow(store, it) }
                if (pending != null && pending.status != "sent") {
                    if (pending.status == "sending") Text("正在发送…", color = Color(0xFF8E8E93), style = MaterialTheme.typography.labelSmall)
                    else {
                        Text(pending.error ?: "尚未确认送达", color = Color(0xFFFF9F0A), style = MaterialTheme.typography.labelSmall)
                        TextButton(onClick = { kotlinx.coroutines.MainScope().launch { store.retryMessage(pending.clientID) } }) { Text("重试发送") }
                    }
                }
            }
        }
    }
}

@Composable
private fun AttachmentRow(store: SummonStore, attachment: SummonAttachment) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var preview by remember(attachment.id) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var downloading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var file by remember { mutableStateOf<java.io.File?>(null) }
    LaunchedEffect(attachment.id) {
        if (attachment.previewUrl == null) return@LaunchedEffect
        runCatching {
            val bytes = store.attachmentPreview(attachment)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull()?.let { preview = it }
    }
    Column {
        preview?.let {
            Image(it.asImageBitmap(), null, Modifier.fillMaxWidth().heightIn(max = 260.dp).clip(RoundedCornerShape(14.dp)))
        }
        Row(Modifier.fillMaxWidth().clickable(enabled = !downloading) {
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
                Text(formatBytes(attachment.size), color = Color(0xFF8E8E93), style = MaterialTheme.typography.labelSmall)
            }
            Icon(Icons.Filled.Download, null, tint = Color(0xFF8E8E93))
        }
        file?.let { saved -> TextButton(onClick = { shareFile(context, saved, attachment.mimeType) }) { Icon(Icons.Filled.Share, null); Text("分享文件") } }
        error?.let { Text(it, color = Color(0xFFFF9F0A)) }
    }
}

private suspend fun uploadUris(
    store: SummonStore,
    uris: List<Uri>,
    current: List<SummonAttachment>,
    update: (List<SummonAttachment>) -> Unit,
    error: (String) -> Unit,
    busy: (Boolean) -> Unit,
) {
    if (uris.isEmpty()) return
    busy(true)
    var next = current
    try {
        for (uri in uris) {
            if (next.size >= 8) { error("每条消息最多添加 8 个附件。"); break }
            next = next + store.uploadAttachment(uri)
            update(next)
        }
    } catch (exception: Exception) {
        error(exception.message ?: "附件上传失败")
    } finally { busy(false) }
}

private val androidx.compose.runtime.State<Instant>.valueEpoch get() = value
