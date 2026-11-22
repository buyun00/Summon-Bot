package org.lin0.relay

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

private data class ActiveBotStatus(
    val key: String,
    val bot: SummonBot?,
    val name: String,
    val status: String,
    val ref: SummonReference?,
)

@Composable
fun ChatScreen(store: SummonStore, roomID: String, onBack: () -> Unit) {
    val palette = LocalSummonPalette.current
    val scope = rememberCoroutineScope()
    val room = store.room(roomID)
    val roomBots = room?.members?.mapNotNull { store.bot(it) }.orEmpty()
    val directBot = room?.takeIf { !it.isGroup }?.members?.firstNotNullOfOrNull { store.bot(it) }
    val title = room?.name ?: "聊天"
    val messages = store.messagesForRoom(roomID)
    val roomExecutions = store.executionsForRoom(roomID)
    val activeBotItems = remember(roomExecutions, store.bots) {
        val seen = mutableSetOf<String>()
        val items = mutableListOf<ActiveBotStatus>()
        for (exec in store.activeExecutionsForRoom(roomID)) {
            val botId = exec["execution_actor"]["id"].string ?: exec["bot_id"].string.orEmpty()
            val ref = SummonReference.parse(exec["execution_ref"])
            val key = botId.ifEmpty { ref?.id ?: exec.pretty }
            if (!seen.add(key)) continue
            val bot = botId.takeIf { it.isNotEmpty() }?.let { store.bot(it) }
            val name = bot?.name ?: if (botId.isEmpty()) "执行会话" else store.name(botId)
            items += ActiveBotStatus(key, bot, name, summonStatus(exec["status"].stringValue), ref)
        }
        items
    }
    val pendingInputExec = roomExecutions.firstOrNull { it["status"].stringValue in setOf("needs_input", "awaiting_input") }
    val composerAccent = remember(directBot, roomBots) {
        val bot = directBot ?: roomBots.firstOrNull()
        summonColor(bot?.resolvedAvatar?.color ?: SummonAvatar().color)
    }
    val text = store.draft(roomID)
    val attachments = store.draftAttachments[roomID].orEmpty()
    val mentions = store.draftMentions[roomID].orEmpty()
    val references = store.draftReferences[roomID].orEmpty()
    val replyID = store.draftReplies[roomID]
    var staging by remember(roomID) { mutableStateOf(false) }
    var localError by remember(roomID) { mutableStateOf<String?>(null) }
    var showDetails by remember(roomID) { mutableStateOf(false) }
    var activeExecutionRef by remember(roomID) { mutableStateOf<SummonReference?>(null) }
    var executionsExpanded by remember(roomID) { mutableStateOf(false) }
    var showReferences by remember(roomID) { mutableStateOf(false) }
    var attachMenu by remember { mutableStateOf(false) }
    var targetMenu by remember { mutableStateOf(false) }
    var nearBottom by remember { mutableStateOf(true) }
    val listState = rememberLazyListState()
    val dragging by listState.interactionSource.collectIsDraggedAsState()
    var sentRevision by remember(roomID) { mutableIntStateOf(0) }

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
                    if (settings.baseURL != store.settings.baseURL) {
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
    DisposableEffect(roomID) {
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

    val density = LocalDensity.current
    val statusBarTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    var composerHeightPx by remember { mutableIntStateOf(0) }
    val topBarClearance = statusBarTop + 62.dp
    val bottomClearance = with(density) { composerHeightPx.toDp() }.coerceAtLeast(86.dp) + 12.dp

    Box(Modifier.fillMaxSize().background(palette.background).imePadding()) {
        // Layer 1: Full-bleed chat stream with soft progressive fade at top & bottom edges
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
                .drawWithContent {
                    drawContent()
                    val topFadePx = (topBarClearance + 22.dp).toPx().coerceAtMost(size.height * 0.35f)
                    if (topFadePx > 1f) {
                        drawRect(
                            brush = Brush.verticalGradient(
                                0f to Color.Transparent,
                                0.55f to Color.Black.copy(alpha = 0.28f),
                                1f to Color.Black,
                                startY = 0f,
                                endY = topFadePx,
                            ),
                            size = androidx.compose.ui.geometry.Size(size.width, topFadePx),
                            blendMode = BlendMode.DstIn,
                        )
                    }
                    val bottomFadePx = (bottomClearance + 26.dp).toPx().coerceAtMost(size.height * 0.42f)
                    if (bottomFadePx > 1f) {
                        val startY = (size.height - bottomFadePx).coerceAtLeast(0f)
                        drawRect(
                            brush = Brush.verticalGradient(
                                0f to Color.Black,
                                0.38f to Color.Black.copy(alpha = 0.35f),
                                0.72f to Color.Black.copy(alpha = 0.08f),
                                1f to Color.Transparent,
                                startY = startY,
                                endY = size.height,
                            ),
                            topLeft = androidx.compose.ui.geometry.Offset(0f, startY),
                            size = androidx.compose.ui.geometry.Size(size.width, size.height - startY),
                            blendMode = BlendMode.DstIn,
                        )
                    }
                },
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = topBarClearance + 8.dp, bottom = bottomClearance),
        ) {
            if (messages.isEmpty() && !store.isLoading) {
                item {
                    Text(
                        "开始聊天\n发一条消息给 $title。",
                        color = palette.textSecondary,
                        modifier = Modifier.padding(top = 70.dp, start = 4.dp),
                    )
                }
            }
            if (store.canLoadOlder(roomID)) {
                item {
                    TextButton(onClick = { scope.launch { store.loadRoom(roomID, older = true) } }, enabled = store.protocolReady) {
                        Text("加载更早消息")
                    }
                }
            }
            items(messages, key = { it.id }) { message ->
                MessageRow(store, roomID, message) { store.setDraftReply(message.id, roomID) }
                Spacer(Modifier.height(18.dp))
            }
            if (roomExecutions.isNotEmpty()) {
                item(key = "room-executions") {
                        Surface(
                            shape = RoundedCornerShape(16.dp),
                            color = palette.surface,
                            border = BorderStroke(0.7.dp, palette.bubbleStroke),
                            modifier = Modifier.fillMaxWidth().animateContentSize(spring(stiffness = Spring.StiffnessMediumLow)),
                        ) {
                            Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                                Row(
                                    Modifier.fillMaxWidth().clickable { executionsExpanded = !executionsExpanded },
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Icon(Icons.Filled.Terminal, null, tint = palette.textSecondary, modifier = Modifier.size(16.dp))
                                    Text(
                                        "执行过程（${roomExecutions.size}）",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = palette.textSecondary,
                                        modifier = Modifier.weight(1f),
                                    )
                                    Icon(
                                        if (executionsExpanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                                        null,
                                        tint = palette.textTertiary,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                                if (executionsExpanded) {
                                    Spacer(Modifier.height(8.dp))
                                    roomExecutions.forEach { exec ->
                                        val ref = SummonReference.parse(exec["execution_ref"]) ?: return@forEach
                                        val status = exec["status"].stringValue
                                        val actorId = exec["execution_actor"]["id"].string ?: exec["bot_id"].string
                                        val actorName = actorId?.let { store.name(it) } ?: "执行会话"
                                        val engineName = if (exec["kind"].string == "conversation") "内部对话" else exec["engine"].string ?: "执行"
                                        Row(
                                            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                                                .clickable { activeExecutionRef = ref }
                                                .padding(vertical = 7.dp, horizontal = 4.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                                        ) {
                                            actorId?.let { store.bot(it) }?.let { bot ->
                                                MemberAvatar(bot, 22.dp, motion = if (status in setOf("running", "waiting", "queued")) "work" else "idle")
                                            }
                                            Column(Modifier.weight(1f)) {
                                                Text("$engineName · $actorName", style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                                Text(
                                                    summonStatus(status),
                                                    style = MaterialTheme.typography.labelSmall,
                                                    color = when (status) {
                                                        "completed" -> palette.ok
                                                        "needs_input", "awaiting_input" -> palette.warn
                                                        else -> palette.textSecondary
                                                    },
                                                )
                                            }
                                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = palette.textTertiary, modifier = Modifier.size(16.dp))
                                        }
                                    }
                                }
                            }
                        }
                        Spacer(Modifier.height(12.dp))
                    }
                }
        }

        // Layer 2: Soft top backdrop gradient + compact floating header capsule (no big bar, no top-right button)
        Box(
            Modifier
                .fillMaxWidth()
                .height(topBarClearance + 18.dp)
                .align(Alignment.TopCenter)
                .background(
                    Brush.verticalGradient(
                        0f to palette.background.copy(alpha = 0.92f),
                        0.55f to palette.background.copy(alpha = 0.58f),
                        1f to Color.Transparent,
                    )
                ),
        )
        Box(
            Modifier
                .fillMaxWidth()
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(horizontal = 14.dp, vertical = 8.dp),
        ) {
            Surface(
                shape = CircleShape,
                color = palette.glassPill,
                border = BorderStroke(0.8.dp, palette.bubbleStroke),
                shadowElevation = 2.dp,
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .size(40.dp)
                    .clip(CircleShape)
                    .clickable(onClick = onBack),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.AutoMirrored.Filled.ArrowBack,
                        "返回",
                        tint = MaterialTheme.colorScheme.onBackground,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            Surface(
                shape = CircleShape,
                color = palette.glassPill,
                border = BorderStroke(0.8.dp, palette.bubbleStroke),
                shadowElevation = 2.dp,
                modifier = Modifier
                    .align(Alignment.Center)
                    .clip(CircleShape)
                    .clickable { showDetails = true },
            ) {
                Row(
                    Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    if (directBot != null) {
                        MemberAvatar(directBot, 24.dp)
                    } else if (room != null) {
                        RoomAvatar(room, store.bots, 24.dp, showOutline = false)
                    }
                    Text(
                        title,
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.widthIn(max = 190.dp),
                    )
                }
            }
        }

        // Layer 3: Soft bottom backdrop fade + centered scroll-to-bottom button + rock-steady glass pill composer
        Column(
            Modifier
                .fillMaxWidth()
                .align(Alignment.BottomCenter),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            AnimatedVisibility(
                visible = !nearBottom && messages.isNotEmpty(),
                enter = fadeIn(),
                exit = fadeOut(),
            ) {
                Surface(
                    shape = CircleShape,
                    color = palette.glassPill,
                    border = BorderStroke(0.8.dp, palette.bubbleStroke),
                    shadowElevation = 2.dp,
                    modifier = Modifier.padding(bottom = 8.dp).size(38.dp).clip(CircleShape).clickable {
                        nearBottom = true
                        scope.launch { listState.animateScrollToItem((listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0)) }
                    },
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.ExpandMore, "回到最新消息", tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(22.dp))
                    }
                }
            }
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(
                        Brush.verticalGradient(
                            0f to Color.Transparent,
                            0.28f to palette.background.copy(alpha = 0.72f),
                            0.58f to palette.background.copy(alpha = 0.94f),
                            1f to palette.background,
                        )
                    )
                    .onSizeChanged { composerHeightPx = it.height }
                    .navigationBarsPadding()
                    .padding(top = 18.dp, bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
            localError?.let { Text(it, color = palette.warn, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 20.dp)) }
            store.protocolNotice?.let { notice ->
                Text(notice, color = palette.warn, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 20.dp))
            }
            AnimatedVisibility(
                visible = activeBotItems.isNotEmpty(),
                enter = fadeIn() + slideInVertically { it / 2 },
                exit = fadeOut(),
            ) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    activeBotItems.forEach { item ->
                        Box(Modifier.clip(RoundedCornerShape(12.dp)).clickable {
                            if (item.ref != null) activeExecutionRef = item.ref else showDetails = true
                        }) {
                            BotWorkingIndicator(item.bot, item.name, item.status, motion = "work")
                        }
                    }
                }
            }
            if (pendingInputExec != null) {
                val pendingRef = SummonReference.parse(pendingInputExec["execution_ref"])
                if (pendingRef != null) {
                    Surface(
                        shape = RoundedCornerShape(16.dp),
                        color = palette.glassPill,
                        border = BorderStroke(0.8.dp, palette.warn.copy(alpha = 0.45f)),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp).clip(RoundedCornerShape(16.dp))
                            .clickable { activeExecutionRef = pendingRef },
                    ) {
                        Row(
                            Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(Icons.AutoMirrored.Filled.HelpOutline, null, tint = palette.warn, modifier = Modifier.size(18.dp))
                            Text("有待处理的确认或输入请求", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                            Text("去回复", style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = palette.warn)
                        }
                    }
                }
            }
            replyID?.let { id ->
                val quoted = messages.firstOrNull { it.id == id }
                Surface(
                    shape = RoundedCornerShape(14.dp),
                    color = palette.surface,
                    border = BorderStroke(0.6.dp, palette.bubbleStroke),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp),
                ) {
                    Row(Modifier.padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.AutoMirrored.Filled.Reply, null, tint = palette.textSecondary, modifier = Modifier.size(16.dp))
                        Text(
                            quoted?.content?.take(90) ?: "回复消息",
                            color = palette.textSecondary,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                            maxLines = 2,
                        )
                        IconButton(onClick = { store.setDraftReply(null, roomID) }) {
                            Icon(Icons.Filled.Close, "取消回复", tint = palette.textSecondary, modifier = Modifier.size(18.dp))
                        }
                    }
                }
            }
            if (attachments.isNotEmpty() || references.isNotEmpty() || mentions.isNotEmpty()) {
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 14.dp)) {
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
                room != null && !room.members.contains("user") -> Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Visibility, null, tint = palette.textSecondary)
                    Spacer(Modifier.width(8.dp))
                    Text("正在查看 Bot 之间的对话", color = palette.textSecondary)
                }
                else -> Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box {
                        Surface(
                            shape = CircleShape,
                            color = palette.glassPill,
                            border = BorderStroke(0.8.dp, palette.bubbleStroke),
                            modifier = Modifier.size(46.dp).clip(CircleShape).clickable(enabled = !staging) { attachMenu = true },
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                if (staging) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                else Icon(Icons.Filled.Add, "添加附件", tint = MaterialTheme.colorScheme.onSurface)
                            }
                        }
                        DropdownMenu(attachMenu, { attachMenu = false }) {
                            DropdownMenuItem(text = { Text("选择文件") }, enabled = attachments.size < 8, leadingIcon = { Icon(Icons.Filled.Folder, null) }, onClick = { attachMenu = false; files.launch(arrayOf("*/*")) })
                            DropdownMenuItem(text = { Text("照片图库") }, enabled = attachments.size < 8, leadingIcon = { Icon(Icons.Filled.Image, null) }, onClick = { attachMenu = false; photos.launch(photoRequest()) })
                            DropdownMenuItem(text = { Text("引用资料") }, enabled = store.protocolReady, leadingIcon = { Icon(Icons.Filled.Link, null) }, onClick = { attachMenu = false; showReferences = true })
                        }
                    }
                    Surface(
                        shape = RoundedCornerShape(25.dp),
                        color = palette.glassPill,
                        border = BorderStroke(0.8.dp, palette.bubbleStroke),
                        modifier = Modifier.weight(1f),
                    ) {
                        Row(verticalAlignment = Alignment.Bottom) {
                            TextField(
                                value = text,
                                onValueChange = { store.setDraft(it, roomID) },
                                modifier = Modifier.weight(1f),
                                placeholder = { Text("给 $title 发消息", color = palette.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                maxLines = 6,
                                colors = TextFieldDefaults.colors(
                                    focusedContainerColor = Color.Transparent,
                                    unfocusedContainerColor = Color.Transparent,
                                    disabledContainerColor = Color.Transparent,
                                    focusedIndicatorColor = Color.Transparent,
                                    unfocusedIndicatorColor = Color.Transparent,
                                    disabledIndicatorColor = Color.Transparent,
                                ),
                            )
                            if (room != null) {
                                Box {
                                    IconButton(onClick = { targetMenu = true }) {
                                        Icon(
                                            Icons.Filled.AlternateEmail,
                                            "@ 成员",
                                            tint = if (mentions.isEmpty()) palette.textSecondary else MaterialTheme.colorScheme.onSurface,
                                        )
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
                    Surface(
                        shape = CircleShape,
                        color = if (canSend) composerAccent else palette.surface,
                        border = if (canSend) null else BorderStroke(0.8.dp, palette.bubbleStroke),
                        modifier = Modifier.size(46.dp).clip(CircleShape).clickable(enabled = canSend) {
                            nearBottom = true; sentRevision += 1; localError = null
                            scope.launch { store.sendMessage(roomID) }
                        },
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(
                                Icons.AutoMirrored.Filled.Send,
                                "发送消息",
                                tint = if (canSend) Color.White else palette.textTertiary,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }
            }
        }
    }
    if (showDetails) {
        BackHandler { showDetails = false }
        Surface(Modifier.fillMaxSize(), color = palette.background) {
            RoomDetailsScreen(store, roomID) { showDetails = false }
        }
    }
    activeExecutionRef?.let { ref ->
        SummonReferenceDialog(store, ref) { activeExecutionRef = null }
    }
    if (showReferences) SummonReferencePicker(store, roomID, onSelect = { ref ->
        if (ref !in references) store.setDraftReferences(references + ref, roomID)
        showReferences = false
    }, onDismiss = { showReferences = false })
}

@Composable
private fun DraftToken(title: String, remove: () -> Unit) {
    val palette = LocalSummonPalette.current
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = palette.surface,
        border = BorderStroke(0.7.dp, palette.bubbleStroke),
        modifier = Modifier.padding(end = 8.dp),
    ) {
        Row(Modifier.padding(start = 12.dp, end = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall, modifier = Modifier.widthIn(max = 140.dp))
            IconButton(onClick = remove, modifier = Modifier.size(30.dp)) {
                Icon(Icons.Filled.Close, "移除 $title", tint = palette.textSecondary, modifier = Modifier.size(15.dp))
            }
        }
    }
}

private sealed interface AndroidMessageSegment {
    data class Plain(val text: String) : AndroidMessageSegment
    data class Code(val language: String, val code: String) : AndroidMessageSegment
}

private fun parseMessageSegments(source: String): List<AndroidMessageSegment> {
    val lines = source.split('\n')
    val segments = mutableListOf<AndroidMessageSegment>()
    val textBuf = mutableListOf<String>()
    val codeBuf = mutableListOf<String>()
    var inCode = false
    var language = ""
    fun flushText() {
        val joined = textBuf.joinToString("\n").trim()
        if (joined.isNotEmpty()) segments += AndroidMessageSegment.Plain(joined)
        textBuf.clear()
    }
    for (line in lines) {
        val trimmed = line.trim()
        if (trimmed.startsWith("```")) {
            if (inCode) {
                segments += AndroidMessageSegment.Code(language, codeBuf.joinToString("\n"))
                codeBuf.clear(); language = ""; inCode = false
            } else {
                flushText()
                language = trimmed.removePrefix("```").trim()
                inCode = true
            }
        } else if (inCode) {
            codeBuf += line
        } else {
            textBuf += line
        }
    }
    if (inCode) segments += AndroidMessageSegment.Code(language, codeBuf.joinToString("\n")) else flushText()
    return segments.ifEmpty { listOf(AndroidMessageSegment.Plain(source)) }
}

@Composable
private fun CodeBlockCard(language: String, code: String) {
    val palette = LocalSummonPalette.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var copied by remember(code) { mutableStateOf(false) }

    Surface(
        shape = RoundedCornerShape(12.dp),
        color = palette.codeBg,
        border = BorderStroke(0.7.dp, palette.bubbleStroke),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    if (language.isBlank()) "代码" else language.uppercase(),
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.textSecondary,
                )
                Row(
                    Modifier.clip(RoundedCornerShape(8.dp)).clickable {
                        clipboard.setText(AnnotatedString(code))
                        copied = true
                        scope.launch { delay(1400); copied = false }
                    }.padding(horizontal = 6.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(
                        if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy,
                        "复制代码",
                        tint = if (copied) palette.ok else palette.textSecondary,
                        modifier = Modifier.size(13.dp),
                    )
                    Text(
                        if (copied) "已复制" else "复制",
                        fontSize = 11.sp,
                        color = if (copied) palette.ok else palette.textSecondary,
                    )
                }
            }
            HorizontalDivider(thickness = 0.6.dp, color = palette.hairline)
            Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(12.dp)) {
                Text(
                    code,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    lineHeight = 20.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MessageRow(store: SummonStore, roomID: String, message: SummonMessage, onReply: () -> Unit) {
    val palette = LocalSummonPalette.current
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
    var showSummaries by remember(message.id) { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (message.isOwn) Alignment.End else Alignment.Start) {
        Row(verticalAlignment = Alignment.Top) {
            if (!message.isOwn) {
                if (bot != null) MemberAvatar(bot, 28.dp) else Icon(Icons.Filled.Info, null, Modifier.size(28.dp), tint = palette.textSecondary)
                Spacer(Modifier.width(10.dp))
            }
            Column(
                horizontalAlignment = if (message.isOwn) Alignment.End else Alignment.Start,
                verticalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.weight(1f, fill = false),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(store.name(message.senderId), style = MaterialTheme.typography.labelMedium, color = palette.textSecondary)
                    Text(formatSummonTime(message.createdAt), style = MaterialTheme.typography.labelSmall, color = palette.textTertiary)
                    if (saved) {
                        Box {
                            Icon(
                                Icons.Filled.MoreHoriz,
                                "消息操作",
                                tint = palette.textTertiary,
                                modifier = Modifier.size(18.dp).clip(CircleShape).clickable { menu = true },
                            )
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
                }
                message.replyTo?.let { id ->
                    val quoted = store.messagesForRoom(roomID).firstOrNull { it.id == id }
                    if (quoted != null) {
                        Row(
                            Modifier.clip(RoundedCornerShape(12.dp)).background(palette.quoteBg).height(IntrinsicSize.Min)
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Box(Modifier.width(2.5.dp).fillMaxHeight().clip(CircleShape).background(palette.ok))
                            Text(
                                store.name(quoted.senderId) + "：" + quoted.content,
                                color = palette.textSecondary,
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 3,
                            )
                        }
                    } else {
                        TextButton(onClick = { reference = SummonReference("event", id) }) { Text("查看引用的消息") }
                    }
                }
                if (message.mentions.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        message.mentions.forEach { id ->
                            Surface(shape = CircleShape, color = palette.ok.copy(alpha = 0.14f)) {
                                Text(
                                    "@" + store.name(id),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = palette.ok,
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                                )
                            }
                        }
                    }
                }
                if (message.content.isNotEmpty()) {
                    val bubbleShape = RoundedCornerShape(
                        topStart = 20.dp,
                        topEnd = 20.dp,
                        bottomStart = if (message.isOwn) 20.dp else 6.dp,
                        bottomEnd = if (message.isOwn) 6.dp else 20.dp,
                    )
                    val segments = remember(message.content) { parseMessageSegments(message.content) }
                    Surface(
                        shape = bubbleShape,
                        color = if (message.isOwn) palette.userBubble else palette.botBubble,
                        border = if (message.isOwn) null else BorderStroke(0.7.dp, palette.bubbleStroke),
                    ) {
                        SelectionContainer {
                            Column(Modifier.padding(horizontal = 14.dp, vertical = 11.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                segments.forEach { segment ->
                                    when (segment) {
                                        is AndroidMessageSegment.Plain -> Text(
                                            segment.text,
                                            color = if (message.isOwn) palette.userBubbleText else MaterialTheme.colorScheme.onSurface,
                                        )
                                        is AndroidMessageSegment.Code -> CodeBlockCard(segment.language, segment.code)
                                    }
                                }
                            }
                        }
                    }
                }
                message.attachments.forEach { AttachmentRow(store, it) }
                message.references.forEach { item ->
                    Surface(
                        shape = CircleShape,
                        color = palette.surface,
                        border = BorderStroke(0.7.dp, palette.bubbleStroke),
                        modifier = Modifier.clip(CircleShape).clickable { reference = item },
                    ) {
                        Row(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(Icons.Filled.Link, null, tint = palette.textSecondary, modifier = Modifier.size(14.dp))
                            Text(store.label(item), style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                val summaries = store.summaryFacts(message.id)
                if (saved && summaries.isNotEmpty()) {
                    Column(
                        horizontalAlignment = if (message.isOwn) Alignment.End else Alignment.Start,
                        verticalArrangement = Arrangement.spacedBy(5.dp),
                        modifier = Modifier.animateContentSize(),
                    ) {
                        Surface(
                            shape = CircleShape,
                            color = palette.surface,
                            border = BorderStroke(0.7.dp, palette.bubbleStroke),
                            modifier = Modifier.clip(CircleShape).clickable { showSummaries = !showSummaries },
                        ) {
                            Row(
                                Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Text(
                                    if (summaries.size == 1) "快读摘要 · " + store.name(summaries[0].botId) else "快读摘要 · ${summaries.size} 位伙伴",
                                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                                    color = palette.textSecondary,
                                    maxLines = 1,
                                )
                                if (!showSummaries) {
                                    Text(
                                        summaries.first().summary,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = palette.textSecondary,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f, fill = false),
                                    )
                                }
                                Icon(
                                    if (showSummaries) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                                    if (showSummaries) "收起摘要" else "展开摘要",
                                    tint = palette.textTertiary,
                                    modifier = Modifier.size(15.dp),
                                )
                            }
                        }
                        if (showSummaries) {
                            Surface(
                                shape = RoundedCornerShape(12.dp),
                                color = palette.botBubble,
                                border = BorderStroke(0.7.dp, palette.bubbleStroke),
                            ) {
                                Column(
                                    Modifier.padding(horizontal = 11.dp, vertical = 8.dp),
                                    verticalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    summaries.forEach { item ->
                                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                            Text(
                                                store.name(item.botId),
                                                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                                                color = MaterialTheme.colorScheme.onSurface,
                                            )
                                            Text(
                                                item.summary,
                                                style = MaterialTheme.typography.bodySmall,
                                                color = palette.textSecondary,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if (pending != null && pending.status != "sent") {
                    if (pending.status == "sending") {
                        Text("正在发送…", style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                    } else {
                        Text(pending.error ?: "保存状态待确认", color = palette.warn, style = MaterialTheme.typography.labelSmall)
                        if (pending.status == "rejected") {
                            TextButton(onClick = {
                                try { store.restoreRejectedMessage(pending) }
                                catch (failure: Exception) { error = failure.localizedMessage }
                            }) { Text("转回草稿") }
                        } else {
                            TextButton(
                                enabled = store.protocolReady && roomID !in store.sendingRoomIDs,
                                onClick = { scope.launch { store.retryMessage(pending.clientID) } },
                            ) { Text("查询并重试") }
                        }
                    }
                } else if (message.isOwn) {
                    val deliveries = store.deliveryFacts(message.id)
                    if (deliveries.isEmpty()) {
                        Text("消息已保存", style = MaterialTheme.typography.labelSmall, color = palette.textTertiary)
                    } else {
                        Column(horizontalAlignment = Alignment.End, modifier = Modifier.animateContentSize()) {
                            Text(
                                if (showDelivery) "消息已保存 ▴" else "消息已保存 ▾",
                                style = MaterialTheme.typography.labelSmall,
                                color = palette.textSecondary,
                                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { showDelivery = !showDelivery }.padding(horizontal = 4.dp, vertical = 2.dp),
                            )
                            if (showDelivery) {
                                deliveries.forEach { fact ->
                                    Text(
                                        store.name(fact.botId) + " · " + summonStatus(fact.status),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = palette.textSecondary,
                                    )
                                }
                            }
                        }
                    }
                }
                store.deliveryFacts(message.id).forEach { fact ->
                    fact.diagnostic?.let { diagnostic ->
                        Text(store.name(fact.botId) + " · " + diagnostic,
                            style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                    }
                }
                error?.let { Text(it, color = palette.warn, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
    reference?.let { SummonReferenceDialog(store, it) { reference = null } }
}

@Composable
private fun AttachmentRow(store: SummonStore, attachment: SummonAttachment) {
    val palette = LocalSummonPalette.current
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
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        preview?.let {
            Image(it.asImageBitmap(), null, Modifier.fillMaxWidth().heightIn(max = 260.dp).clip(RoundedCornerShape(14.dp)))
        }
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = palette.surface,
            border = BorderStroke(0.7.dp, palette.bubbleStroke),
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp))
                .clickable(enabled = !downloading && !attachment.staged && !attachment.unavailable && store.protocolReady) {
                    scope.launch {
                        downloading = true
                        try {
                            val saved = store.attachmentFile(attachment)
                            file = saved
                            shareFile(context, saved, attachment.mimeType)
                        } catch (exception: Exception) { error = exception.message }
                        finally { downloading = false }
                    }
                },
        ) {
            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                if (downloading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Icon(
                    if (attachment.mimeType.startsWith("image/")) Icons.Filled.Image else Icons.Filled.Description,
                    null,
                    tint = palette.textSecondary,
                )
                Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                    Text(attachment.name, maxLines = 2)
                    Text(
                        if (attachment.unavailable) "附件不可用" else formatBytes(attachment.size),
                        color = palette.textSecondary,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                Icon(Icons.Filled.Download, null, tint = palette.textSecondary)
            }
        }
        file?.let { saved ->
            TextButton(onClick = { shareFile(context, saved, attachment.mimeType) }) {
                Icon(Icons.Filled.Share, null); Spacer(Modifier.width(6.dp)); Text("分享文件")
            }
        }
        error?.let { Text(it, color = palette.warn, style = MaterialTheme.typography.bodySmall) }
    }
}
