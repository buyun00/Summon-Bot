package org.lin0.relay

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.Archive
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
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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

private val LIVE_EXECUTION_STATUSES = setOf("opening", "running", "submitted", "waiting", "queued", "needs_input", "awaiting_input")

private fun formatLiveProgress(raw: String?): String {
    val trimmed = raw?.trim().orEmpty()
    if (trimmed.isEmpty()) return "正在处理中"
    if (trimmed.startsWith("正在") || trimmed.startsWith("等待") || trimmed.startsWith("准备") || trimmed.startsWith("已")) {
        return trimmed
    }
    val sep = if (trimmed.first().code in 48..57 || trimmed.first().code in 65..90 || trimmed.first().code in 97..122) " " else ""
    return "正在$sep$trimmed"
}

@Composable
fun ChatScreen(store: SummonStore, roomID: String, onBack: () -> Unit, onOpenModels: () -> Unit = {}) {
    val palette = LocalSummonPalette.current
    val scope = rememberCoroutineScope()
    val room = store.room(roomID)
    val roomBots = room?.members?.mapNotNull { store.bot(it) }.orEmpty()
    val directBot = room?.takeIf { !it.isGroup }?.members?.firstNotNullOfOrNull { store.bot(it) }
    val title = room?.name ?: "聊天"
    val messages = store.messagesForRoom(roomID)
    val roomExecutions = store.executionsForRoom(roomID)
    val roomActivities = store.activitiesForRoom(roomID)
    val activeBotItems = remember(roomActivities, roomExecutions, store.bots, room?.members) {
        val seen = mutableSetOf<String>()
        val items = mutableListOf<ActiveBotStatus>()
        for (activity in roomActivities) {
            val bot = store.bot(activity.botId)
            if (bot?.isPaused == true) continue
            if (!seen.add(activity.botId)) continue
            val name = bot?.name ?: store.name(activity.botId)
            items += ActiveBotStatus(activity.botId, bot, name, activity.text.ifBlank { "正在处理中" }, activity.executionRef)
        }
        for (exec in store.activeExecutionsForRoom(roomID)) {
            val botId = exec["execution_actor"]["id"].string ?: exec["bot_id"].string.orEmpty()
            val bot = botId.takeIf { it.isNotEmpty() }?.let { store.bot(it) }
            if (bot?.isPaused == true) continue
            val ref = SummonReference.parse(exec["execution_ref"])
            val key = botId.ifEmpty { ref?.id ?: exec.pretty }
            if (!seen.add(key)) continue
            val name = bot?.name ?: if (botId.isEmpty()) "执行会话" else store.name(botId)
            val rawStatus = exec["status"].stringValue
            val status = if (rawStatus in setOf("needs_input", "awaiting_input")) {
                val waiting = exec["waiting_summary"].string?.trim().orEmpty()
                if (waiting.isEmpty()) "等待你的输入" else "等待输入：$waiting"
            } else {
                formatLiveProgress(exec["live_progress"].string ?: exec["work_summary"].string)
            }
            items += ActiveBotStatus(key, bot, name, status, ref)
        }
        if (directBot != null && !directBot.isPaused && seen.add(directBot.id)) {
            when (directBot.resolvedActivity) {
                "working" -> items += ActiveBotStatus(directBot.id, directBot, directBot.name, "正在处理中", null)
                "error" -> items += ActiveBotStatus(directBot.id, directBot, directBot.name, "运行异常", null)
            }
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
    var activityTickerIndex by remember(roomID) { mutableIntStateOf(0) }
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
            itemsIndexed(messages, key = { _, it -> it.id }) { index, message ->
                val previous = if (index > 0) messages[index - 1] else null
                val currentInstant = parseSummonDate(message.createdAt)
                val prevInstant = parseSummonDate(previous?.createdAt)
                val gapSeconds = if (currentInstant != null && prevInstant != null) currentInstant.epochSecond - prevInstant.epochSecond else null
                val showTimeDivider = index == 0 || (gapSeconds != null && gapSeconds >= 300L)
                val grouped = !showTimeDivider && previous?.senderId == message.senderId && (gapSeconds == null || gapSeconds in 0L..120L)
                if (showTimeDivider) {
                    val label = formatSummonDividerTime(message.createdAt)
                    if (label.isNotEmpty()) {
                        Box(
                            Modifier.fillMaxWidth().padding(top = if (index == 0) 4.dp else 18.dp, bottom = 12.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(label, style = MaterialTheme.typography.labelSmall, color = palette.textTertiary)
                        }
                    }
                } else {
                    Spacer(Modifier.height(if (grouped) 6.dp else 16.dp))
                }
                MessageRow(store, roomID, message, previous?.id, grouped) { store.setDraftReply(message.id, roomID) }
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
                visible = executionsExpanded,
                enter = fadeIn() + slideInVertically { it / 2 },
                exit = fadeOut(),
            ) {
                val sortedExecs = remember(roomExecutions) {
                    roomExecutions.sortedWith(
                        compareBy<SummonJson> { if (it["status"].stringValue in LIVE_EXECUTION_STATUSES) 0 else 1 }
                            .thenByDescending { it["updated_at"].string ?: it["created_at"].string.orEmpty() }
                    )
                }
                val liveExecs = sortedExecs.filter { it["status"].stringValue in LIVE_EXECUTION_STATUSES }
                val visibleExecs = liveExecs + sortedExecs.filter { it["status"].stringValue !in LIVE_EXECUTION_STATUSES }.take(3)
                val liveExecBots = liveExecs.mapNotNull { it["execution_actor"]["id"].string ?: it["bot_id"].string }.toSet()
                val syntheticLive = activeBotItems.filter { it.key !in liveExecBots }
                val activeCount = liveExecs.size + syntheticLive.size
                val totalCount = visibleExecs.size + syntheticLive.size
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = palette.glassPill,
                    border = BorderStroke(0.7.dp, palette.bubbleStroke),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp),
                ) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(Icons.Filled.Terminal, null, tint = palette.textSecondary, modifier = Modifier.size(15.dp))
                            Text(
                                if (activeCount > 0) "进行中（$activeCount）" else "最近执行",
                                style = MaterialTheme.typography.labelMedium,
                                color = palette.textSecondary,
                                modifier = Modifier.weight(1f),
                            )
                            IconButton(
                                onClick = { executionsExpanded = false },
                                modifier = Modifier.size(24.dp),
                            ) {
                                Icon(Icons.Filled.Close, "收起执行过程", tint = palette.textSecondary, modifier = Modifier.size(15.dp))
                            }
                        }
                        Spacer(Modifier.height(6.dp))
                        Column(
                            Modifier.fillMaxWidth().heightIn(max = 200.dp).verticalScroll(rememberScrollState()),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            syntheticLive.forEach { item ->
                                Row(
                                    Modifier.fillMaxWidth().padding(vertical = 5.dp, horizontal = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    item.bot?.let { MemberAvatar(it, 22.dp, motion = "work") }
                                    Column(Modifier.weight(1f)) {
                                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                            Text(item.name, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                            Text("进行中", style = MaterialTheme.typography.labelSmall, color = palette.ok)
                                        }
                                        Text(item.status, style = MaterialTheme.typography.labelSmall, color = palette.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    }
                                }
                            }
                            visibleExecs.forEach { exec ->
                                val ref = SummonReference.parse(exec["execution_ref"]) ?: return@forEach
                                val status = exec["status"].stringValue
                                val isLive = status in LIVE_EXECUTION_STATUSES
                                val actorId = exec["execution_actor"]["id"].string ?: exec["bot_id"].string
                                val actorName = actorId?.let { store.name(it) } ?: "执行会话"
                                val engineName = if (exec["kind"].string == "conversation") "内部对话" else exec["engine"].string ?: "执行"
                                val progress = exec["live_progress"].string ?: exec["work_summary"].string ?: exec["waiting_summary"].string
                                Row(
                                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                                        .clickable { activeExecutionRef = ref }
                                        .padding(vertical = 6.dp, horizontal = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    actorId?.let { store.bot(it) }?.let { bot ->
                                        MemberAvatar(bot, 22.dp, motion = if (isLive) "work" else "idle")
                                    }
                                    Column(Modifier.weight(1f)) {
                                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                            Text("$actorName · $engineName", style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                                            Text(
                                                if (isLive) "进行中" else summonStatus(status),
                                                style = MaterialTheme.typography.labelSmall,
                                                color = when {
                                                    isLive || status == "completed" -> palette.ok
                                                    status == "needs_input" || status == "awaiting_input" -> palette.warn
                                                    else -> palette.textSecondary
                                                },
                                            )
                                        }
                                        if (!progress.isNullOrBlank()) {
                                            Text(progress, style = MaterialTheme.typography.labelSmall, color = palette.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        }
                                    }
                                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = palette.textTertiary, modifier = Modifier.size(16.dp))
                                }
                            }
                            if (totalCount == 0) {
                                Text("当前暂无执行记录", style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                            }
                        }
                    }
                }
            }
            LaunchedEffect(activeBotItems.map { it.key }) {
                if (activeBotItems.isEmpty()) {
                    activityTickerIndex = 0
                    return@LaunchedEffect
                }
                if (activityTickerIndex >= activeBotItems.size) activityTickerIndex = 0
                if (activeBotItems.size > 1) {
                    while (true) {
                        delay(3200)
                        activityTickerIndex = (activityTickerIndex + 1) % activeBotItems.size
                    }
                }
            }
            AnimatedVisibility(
                visible = activeBotItems.isNotEmpty(),
                enter = fadeIn() + slideInVertically { it / 2 },
                exit = fadeOut(),
            ) {
                if (activeBotItems.isNotEmpty()) {
                    val safeIndex = activityTickerIndex % activeBotItems.size
                    val current = activeBotItems[safeIndex]
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp)
                            .clip(RoundedCornerShape(14.dp))
                            .clickable { executionsExpanded = !executionsExpanded }
                            .padding(horizontal = 4.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        AnimatedContent(
                            targetState = current,
                            transitionSpec = {
                                (slideInVertically { it } + fadeIn()) togetherWith (slideOutVertically { -it } + fadeOut())
                            },
                            label = "botActivityTicker",
                            modifier = Modifier.weight(1f),
                        ) { item ->
                            BotWorkingIndicator(
                                item.bot,
                                item.name,
                                item.status,
                                motion = if (item.status == "运行异常") "failed" else "work",
                            )
                        }
                        if (activeBotItems.size > 1) {
                            Text(
                                "${safeIndex + 1}/${activeBotItems.size}",
                                style = MaterialTheme.typography.labelSmall,
                                color = palette.textSecondary,
                            )
                        }
                        Text(
                            "停止",
                            style = MaterialTheme.typography.labelSmall,
                            color = palette.textSecondary,
                            modifier = Modifier
                                .clip(CircleShape)
                                .clickable {
                                    scope.launch {
                                        runCatching { store.stopRoom(roomID) }
                                            .onFailure { localError = it.localizedMessage }
                                    }
                                }
                                .padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                        Icon(
                            if (executionsExpanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                            if (executionsExpanded) "收起执行过程" else "展开执行过程",
                            tint = palette.textSecondary,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
            val roomSuspendedRuns = store.suspendedRunsForRoom(roomID)
            if (roomSuspendedRuns.isNotEmpty()) {
                val latestByBot = linkedMapOf<String, SummonJson>()
                roomSuspendedRuns.forEach { run -> latestByBot[run["bot_id"].stringValue] = run }
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    latestByBot.values.forEach { run ->
                        val botName = store.name(run["bot_id"].stringValue)
                        val errCode = run["error"]["code"].stringValue
                        val isAuth = errCode == "auth_expired"
                        val isQuota = errCode == "quota_exhausted"
                        val summary = when {
                            isAuth -> "模型登录已失效"
                            isQuota -> "模型额度已用尽"
                            else -> "暂时无法回复"
                        }
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = palette.warn.copy(alpha = 0.1f),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text("$botName · $summary", style = MaterialTheme.typography.labelSmall, color = palette.warn)
                                val convId = run["conversation_id"].string
                                if (isAuth) {
                                    TextButton(onClick = onOpenModels) { Text("重新登录") }
                                } else if (isQuota) {
                                    TextButton(onClick = onOpenModels) { Text("更换模型") }
                                } else if (convId != null) {
                                    TextButton(onClick = {
                                        scope.launch {
                                            runCatching { store.retrySuspendedRun(convId, run["run_id"].string) }
                                                .onSuccess { localError = null }
                                                .onFailure { localError = it.localizedMessage }
                                        }
                                    }) { Text("重试") }
                                }
                            }
                        }
                    }
                }
            }
            if (pendingInputExec != null) {
                val pendingRef = SummonReference.parse(pendingInputExec["execution_ref"])
                val pendingRequests = pendingInputExec["pending_requests"].array.orEmpty()
                if (pendingRequests.isNotEmpty()) {
                    ExecutionPendingPromptCard(
                        store = store,
                        exec = pendingInputExec,
                        request = pendingRequests.first(),
                        onError = { localError = it },
                    )
                } else if (pendingRef != null) {
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
                room != null && room.isArchived -> Surface(
                    shape = RoundedCornerShape(18.dp),
                    color = palette.glassPill,
                    border = BorderStroke(0.7.dp, palette.bubbleStroke),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
                ) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(Icons.Filled.Archive, null, tint = palette.textSecondary, modifier = Modifier.size(18.dp))
                            Text("该群聊已归档", style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
                        }
                        TextButton(onClick = {
                            scope.launch {
                                runCatching { store.restoreRoom(room) }
                                    .onFailure { localError = it.localizedMessage }
                            }
                        }) { Text("移出归档") }
                    }
                }
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

private val messageLinkRegex = Regex("""\[([^\]\n]{1,200})]\(([^)\s]{1,2048})\)|(https?://[^\s<>"'()]+|/api/(?:files|attachments|workspaces|games)/[^\s<>"'()]+)""")

@Composable
private fun LinkedPlainText(
    text: String,
    color: Color,
    linkColor: Color,
    onOpenLink: (String, String) -> Unit,
) {
    val annotated = remember(text, linkColor) {
        buildAnnotatedString {
            var last = 0
            for (match in messageLinkRegex.findAll(text)) {
                if (match.range.first > last) append(text.substring(last, match.range.first))
                val mdLabel = match.groupValues[1]
                val mdUrl = match.groupValues[2]
                val bareUrl = match.groupValues[3]
                var rawUrl = if (mdLabel.isNotEmpty()) mdUrl else bareUrl
                var trailing = ""
                if (mdLabel.isEmpty()) {
                    val trimmed = rawUrl.trimEnd('.', ',', ';', ':', '!', '?', '。', '，', '；', '：', '！', '？', ')', '）', '】', '》')
                    trailing = rawUrl.substring(trimmed.length)
                    rawUrl = trimmed
                }
                val safe = rawUrl.startsWith("https://") || rawUrl.startsWith("http://") ||
                    rawUrl.startsWith("/api/files/") || rawUrl.startsWith("/api/attachments/") ||
                    rawUrl.startsWith("/api/workspaces/") || rawUrl.startsWith("/api/games/")
                if (safe && rawUrl.isNotEmpty()) {
                    val label = mdLabel.ifEmpty { rawUrl }
                    val targetUrl = rawUrl
                    withLink(
                        LinkAnnotation.Clickable(
                            tag = "link",
                            styles = TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)),
                            linkInteractionListener = { onOpenLink(targetUrl, label) },
                        ),
                    ) { append(label) }
                    if (trailing.isNotEmpty()) append(trailing)
                } else {
                    append(match.value)
                }
                last = match.range.last + 1
            }
            if (last < text.length) append(text.substring(last))
        }
    }
    Text(annotated, color = color)
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

@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
private fun MessageRow(
    store: SummonStore,
    roomID: String,
    message: SummonMessage,
    previousId: String? = null,
    grouped: Boolean = false,
    onReply: () -> Unit,
) {
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
    var error by remember { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (message.isOwn) Alignment.End else Alignment.Start) {
        Row(verticalAlignment = Alignment.Top) {
            if (!message.isOwn) {
                if (grouped) {
                    Spacer(Modifier.width(38.dp))
                } else {
                    if (bot != null) MemberAvatar(bot, 28.dp) else Icon(Icons.Filled.Info, null, Modifier.size(28.dp), tint = palette.textSecondary)
                    Spacer(Modifier.width(10.dp))
                }
            }
            Box(Modifier.weight(1f, fill = false)) {
            Column(
                horizontalAlignment = if (message.isOwn) Alignment.End else Alignment.Start,
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (!message.isOwn && !grouped) {
                    Text(store.name(message.senderId), style = MaterialTheme.typography.labelMedium, color = palette.textSecondary)
                }
                message.replyTo?.takeIf { it != previousId }?.let { id ->
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
                    val uriHandler = LocalUriHandler.current
                    Surface(
                        shape = bubbleShape,
                        color = if (message.isOwn) palette.userBubble else palette.botBubble,
                        border = if (message.isOwn) null else BorderStroke(0.7.dp, palette.bubbleStroke),
                        modifier = Modifier.clip(bubbleShape).combinedClickable(
                            onClick = {},
                            onLongClick = { if (saved) menu = true },
                        ),
                    ) {
                        Column(Modifier.padding(horizontal = 14.dp, vertical = 11.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                segments.forEach { segment ->
                                    when (segment) {
                                        is AndroidMessageSegment.Plain -> LinkedPlainText(
                                            text = segment.text,
                                            color = if (message.isOwn) palette.userBubbleText else MaterialTheme.colorScheme.onSurface,
                                            linkColor = if (message.isOwn) palette.userBubbleText else MaterialTheme.colorScheme.primary,
                                            onOpenLink = { targetUrl, label ->
                                                if (targetUrl.startsWith("http://") || targetUrl.startsWith("https://")) {
                                                    runCatching { uriHandler.openUri(targetUrl) }
                                                        .onFailure { error = it.localizedMessage }
                                                } else if (targetUrl.startsWith("/api/")) {
                                                    scope.launch {
                                                        try {
                                                            val fileName = label.substringAfterLast('/').ifBlank { "file" }
                                                            val downloaded = store.downloadRelativePath(targetUrl, fileName)
                                                            shareFile(context, downloaded, "application/octet-stream")
                                                        } catch (failure: Exception) {
                                                            error = failure.localizedMessage
                                                        }
                                                    }
                                                }
                                            },
                                        )
                                        is AndroidMessageSegment.Code -> CodeBlockCard(segment.language, segment.code)
                                    }
                                }
                            }
                    }
                }
                if (!message.isOwn && message.prompt != null && !message.prompt["questions"].array.isNullOrEmpty()) {
                    MessagePromptCard(store, roomID, message, message.prompt)
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
                }
                error?.let { Text(it, color = palette.warn, style = MaterialTheme.typography.bodySmall) }
            }
            if (saved) {
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

@Composable
private fun MessagePromptCard(store: SummonStore, roomID: String, message: SummonMessage, prompt: SummonJson) {
    val palette = LocalSummonPalette.current
    val scope = rememberCoroutineScope()
    val kind = prompt["kind"].string ?: "question"
    val questions = prompt["questions"].array.orEmpty()
    val isSkipped = remember(message.id, message.promptAnswer, store.messagesForRoom(roomID)) {
        message.promptAnswer?.get("skipped")?.bool == true ||
            store.messagesForRoom(roomID)
                .firstOrNull { it.promptResponse?.get("prompt_message_id")?.string == message.id }
                ?.promptResponse?.get("skipped")?.bool == true
    }
    val answeredItems = remember(message.id, message.promptAnswer, store.messagesForRoom(roomID), isSkipped) {
        if (isSkipped) emptyList()
        else message.promptAnswer?.get("answers")?.array?.takeIf { it.isNotEmpty() }
            ?: store.messagesForRoom(roomID)
                .firstOrNull { it.promptResponse?.get("prompt_message_id")?.string == message.id }
                ?.promptResponse?.get("answers")?.array?.takeIf { it.isNotEmpty() }
    }
    var selectedByQ by remember(message.id) { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    var customByQ by remember(message.id) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var submitting by remember(message.id) { mutableStateOf(false) }

    val isReady = questions.isNotEmpty() && questions.all { q ->
        if (q["required"].bool == false) true
        else {
            val qid = q["id"].stringValue
            val mode = q["mode"].string ?: "single"
            val hasSelected = !selectedByQ[qid].isNullOrEmpty()
            val hasCustom = !customByQ[qid].isNullOrBlank()
            if (mode == "text") hasCustom else (hasSelected || hasCustom)
        }
    }

    val doSubmit: () -> Unit = {
        if (!submitting && store.protocolReady && isReady) {
            submitting = true
            scope.launch {
                try {
                    val answers = mutableListOf<SummonJson>()
                    val lines = mutableListOf<String>()
                    for (q in questions) {
                        val qid = q["id"].stringValue
                        val label = q["label"].stringValue
                        val optMap = q["options"].array.orEmpty().associate { it["id"].stringValue to it["label"].stringValue }
                        val selIds = selectedByQ[qid].orEmpty().filter { it in optMap }
                        val selLabels = selIds.mapNotNull { optMap[it] }
                        val customText = customByQ[qid].orEmpty().trim()
                        if (selIds.isEmpty() && customText.isEmpty()) continue
                        answers += SummonJson.Obj(buildMap {
                            put("question_id", SummonJson.Str(qid))
                            put("label", SummonJson.Str(label))
                            put("selected_ids", selIds.toJsonStrings())
                            put("selected_labels", selLabels.toJsonStrings())
                            if (customText.isNotEmpty()) put("custom_text", SummonJson.Str(customText))
                        })
                        val parts = selLabels + listOfNotNull(customText.takeIf { it.isNotEmpty() }?.let { if (selLabels.isEmpty()) it else "补充：$it" })
                        lines += if (questions.size == 1) "已选择：${parts.joinToString("、")}" else "$label：${parts.joinToString("、")}"
                    }
                    if (answers.isNotEmpty()) {
                        store.sendPromptResponse(roomID, message, answers, lines.joinToString("\n"))
                    }
                } finally { submitting = false }
            }
        }
    }

    val borderColor = when {
        isSkipped -> palette.bubbleStroke
        answeredItems != null -> palette.ok.copy(alpha = 0.28f)
        kind == "permission" -> palette.warn.copy(alpha = 0.45f)
        else -> palette.bubbleStroke
    }
    val cardColor = when {
        isSkipped -> palette.quoteBg
        answeredItems != null -> palette.ok.copy(alpha = 0.07f)
        else -> palette.surface
    }

    Surface(
        shape = RoundedCornerShape(16.dp),
        color = cardColor,
        border = BorderStroke(0.9.dp, borderColor),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val badgeBg = when {
                    isSkipped -> palette.bubbleStroke
                    answeredItems != null -> palette.ok.copy(alpha = 0.14f)
                    kind == "permission" -> palette.warn.copy(alpha = 0.14f)
                    else -> palette.quoteBg
                }
                val badgeFg = when {
                    isSkipped -> palette.textSecondary
                    answeredItems != null -> palette.ok
                    kind == "permission" -> palette.warn
                    else -> palette.textSecondary
                }
                val badgeText = when {
                    isSkipped -> "已跳过"
                    answeredItems != null -> if (kind == "permission") "已确认权限" else if (kind == "confirm") "已确认" else "已提交选择"
                    kind == "permission" -> "权限确认"
                    kind == "confirm" -> "操作确认"
                    else -> "待你选择"
                }
                Surface(shape = CircleShape, color = badgeBg) {
                    Row(Modifier.padding(horizontal = 8.dp, vertical = 3.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (answeredItems != null && !isSkipped) Icon(Icons.Filled.Check, null, tint = badgeFg, modifier = Modifier.size(12.dp))
                        Text(badgeText, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold), color = badgeFg)
                    }
                }
                prompt["title"].string?.takeIf { it.isNotEmpty() }?.let { title ->
                    Text(title, style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold))
                }
            }

            if (answeredItems != null) {
                if (isSkipped) {
                    Text("已跳过本次选择，由 Bot 自行处理", style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        answeredItems.forEach { ans ->
                            val labels = ans["selected_labels"].array.orEmpty().mapNotNull { it.string }
                            val custom = ans["custom_text"].string.orEmpty()
                            val summary = (labels + listOfNotNull(custom.takeIf { it.isNotEmpty() })).joinToString(" · ")
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(ans["label"].string ?: ans["question_id"].stringValue, style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
                                Text(summary.ifEmpty { "—" }, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium))
                            }
                        }
                    }
                }
            } else {
                questions.forEachIndexed { idx, q ->
                    val qid = q["id"].stringValue
                    val mode = q["mode"].string ?: "single"
                    val allowCustom = q["allow_custom"].bool ?: (mode != "text" && kind != "permission")
                    val options = q["options"].array.orEmpty()
                    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                (if (questions.size > 1) "${idx + 1}. " else "") + q["label"].stringValue,
                                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                (if (mode == "multi") "多选" else if (mode == "text") "填写" else "单选") +
                                    (if (q["required"].bool == false) " · 选填" else ""),
                                style = MaterialTheme.typography.labelSmall,
                                color = palette.textTertiary,
                            )
                        }
                        if (mode != "text") {
                            options.forEach { opt ->
                                val oid = opt["id"].stringValue
                                val selected = oid in selectedByQ[qid].orEmpty()
                                val tone = opt["tone"].string ?: "default"
                                val accent = when (tone) {
                                    "primary" -> palette.ok
                                    "danger" -> Color(0xFFC44954)
                                    else -> MaterialTheme.colorScheme.onSurface
                                }
                                Surface(
                                    shape = RoundedCornerShape(10.dp),
                                    color = if (selected) accent.copy(alpha = 0.10f) else Color.Transparent,
                                    border = BorderStroke(if (selected) 1.2.dp else 0.7.dp, if (selected) accent.copy(alpha = 0.65f) else palette.bubbleStroke),
                                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable(enabled = !submitting) {
                                        val current = selectedByQ[qid].orEmpty()
                                        val next = if (mode == "multi") {
                                            if (oid in current) current - oid else current + oid
                                        } else {
                                            if (current == listOf(oid)) emptyList() else listOf(oid)
                                        }
                                        selectedByQ = selectedByQ + (qid to next)
                                        if (mode != "multi" && next.isNotEmpty()) customByQ = customByQ + (qid to "")
                                    },
                                ) {
                                    Row(Modifier.padding(horizontal = 10.dp, vertical = 9.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                                        Surface(
                                            shape = if (mode == "multi") RoundedCornerShape(4.dp) else CircleShape,
                                            color = if (selected) accent else Color.Transparent,
                                            border = BorderStroke(1.5.dp, if (selected) accent else palette.textTertiary),
                                            modifier = Modifier.padding(top = 2.dp).size(16.dp),
                                        ) {
                                            if (selected) Box(contentAlignment = Alignment.Center) {
                                                Icon(Icons.Filled.Check, null, tint = palette.surface, modifier = Modifier.size(11.dp))
                                            }
                                        }
                                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                                Text(
                                                    opt["label"].stringValue,
                                                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal),
                                                )
                                                if (opt["recommended"].bool == true) {
                                                    Surface(shape = CircleShape, color = palette.ok.copy(alpha = 0.14f)) {
                                                        Text("推荐", style = MaterialTheme.typography.labelSmall, color = palette.ok, modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp))
                                                    }
                                                }
                                            }
                                            opt["description"].string?.takeIf { it.isNotEmpty() }?.let { desc ->
                                                Text(desc, style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if (mode == "text" || allowCustom) {
                            val placeholder = q["custom_placeholder"].string
                                ?: if (mode == "text") "请输入回答…" else if (mode == "multi") "补充说明或自填其他选项（选填）" else "或自定义填写其他想法…"
                            OutlinedTextField(
                                value = customByQ[qid].orEmpty(),
                                onValueChange = { value ->
                                    customByQ = customByQ + (qid to value)
                                    if (mode == "single" && value.isNotBlank()) selectedByQ = selectedByQ + (qid to emptyList())
                                },
                                placeholder = { Text(placeholder, style = MaterialTheme.typography.bodySmall) },
                                enabled = !submitting,
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                                keyboardActions = KeyboardActions(onSend = { doSubmit() }),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                    TextButton(
                        enabled = !submitting && store.protocolReady,
                        onClick = {
                            submitting = true
                            scope.launch {
                                try {
                                    val text = if (kind == "permission") "已跳过权限确认" else "已跳过选择，由你自行处理"
                                    store.sendPromptResponse(roomID, message, emptyList(), text, skipped = true)
                                } finally { submitting = false }
                            }
                        },
                    ) { Text("跳过") }
                    Button(
                        enabled = !submitting && store.protocolReady && isReady,
                        onClick = doSubmit,
                    ) {
                        Text(if (submitting) "提交中…" else prompt["submit_label"].string ?: if (kind == "permission") "确认授权" else if (kind == "confirm") "确认" else "提交选择")
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ExecutionPendingPromptCard(store: SummonStore, exec: SummonJson, request: SummonJson, onError: (String) -> Unit) {
    val palette = LocalSummonPalette.current
    val scope = rememberCoroutineScope()
    val isApproval = request["kind"].string == "approval"
    val choices = request["choices"].array.orEmpty()
    var selectedChoice by remember(request["request_id"].string) { mutableStateOf("") }
    var freeText by remember(request["request_id"].string) { mutableStateOf("") }
    var busy by remember(request["request_id"].string) { mutableStateOf(false) }
    val currentVal = if (choices.isEmpty()) freeText.trim() else selectedChoice

    Surface(
        shape = RoundedCornerShape(16.dp),
        color = palette.surface,
        border = BorderStroke(0.9.dp, palette.warn.copy(alpha = 0.45f)),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Surface(shape = CircleShape, color = palette.warn.copy(alpha = 0.14f)) {
                    Text(
                        if (isApproval) "执行权限审批" else "执行会话提问",
                        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                        color = palette.warn,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
                val actorId = exec["execution_actor"]["id"].string ?: exec["bot_id"].string.orEmpty()
                val engine = exec["engine"].string
                Text(
                    store.name(actorId) + (if (!engine.isNullOrEmpty()) " · $engine" else ""),
                    style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            request["question"].string?.takeIf { it.isNotEmpty() }?.let { q ->
                Text(q, style = MaterialTheme.typography.bodySmall)
            }
            if (choices.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    choices.forEach { choice ->
                        val cid = choice["id"].stringValue
                        val label = choice["label"].string ?: cid
                        val selected = selectedChoice == cid
                        val accent = when {
                            cid == "accept" -> palette.ok
                            cid in listOf("deny", "decline", "cancel") -> Color(0xFFC44954)
                            else -> MaterialTheme.colorScheme.onSurface
                        }
                        Surface(
                            shape = CircleShape,
                            color = if (selected) accent.copy(alpha = 0.14f) else Color.Transparent,
                            border = BorderStroke(if (selected) 1.2.dp else 0.7.dp, if (selected) accent else palette.bubbleStroke),
                            modifier = Modifier.clip(CircleShape).clickable(enabled = !busy) { selectedChoice = cid },
                        ) {
                            Text(
                                label,
                                style = MaterialTheme.typography.bodySmall.copy(fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal),
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
                            )
                        }
                    }
                }
            } else {
                OutlinedTextField(
                    value = freeText,
                    onValueChange = { freeText = it },
                    placeholder = { Text("输入回答…", style = MaterialTheme.typography.bodySmall) },
                    enabled = !busy,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = {
                        if (!busy && store.protocolReady && currentVal.isNotEmpty()) {
                            busy = true
                            scope.launch {
                                try {
                                    store.submitPendingExecutionInput(
                                        target = exec["execution_ref"],
                                        controlVersion = exec["control_version"].int ?: 1,
                                        inputTarget = request["input_target"],
                                        input = currentVal,
                                    )
                                    selectedChoice = ""; freeText = ""
                                } catch (failure: Exception) {
                                    onError(failure.localizedMessage ?: "提交失败")
                                } finally { busy = false }
                            }
                        }
                    }),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            val skipChoiceId = choices.firstOrNull { it["id"].stringValue in listOf("cancel", "decline", "deny") }?.get("id")?.string
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                if (skipChoiceId != null) {
                    TextButton(
                        enabled = !busy && store.protocolReady,
                        onClick = {
                            busy = true
                            scope.launch {
                                try {
                                    store.submitPendingExecutionInput(
                                        target = exec["execution_ref"],
                                        controlVersion = exec["control_version"].int ?: 1,
                                        inputTarget = request["input_target"],
                                        input = skipChoiceId,
                                    )
                                    selectedChoice = ""; freeText = ""
                                } catch (failure: Exception) {
                                    onError(failure.localizedMessage ?: "提交失败")
                                } finally { busy = false }
                            }
                        },
                    ) { Text("跳过") }
                }
                Button(
                    enabled = !busy && store.protocolReady && currentVal.isNotEmpty(),
                    onClick = {
                        busy = true
                        scope.launch {
                            try {
                                store.submitPendingExecutionInput(
                                    target = exec["execution_ref"],
                                    controlVersion = exec["control_version"].int ?: 1,
                                    inputTarget = request["input_target"],
                                    input = currentVal,
                                )
                                selectedChoice = ""; freeText = ""
                            } catch (failure: Exception) {
                                onError(failure.localizedMessage ?: "提交失败")
                            } finally { busy = false }
                        }
                    },
                ) {
                    Text(if (busy) "提交中…" else if (isApproval) "确认审批" else "提交回答")
                }
            }
        }
    }
}
