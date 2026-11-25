package org.lin0.relay

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Contrast
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import kotlin.math.roundToInt

enum class ResourceSection(val title: String, val icon: ImageVector, val path: String) {
    Bots("成员", Icons.Filled.Groups, "/api/bots"),
    Executions("执行会话", Icons.Filled.Terminal, "/api/executions"),
    Files("资料", Icons.Filled.Folder, "/api/files"),
    Wakeups("订阅与提醒", Icons.Filled.Schedule, "/api/wakeups"),
    Connections("预置 Bot 与目录", Icons.Filled.Link, "/api/bundled-bots"),
}

private const val DEFAULT_FOLDER_ID = "__default__"

private data class HomeFolder(val id: String, val name: String, val keys: List<String>)

private data class HomeOrg(
    val pinnedKeys: List<String> = emptyList(),
    val hiddenKeys: List<String> = emptyList(),
    val folders: List<HomeFolder> = emptyList(),
    val collapsedIds: Set<String> = emptySet(),
) {
    fun isPinned(key: String) = key in pinnedKeys
    fun isHidden(key: String) = key in hiddenKeys
    fun togglePin(key: String): HomeOrg = copy(
        pinnedKeys = if (key in pinnedKeys) pinnedKeys - key else pinnedKeys + key,
        hiddenKeys = if (key in pinnedKeys) hiddenKeys else hiddenKeys - key,
    )
    fun setHidden(key: String, hidden: Boolean): HomeOrg = if (hidden) {
        copy(
            pinnedKeys = pinnedKeys - key,
            hiddenKeys = if (key in hiddenKeys) hiddenKeys else hiddenKeys + key,
        )
    } else {
        copy(hiddenKeys = hiddenKeys - key)
    }
    fun folderIdFor(key: String): String? = folders.firstOrNull { key in it.keys }?.id
    fun move(key: String, folderId: String?): HomeOrg = copy(
        folders = folders.map { folder ->
            val stripped = folder.keys.filterNot { it == key }
            if (folder.id == folderId) folder.copy(keys = stripped + key) else folder.copy(keys = stripped)
        },
    )
    fun toggleCollapsed(id: String): HomeOrg = copy(
        collapsedIds = if (id in collapsedIds) collapsedIds - id else collapsedIds + id,
    )
    fun createFolder(rawName: String): Pair<HomeOrg, HomeFolder?> {
        val name = rawName.trim()
        if (name.isEmpty()) return this to null
        val folder = HomeFolder(UUID.randomUUID().toString().lowercase(), name, emptyList())
        return copy(folders = folders + folder) to folder
    }
    fun renameFolder(id: String, rawName: String): HomeOrg {
        val name = rawName.trim()
        if (name.isEmpty()) return this
        return copy(folders = folders.map { if (it.id == id) it.copy(name = name) else it })
    }
    fun deleteFolder(id: String): HomeOrg = copy(
        folders = folders.filterNot { it.id == id },
        collapsedIds = collapsedIds - id,
    )

    fun save(context: Context, endpoint: String) {
        val prefs = context.getSharedPreferences("SummonNative.homeOrg", Context.MODE_PRIVATE)
        val obj = JSONObject()
        obj.put("pinnedKeys", JSONArray(pinnedKeys))
        obj.put("hiddenKeys", JSONArray(hiddenKeys))
        obj.put("collapsedIds", JSONArray(collapsedIds.filterNot { it == DEFAULT_FOLDER_ID }))
        val arr = JSONArray()
        folders.forEach { f ->
            arr.put(JSONObject().put("id", f.id).put("name", f.name).put("keys", JSONArray(f.keys)))
        }
        obj.put("folders", arr)
        prefs.edit().putString("v1:" + endpoint.ifEmpty { "default" }, obj.toString()).apply()
    }

    companion object {
        fun load(context: Context, endpoint: String): HomeOrg {
            val prefs = context.getSharedPreferences("SummonNative.homeOrg", Context.MODE_PRIVATE)
            val raw = prefs.getString("v1:" + endpoint.ifEmpty { "default" }, null) ?: return HomeOrg()
            return runCatching {
                val obj = JSONObject(raw)
                val pinned = obj.optJSONArray("pinnedKeys")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty()
                val hidden = obj.optJSONArray("hiddenKeys")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty()
                val collapsed = obj.optJSONArray("collapsedIds")?.let { a -> (0 until a.length()).map { a.getString(it) }.filterNot { it == DEFAULT_FOLDER_ID }.toSet() }.orEmpty()
                val folders = obj.optJSONArray("folders")?.let { a ->
                    (0 until a.length()).map { idx ->
                        val f = a.getJSONObject(idx)
                        val keys = f.optJSONArray("keys")?.let { k -> (0 until k.length()).map { k.getString(it) } }.orEmpty()
                        HomeFolder(f.getString("id"), f.getString("name"), keys)
                    }
                }.orEmpty()
                HomeOrg(pinned, hidden, folders, collapsed)
            }.getOrDefault(HomeOrg())
        }
    }
}

private const val BOT_MAINTENANCE_ROOM_ID = "room-default-bot-maintenance"

private data class HomeEntry(
    val key: String,
    val nodeId: String = "",
    val nodeName: String = "",
    val room: SummonRoom,
    val title: String,
    val preview: String,
    val fullPreview: String,
    val timestamp: String,
    val sortDate: String,
    val isSystem: Boolean,
    val isWorking: Boolean,
) {
    val roomId: String get() = room.id
}

private sealed interface HomeDetailsTarget {
    data class Room(val id: String) : HomeDetailsTarget
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun ConversationListScreen(
    store: SummonStore,
    updater: SummonAppUpdater,
    onOpenPanel: () -> Unit,
    onOpenUsage: () -> Unit,
    onOpenModels: () -> Unit,
    onOpenRoom: (String) -> Unit,
    onOpenNewGroup: () -> Unit,
    onOpenResource: (ResourceSection) -> Unit,
) {
    val context = LocalContext.current
    val palette = LocalSummonPalette.current
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var org by remember(store.settings.baseURL) { mutableStateOf(HomeOrg.load(context, store.settings.baseURL)) }
    fun updateOrg(next: HomeOrg) {
        org = next
        next.save(context, store.settings.baseURL)
    }

    var showSettings by remember { mutableStateOf(false) }
    var showDisplay by remember { mutableStateOf(false) }
    var showHidden by remember { mutableStateOf(false) }
    var showArchived by remember { mutableStateOf(false) }
    var detailsTarget by remember { mutableStateOf<HomeDetailsTarget?>(null) }
    var actionEntry by remember { mutableStateOf<HomeEntry?>(null) }
    var swipedRowKey by remember { mutableStateOf<String?>(null) }
    var newFolderTargetKey by remember { mutableStateOf<String?>(null) }
    var showNewFolderDialog by remember { mutableStateOf(false) }
    var newFolderName by remember { mutableStateOf("") }
    var folderActionTarget by remember { mutableStateOf<HomeFolder?>(null) }
    var renamingFolder by remember { mutableStateOf<HomeFolder?>(null) }
    var renameFolderText by remember { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var quotaItem by remember { mutableStateOf<SummonJson?>(null) }

    when (val target = detailsTarget) {
        is HomeDetailsTarget.Room -> {
            RoomDetailsScreen(store, target.id) { detailsTarget = null }
            return
        }
        null -> Unit
    }

    val allEntries = remember(store.rooms, store.bots, store.hubNodes, store.filterNodeID, store.remoteNodeRooms, store.remoteNodeBots, store.isConnected, store.settings.userName) {
        val groupRooms = store.rooms.filter { it.isGroup }
        val multiOnline = store.onlineNodes.size > 1
        fun exclusiveWorkingBot(room: SummonRoom): SummonBot? {
            if (!store.isConnected) return null
            val candidates = mutableListOf<SummonBot>()
            room.leadBotId?.let { leadId -> store.bots.firstOrNull { it.id == leadId }?.let { candidates.add(it) } }
            for (memberId in room.members) {
                if (memberId == "user" || memberId == room.leadBotId) continue
                val bot = store.bots.firstOrNull { it.id == memberId } ?: continue
                if (bot.roleId in listOf("eggbot", "tool-onboarding")) continue
                if (groupRooms.count { memberId in it.members } <= 1) candidates.add(bot)
            }
            return candidates.firstOrNull { it.resolvedActivity == "working" }
        }

        val sourceItems = if (store.hubNodes.isEmpty()) {
            groupRooms.map { Triple("", "", it) }
        } else {
            store.mixedGroupRooms
        }
        sourceItems
            .map { (nodeId, nodeName, room) ->
                val last = room.lastMessage
                val sameNode = nodeId.isEmpty() || nodeId == store.activeNodeID
                val activeBot = if (sameNode) exclusiveWorkingBot(room) else null
                val summary = when {
                    activeBot != null -> "${activeBot.name} · 正在处理…"
                    last != null -> "${store.anyBot(last.senderId)?.name ?: store.name(last.senderId)}：${messageSummary(last)}"
                    else -> "开始聊天"
                }
                val full = if (last != null) {
                    last.content.trim().ifEmpty { summary }
                } else "还没有消息，点按开始对话。"
                val entryKey = if (multiOnline && nodeId.isNotEmpty()) "room:$nodeId:${room.id}" else "room:${room.id}"
                HomeEntry(
                    key = entryKey,
                    nodeId = nodeId,
                    nodeName = if (multiOnline) nodeName else "",
                    room = room,
                    title = if (multiOnline && nodeName.isNotEmpty()) "${room.name} · $nodeName" else room.name,
                    preview = summary,
                    fullPreview = full,
                    timestamp = formatSummonTime(last?.createdAt),
                    sortDate = last?.createdAt ?: room.updatedAt ?: room.createdAt.orEmpty(),
                    isSystem = room.id == BOT_MAINTENANCE_ROOM_ID,
                    isWorking = activeBot != null,
                )
            }
            .sortedWith(compareByDescending<HomeEntry> { it.sortDate }.thenBy { it.title })
    }

    val hiddenSet = remember(org.hiddenKeys) { org.hiddenKeys.toSet() }
    val visibleEntries = remember(allEntries, hiddenSet) { allEntries.filterNot { it.key in hiddenSet } }
    val hiddenEntries = remember(allEntries, hiddenSet) { allEntries.filter { it.key in hiddenSet } }

    val trimmedQuery = query.trim()
    val filteredEntries = remember(visibleEntries, trimmedQuery) {
        if (trimmedQuery.isEmpty()) visibleEntries
        else visibleEntries.filter { it.title.contains(trimmedQuery, ignoreCase = true) || it.preview.contains(trimmedQuery, ignoreCase = true) }
    }
    val entryByKey = remember(visibleEntries) { visibleEntries.associateBy { it.key } }
    val pinnedEntries = if (trimmedQuery.isEmpty()) org.pinnedKeys.mapNotNull { entryByKey[it] } else emptyList()
    val pinnedSet = org.pinnedKeys.toSet()
    val unpinnedEntries = if (trimmedQuery.isEmpty()) filteredEntries.filterNot { it.key in pinnedSet } else filteredEntries
    val assignedKeys = org.folders.flatMap { it.keys }.toSet()
    val defaultEntries = unpinnedEntries.filter { it.key !in assignedKeys && !it.isSystem }
    val systemEntries = unpinnedEntries.filter { it.key !in assignedKeys && it.isSystem }

    fun openEntry(entry: HomeEntry) {
        swipedRowKey = null
        if (entry.nodeId.isNotEmpty() && entry.nodeId != store.activeNodeID) {
            scope.launch {
                store.switchNode(entry.nodeId)
                onOpenRoom(entry.room.id)
            }
        } else {
            onOpenRoom(entry.room.id)
        }
    }

    val model = store.modelSummary["chat"]
    val menuHeight = (LocalConfiguration.current.screenHeightDp * 100f / LocalSummonDisplay.current.zoom * .7f).dp
    val statusBarTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val topClearance = statusBarTop + 58.dp
    val bottomClearance = 96.dp

    Box(Modifier.fillMaxSize().background(palette.background).imePadding()) {
        PullToRefreshBox(
            isRefreshing = store.isRefreshing,
            onRefresh = { scope.launch { store.refresh() } },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
                    .drawWithContent {
                        drawContent()
                        val topFadePx = (topClearance + 18.dp).toPx().coerceAtMost(size.height * 0.30f)
                        if (topFadePx > 1f) {
                            drawRect(
                                brush = Brush.verticalGradient(
                                    0f to Color.Transparent,
                                    0.55f to Color.Black.copy(alpha = 0.32f),
                                    1f to Color.Black,
                                    startY = 0f,
                                    endY = topFadePx,
                                ),
                                size = androidx.compose.ui.geometry.Size(size.width, topFadePx),
                                blendMode = BlendMode.DstIn,
                            )
                        }
                        val bottomFadePx = (bottomClearance + 20.dp).toPx().coerceAtMost(size.height * 0.35f)
                        if (bottomFadePx > 1f) {
                            val startY = (size.height - bottomFadePx).coerceAtLeast(0f)
                            drawRect(
                                brush = Brush.verticalGradient(
                                    0f to Color.Black,
                                    0.38f to Color.Black.copy(alpha = 0.35f),
                                    0.74f to Color.Black.copy(alpha = 0.08f),
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
                contentPadding = PaddingValues(top = topClearance + 8.dp, bottom = bottomClearance + 14.dp),
            ) {
                if (store.hubNodes.size > 1 || store.offlineNodes.isNotEmpty()) {
                    item(key = "hub-nodes") {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState())
                                .padding(horizontal = 20.dp, vertical = 6.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            val allSelected = store.filterNodeID == null
                            Surface(
                                shape = CircleShape,
                                color = if (allSelected) palette.textPrimary else palette.surface,
                                modifier = Modifier.clickable { store.filterNodeID = null },
                            ) {
                                Text(
                                    "全部 ${store.onlineNodes.size}",
                                    color = if (allSelected) palette.background else palette.textPrimary,
                                    style = MaterialTheme.typography.labelMedium,
                                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                                )
                            }
                            for (node in store.onlineNodes) {
                                val selected = store.filterNodeID == node.id
                                Surface(
                                    shape = CircleShape,
                                    color = if (selected) palette.textPrimary else palette.surface,
                                    modifier = Modifier.clickable { store.filterNodeID = node.id },
                                ) {
                                    Text(
                                        "● ${node.name}",
                                        color = if (selected) palette.background else palette.textPrimary,
                                        style = MaterialTheme.typography.labelMedium,
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                                    )
                                }
                            }
                            for (node in store.offlineNodes) {
                                Surface(
                                    shape = CircleShape,
                                    color = palette.surface.copy(alpha = 0.55f),
                                ) {
                                    Text(
                                        "${node.name} · 离线",
                                        color = palette.textSecondary,
                                        style = MaterialTheme.typography.labelMedium,
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                                    )
                                }
                            }
                        }
                    }
                }
                item(key = "status") {
                    if (store.isLoading && store.bots.isEmpty()) {
                        Row(Modifier.fillMaxWidth().padding(top = 24.dp), horizontalArrangement = Arrangement.Center) {
                            CircularProgressIndicator(); Spacer(Modifier.width(8.dp)); Text("正在打开工作空间…")
                        }
                    }
                    store.protocolNotice?.let { notice ->
                        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
                            Text(notice, color = palette.warn)
                            Row {
                                TextButton(onClick = { scope.launch { store.refresh() } }) { Text("重新连接") }
                                if (store.needsClientUpdate) TextButton(onClick = { showSettings = true }) { Text("客户端更新") }
                            }
                        }
                    }
                    store.errorMessage?.let { error ->
                        Row(Modifier.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(error, color = palette.warn, modifier = Modifier.weight(1f))
                            TextButton(onClick = { scope.launch { store.refresh() } }) { Text("重连") }
                        }
                    } ?: run {
                        if (!store.isConnected && store.bots.isNotEmpty()) {
                            Row(Modifier.padding(20.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Filled.WifiOff, null, tint = palette.textSecondary)
                                Spacer(Modifier.width(8.dp))
                                Text("已显示本机记录，正在连接…", color = palette.textSecondary, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }

                if (pinnedEntries.isNotEmpty()) {
                    item(key = "pinned-shelf") {
                        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                            pinnedEntries.chunked(3).forEach { rowItems ->
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                                    rowItems.forEach { entry ->
                                        Column(
                                            Modifier.weight(1f).clip(RoundedCornerShape(16.dp))
                                                .combinedClickable(
                                                    onClick = { openEntry(entry) },
                                                    onLongClick = { swipedRowKey = null; actionEntry = entry },
                                                )
                                                .padding(vertical = 4.dp),
                                            horizontalAlignment = Alignment.CenterHorizontally,
                                            verticalArrangement = Arrangement.spacedBy(9.dp),
                                        ) {
                                            HomeEntryAvatar(entry, store.bots, 74.dp)
                                            Text(
                                                entry.title,
                                                style = MaterialTheme.typography.labelMedium,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                                textAlign = TextAlign.Center,
                                            )
                                        }
                                    }
                                    repeat(3 - rowItems.size) { Spacer(Modifier.weight(1f)) }
                                }
                            }
                        }
                    }
                }

                if (trimmedQuery.isNotEmpty()) {
                    items(filteredEntries, key = { it.key }) { entry ->
                        HomeConversationRow(
                            entry = entry,
                            bots = store.bots,
                            isPinned = org.isPinned(entry.key),
                            isSwipedOpen = swipedRowKey == entry.key,
                            onSwipeOpenChanged = { open -> swipedRowKey = if (open) entry.key else if (swipedRowKey == entry.key) null else swipedRowKey },
                            onClick = { openEntry(entry) },
                            onLongClick = { swipedRowKey = null; actionEntry = entry },
                            onTogglePin = { swipedRowKey = null; updateOrg(org.togglePin(entry.key)) },
                            onHide = { swipedRowKey = null; updateOrg(org.setHidden(entry.key, true)) },
                        )
                    }
                } else {
                    if (defaultEntries.isNotEmpty() || store.archivedRooms.isNotEmpty()) {
                        val defaultCollapsed = DEFAULT_FOLDER_ID in org.collapsedIds
                        item(key = "folder-header-default") {
                            FolderSectionHeader(
                                title = "群聊",
                                collapsed = defaultCollapsed,
                                onToggle = { updateOrg(org.toggleCollapsed(DEFAULT_FOLDER_ID)) },
                            )
                        }
                        if (!defaultCollapsed) {
                            items(defaultEntries, key = { it.key }) { entry ->
                                HomeConversationRow(
                                    entry = entry,
                                    bots = store.bots,
                                    isPinned = org.isPinned(entry.key),
                                    isSwipedOpen = swipedRowKey == entry.key,
                                    onSwipeOpenChanged = { open -> swipedRowKey = if (open) entry.key else if (swipedRowKey == entry.key) null else swipedRowKey },
                                    onClick = { openEntry(entry) },
                                    onLongClick = { swipedRowKey = null; actionEntry = entry },
                                    onTogglePin = { swipedRowKey = null; updateOrg(org.togglePin(entry.key)) },
                                    onHide = { swipedRowKey = null; updateOrg(org.setHidden(entry.key, true)) },
                                )
                            }
                            if (store.archivedRooms.isNotEmpty()) {
                                item(key = "archive-assistant-row") {
                                    Row(
                                        Modifier
                                            .fillMaxWidth()
                                            .clickable { showArchived = true }
                                            .padding(horizontal = 20.dp, vertical = 10.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                                    ) {
                                        Box(
                                            Modifier.size(44.dp).clip(CircleShape).background(palette.surface),
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Icon(Icons.Filled.Archive, null, tint = palette.textSecondary, modifier = Modifier.size(20.dp))
                                        }
                                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                                Text("归档群助手", style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium))
                                                Text("${store.archivedRooms.size}", style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                                            }
                                            Text(
                                                store.archivedRooms.take(3).joinToString("、") { it.name },
                                                style = MaterialTheme.typography.bodySmall,
                                                color = palette.textSecondary,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                    org.folders.forEach { folder ->
                        val folderKeySet = folder.keys.toSet()
                        val folderEntries = unpinnedEntries.filter { it.key in folderKeySet }
                        val collapsed = folder.id in org.collapsedIds
                        item(key = "folder-header-${folder.id}") {
                            FolderSectionHeader(
                                title = folder.name,
                                collapsed = collapsed,
                                onToggle = { updateOrg(org.toggleCollapsed(folder.id)) },
                                onLongClick = { folderActionTarget = folder },
                            )
                        }
                        if (!collapsed) {
                            if (folderEntries.isEmpty()) {
                                item(key = "folder-empty-${folder.id}") {
                                    Text(
                                        "长按任意群聊可移动到此分组",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = palette.textTertiary,
                                        modifier = Modifier.padding(horizontal = 22.dp, vertical = 10.dp),
                                    )
                                }
                            } else {
                                items(folderEntries, key = { "${folder.id}:${it.key}" }) { entry ->
                                    HomeConversationRow(
                                        entry = entry,
                                        bots = store.bots,
                                        isPinned = org.isPinned(entry.key),
                                        isSwipedOpen = swipedRowKey == entry.key,
                                        onSwipeOpenChanged = { open -> swipedRowKey = if (open) entry.key else if (swipedRowKey == entry.key) null else swipedRowKey },
                                        onClick = { openEntry(entry) },
                                        onLongClick = { swipedRowKey = null; actionEntry = entry },
                                        onTogglePin = { swipedRowKey = null; updateOrg(org.togglePin(entry.key)) },
                                        onHide = { swipedRowKey = null; updateOrg(org.setHidden(entry.key, true)) },
                                    )
                                }
                            }
                        }
                    }
                    if (systemEntries.isNotEmpty()) {
                        val systemCollapsed = "__system__" in org.collapsedIds
                        item(key = "folder-header-system") {
                            FolderSectionHeader(
                                title = "系统",
                                collapsed = systemCollapsed,
                                onToggle = { updateOrg(org.toggleCollapsed("__system__")) },
                            )
                        }
                        if (!systemCollapsed) {
                            items(systemEntries, key = { "sys:${it.key}" }) { entry ->
                                HomeConversationRow(
                                    entry = entry,
                                    bots = store.bots,
                                    isPinned = org.isPinned(entry.key),
                                    isSwipedOpen = swipedRowKey == entry.key,
                                    onSwipeOpenChanged = { open -> swipedRowKey = if (open) entry.key else if (swipedRowKey == entry.key) null else swipedRowKey },
                                    onClick = { openEntry(entry) },
                                    onLongClick = { swipedRowKey = null; actionEntry = entry },
                                    onTogglePin = { swipedRowKey = null; updateOrg(org.togglePin(entry.key)) },
                                    onHide = { swipedRowKey = null; updateOrg(org.setHidden(entry.key, true)) },
                                )
                            }
                        }
                    }
                }

                if (allEntries.isEmpty() && store.archivedRooms.isEmpty() && !store.isLoading && store.protocolReady) {
                    item(key = "empty-workspace") {
                        Column(Modifier.fillMaxWidth().padding(top = 80.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("你的工作空间", style = MaterialTheme.typography.titleLarge)
                            Text(if (store.errorMessage == null) "点右上角 +，说出你想建的群，立即组建专属团队。" else "暂时无法获取记录，请检查服务连接。", color = palette.textSecondary, modifier = Modifier.padding(16.dp))
                            Button(onClick = onOpenNewGroup) { Text("新建群聊") }
                            TextButton(onClick = { showSettings = true }) { Text("连接设置") }
                        }
                    }
                } else if (filteredEntries.isEmpty() && trimmedQuery.isNotEmpty()) {
                    item(key = "empty-search") {
                        Text("没有与“$trimmedQuery”匹配的结果", modifier = Modifier.padding(24.dp), color = palette.textSecondary)
                    }
                }
            }
        }

        // Floating top bar (avatar on left, + on right, soft fade veil)
        Box(
            Modifier.fillMaxWidth().height(topClearance + 14.dp).align(Alignment.TopCenter)
                .background(Brush.verticalGradient(0f to palette.background.copy(alpha = 0.94f), 0.6f to palette.background.copy(alpha = 0.6f), 1f to Color.Transparent)),
        )
        Row(
            Modifier.fillMaxWidth().align(Alignment.TopCenter).statusBarsPadding().padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Box {
                Surface(
                    shape = CircleShape,
                    color = palette.glassPill,
                    border = BorderStroke(0.8.dp, palette.bubbleStroke),
                    shadowElevation = 2.dp,
                    modifier = Modifier.size(40.dp).clip(CircleShape).clickable { menu = true }.semantics {
                        contentDescription = "${store.settings.userName}，菜单，${if (store.isConnected) "已连接" else "正在连接"}"
                    },
                ) {
                    Box(Modifier.fillMaxSize()) {
                        Image(
                            painterResource(R.drawable.owner_avatar),
                            null,
                            Modifier.align(Alignment.Center).size(34.dp).clip(CircleShape),
                            contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                        )
                        Box(
                            Modifier.align(Alignment.BottomEnd).padding(2.dp).size(9.dp).clip(CircleShape)
                                .background(if (store.isConnected) palette.ok else palette.textTertiary)
                                .border(1.6.dp, palette.background, CircleShape),
                        )
                    }
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, modifier = Modifier.width(216.dp).heightIn(max = menuHeight)) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        ModelQuotaSignal(model, "默认模型", Modifier.weight(1f)) { menu = false; quotaItem = model }
                    }
                    HorizontalDivider(Modifier.padding(vertical = 4.dp), color = palette.hairline)
                    DropdownMenuItem(text = { Text("面板") }, leadingIcon = { Icon(Icons.Filled.BarChart, null) }, onClick = { menu = false; onOpenPanel() })
                    DropdownMenuItem(text = { Text("设置") }, leadingIcon = { Icon(Icons.Filled.Settings, null) }, onClick = { menu = false; showSettings = true })
                    if (hiddenEntries.isNotEmpty()) {
                        HorizontalDivider(Modifier.padding(vertical = 4.dp), color = palette.hairline)
                        DropdownMenuItem(
                            text = { Text("已隐藏群聊（${hiddenEntries.size}）") },
                            leadingIcon = { Icon(Icons.Filled.VisibilityOff, null) },
                            onClick = { menu = false; showHidden = true },
                        )
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Surface(
                    shape = CircleShape,
                    color = palette.glassPill,
                    border = BorderStroke(0.8.dp, palette.bubbleStroke),
                    shadowElevation = 2.dp,
                    modifier = Modifier.size(40.dp).clip(CircleShape).clickable(enabled = store.protocolReady) { onOpenNewGroup() },
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.Add, "新建群聊", tint = MaterialTheme.colorScheme.onBackground, modifier = Modifier.size(22.dp))
                    }
                }
            }
        }

        // Floating bottom bar: equal-height 48.dp circular Settings button + 48.dp Search capsule
        Box(
            Modifier.fillMaxWidth().align(Alignment.BottomCenter)
                .background(Brush.verticalGradient(0f to Color.Transparent, 0.32f to palette.background.copy(alpha = 0.74f), 0.65f to palette.background.copy(alpha = 0.94f), 1f to palette.background))
                .navigationBarsPadding()
                .padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 10.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Surface(
                    shape = CircleShape,
                    color = palette.glassPill,
                    border = BorderStroke(0.8.dp, palette.bubbleStroke),
                    shadowElevation = 2.dp,
                    modifier = Modifier.size(48.dp).clip(CircleShape).clickable { showSettings = true },
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.Settings, "设置", tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(20.dp))
                    }
                }
                Surface(
                    shape = CircleShape,
                    color = palette.glassPill,
                    border = BorderStroke(0.8.dp, palette.bubbleStroke),
                    shadowElevation = 2.dp,
                    modifier = Modifier.weight(1f).height(48.dp),
                ) {
                    Row(
                        Modifier.fillMaxSize().padding(start = 16.dp, end = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Icon(Icons.Filled.Search, null, tint = palette.textSecondary, modifier = Modifier.size(19.dp))
                        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                            if (query.isEmpty()) {
                                Text("搜索群聊", color = palette.textTertiary, style = MaterialTheme.typography.bodyLarge)
                            }
                            BasicTextField(
                                value = query,
                                onValueChange = { query = it },
                                singleLine = true,
                                textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        if (query.isNotEmpty()) {
                            IconButton(onClick = { query = "" }, modifier = Modifier.size(30.dp)) {
                                Icon(Icons.Filled.Close, "清除搜索", tint = palette.textTertiary, modifier = Modifier.size(16.dp))
                            }
                        }
                    }
                }
            }
        }
    }

    if (showArchived) {
        AlertDialog(
            onDismissRequest = { showArchived = false },
            title = { Text("归档群助手") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    store.archivedRooms.forEach { archivedRoom ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .clickable {
                                    showArchived = false
                                    onOpenRoom(archivedRoom.id)
                                }
                                .padding(horizontal = 6.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            RoomAvatar(archivedRoom, store.bots, 36.dp, showOutline = false)
                            Column(Modifier.weight(1f)) {
                                Text(archivedRoom.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("${archivedRoom.members.size} 位成员", style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                            }
                            TextButton(onClick = {
                                scope.launch { runCatching { store.restoreRoom(archivedRoom) } }
                            }) { Text("恢复") }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showArchived = false }) { Text("关闭") } },
        )
    }

    actionEntry?.let { entry ->
        ConversationPreviewActionDialog(
            entry = entry,
            bots = store.bots,
            org = org,
            onDismiss = { actionEntry = null },
            onTogglePin = {
                updateOrg(org.togglePin(entry.key))
                actionEntry = null
            },
            onMoveToFolder = { folderId ->
                updateOrg(org.move(entry.key, folderId))
                actionEntry = null
            },
            onCreateFolderForEntry = {
                newFolderTargetKey = entry.key
                newFolderName = ""
                actionEntry = null
                showNewFolderDialog = true
            },
            onOpenDetails = {
                actionEntry = null
                detailsTarget = HomeDetailsTarget.Room(entry.roomId)
            },
            onHide = {
                updateOrg(org.setHidden(entry.key, true))
                actionEntry = null
            },
        )
    }

    folderActionTarget?.let { folder ->
        AlertDialog(
            onDismissRequest = { folderActionTarget = null },
            title = { Text(folder.name) },
            text = { Text("管理该分组，删除后其中的对话将回到“主要”。") },
            confirmButton = {
                TextButton(onClick = {
                    renameFolderText = folder.name
                    renamingFolder = folder
                    folderActionTarget = null
                }) { Text("重命名") }
            },
            dismissButton = {
                Row {
                    TextButton(onClick = {
                        updateOrg(org.deleteFolder(folder.id))
                        folderActionTarget = null
                    }) { Text("删除分组", color = Color(0xFFE53935)) }
                    TextButton(onClick = { folderActionTarget = null }) { Text("取消") }
                }
            },
        )
    }

    renamingFolder?.let { folder ->
        AlertDialog(
            onDismissRequest = { renamingFolder = null },
            title = { Text("重命名分组") },
            text = { OutlinedTextField(renameFolderText, { renameFolderText = it }, singleLine = true) },
            confirmButton = {
                TextButton(enabled = renameFolderText.isNotBlank(), onClick = {
                    updateOrg(org.renameFolder(folder.id, renameFolderText))
                    renamingFolder = null
                }) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { renamingFolder = null }) { Text("取消") } },
        )
    }

    if (showNewFolderDialog) {
        AlertDialog(
            onDismissRequest = { showNewFolderDialog = false; newFolderTargetKey = null },
            title = { Text("新建分组") },
            text = {
                OutlinedTextField(newFolderName, { newFolderName = it }, placeholder = { Text("分组名称（如 Tech、工作）") }, singleLine = true)
            },
            confirmButton = {
                TextButton(
                    enabled = newFolderName.isNotBlank(),
                    onClick = {
                        val (nextOrg, created) = org.createFolder(newFolderName)
                        val finalOrg = if (created != null && newFolderTargetKey != null) nextOrg.move(newFolderTargetKey!!, created.id) else nextOrg
                        updateOrg(finalOrg)
                        showNewFolderDialog = false
                        newFolderTargetKey = null
                        newFolderName = ""
                    },
                ) { Text("创建") }
            },
            dismissButton = {
                TextButton(onClick = { showNewFolderDialog = false; newFolderTargetKey = null }) { Text("取消") }
            },
        )
    }

    if (showHidden) {
        HiddenConversationsSheet(
            entries = hiddenEntries,
            bots = store.bots,
            onRestore = { key -> updateOrg(org.setHidden(key, false)) },
            onDismiss = { showHidden = false },
        )
    }

    quotaItem?.let { item ->
        ModalBottomSheet(onDismissRequest = { quotaItem = null }, containerColor = palette.surfaceElevated) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                ModelUsageDetails(item)
                TextButton(onClick = { quotaItem = null; onOpenModels() }, modifier = Modifier.fillMaxWidth()) { Text("管理模型") }
            }
        }
    }
    if (showDisplay) DisplaySettingsSheet { showDisplay = false }
    if (showSettings) SettingsSheet(
        store = store,
        updater = updater,
        onOpenModels = { showSettings = false; onOpenModels() },
        onOpenWakeups = { showSettings = false; onOpenResource(ResourceSection.Wakeups) },
        onOpenConnections = { showSettings = false; onOpenResource(ResourceSection.Connections) },
        onDismiss = { showSettings = false },
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FolderSectionHeader(
    title: String,
    collapsed: Boolean,
    onToggle: () -> Unit,
    onLongClick: (() -> Unit)? = null,
) {
    val palette = LocalSummonPalette.current
    Row(
        Modifier.fillMaxWidth()
            .combinedClickable(onClick = onToggle, onLongClick = onLongClick)
            .padding(start = 22.dp, end = 22.dp, top = 20.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = palette.textSecondary)
        Icon(
            Icons.Filled.ExpandMore,
            null,
            tint = palette.textTertiary,
            modifier = Modifier.size(16.dp).rotate(if (collapsed) -90f else 0f),
        )
    }
}

@Composable
private fun HomeEntryAvatar(entry: HomeEntry, bots: List<SummonBot>, size: Dp) {
    RoomAvatar(entry.room, bots, size)
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HomeConversationRow(
    entry: HomeEntry,
    bots: List<SummonBot>,
    isPinned: Boolean,
    isSwipedOpen: Boolean,
    onSwipeOpenChanged: (Boolean) -> Unit,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    onTogglePin: () -> Unit,
    onHide: () -> Unit,
) {
    val palette = LocalSummonPalette.current
    val isDark = LocalSummonIsDark.current
    val density = LocalDensity.current
    val revealWidthPx = with(density) { 124.dp.toPx() }
    var dragOffset by remember(entry.key) { mutableFloatStateOf(0f) }
    var isDragging by remember(entry.key) { mutableStateOf(false) }

    LaunchedEffect(isSwipedOpen) {
        if (!isDragging) {
            dragOffset = if (isSwipedOpen) -revealWidthPx else 0f
        }
    }

    val animatedOffset by animateFloatAsState(
        targetValue = dragOffset,
        animationSpec = spring(dampingRatio = 0.85f, stiffness = 420f),
        label = "rowSwipeOffset",
    )
    val currentOffset = if (isDragging) dragOffset else animatedOffset

    Box(Modifier.fillMaxWidth()) {
        if (currentOffset < -1f) {
            Row(
                Modifier.align(Alignment.CenterEnd).padding(end = 20.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Surface(
                    shape = CircleShape,
                    color = if (isDark) Color(0xFF565A63) else Color(0xFFA6AAB3),
                    modifier = Modifier.size(46.dp).clip(CircleShape).clickable(onClick = onTogglePin),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            Icons.Filled.PushPin,
                            if (isPinned) "取消置顶" else "置顶",
                            tint = Color.White,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
                Surface(
                    shape = CircleShape,
                    color = Color(0xFFE53935),
                    modifier = Modifier.size(46.dp).clip(CircleShape).clickable(onClick = onHide),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            Icons.Filled.VisibilityOff,
                            "隐藏",
                            tint = Color.White,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .offset { IntOffset(currentOffset.roundToInt(), 0) }
                .background(palette.background)
                .pointerInput(entry.key, revealWidthPx) {
                    detectHorizontalDragGestures(
                        onDragStart = { isDragging = true },
                        onHorizontalDrag = { _, dragAmount ->
                            dragOffset = (dragOffset + dragAmount).coerceIn(-revealWidthPx, 0f)
                        },
                        onDragEnd = {
                            isDragging = false
                            val shouldOpen = dragOffset < -revealWidthPx * 0.42f
                            dragOffset = if (shouldOpen) -revealWidthPx else 0f
                            onSwipeOpenChanged(shouldOpen)
                        },
                        onDragCancel = {
                            isDragging = false
                            val shouldOpen = dragOffset < -revealWidthPx * 0.42f
                            dragOffset = if (shouldOpen) -revealWidthPx else 0f
                            onSwipeOpenChanged(shouldOpen)
                        },
                    )
                }
                .combinedClickable(
                    onClick = {
                        if (isSwipedOpen || dragOffset < -8f) {
                            dragOffset = 0f
                            onSwipeOpenChanged(false)
                        } else {
                            onClick()
                        }
                    },
                    onLongClick = {
                        dragOffset = 0f
                        onSwipeOpenChanged(false)
                        onLongClick()
                    },
                )
                .padding(horizontal = 20.dp, vertical = 15.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box {
                HomeEntryAvatar(entry, bots, 52.dp)
                if (entry.isWorking) {
                    Box(
                        Modifier.align(Alignment.BottomEnd)
                            .size(11.dp)
                            .clip(CircleShape)
                            .background(palette.warn)
                            .border(2.dp, palette.background, CircleShape),
                    )
                }
            }
            Spacer(Modifier.width(15.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        entry.title,
                        style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
                        modifier = Modifier.weight(1f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (entry.timestamp.isNotEmpty()) {
                        Spacer(Modifier.width(8.dp))
                        Text(entry.timestamp, color = palette.textTertiary, style = MaterialTheme.typography.labelSmall)
                    }
                }
                Text(
                    entry.preview,
                    color = if (entry.isWorking) palette.warn else palette.textSecondary,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun ConversationPreviewActionDialog(
    entry: HomeEntry,
    bots: List<SummonBot>,
    org: HomeOrg,
    onDismiss: () -> Unit,
    onTogglePin: () -> Unit,
    onMoveToFolder: (String?) -> Unit,
    onCreateFolderForEntry: () -> Unit,
    onOpenDetails: () -> Unit,
    onHide: () -> Unit,
) {
    val palette = LocalSummonPalette.current
    val pinned = org.isPinned(entry.key)
    val currentFolderId = org.folderIdFor(entry.key)
    var moveExpanded by remember { mutableStateOf(false) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onDismiss,
                )
                .padding(horizontal = 22.dp, vertical = 28.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                Modifier
                    .widthIn(max = 340.dp)
                    .fillMaxWidth()
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = {},
                    ),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                // Preview Card
                Surface(
                    shape = RoundedCornerShape(24.dp),
                    color = palette.surfaceElevated,
                    border = BorderStroke(0.7.dp, palette.bubbleStroke),
                    shadowElevation = 10.dp,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(Modifier.fillMaxWidth()) {
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            HomeEntryAvatar(entry, bots, 28.dp)
                            Text(
                                entry.title,
                                style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            if (entry.timestamp.isNotEmpty()) {
                                Text(entry.timestamp, style = MaterialTheme.typography.labelSmall, color = palette.textTertiary)
                            }
                        }
                        HorizontalDivider(thickness = 0.6.dp, color = palette.hairline)
                        Box(Modifier.fillMaxWidth().padding(14.dp)) {
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(16.dp))
                                    .background(palette.botBubble)
                                    .padding(horizontal = 14.dp, vertical = 12.dp),
                            ) {
                                Text(
                                    entry.fullPreview,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    maxLines = 8,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }

                // Floating Context Menu Card
                Surface(
                    shape = RoundedCornerShape(22.dp),
                    color = palette.surfaceElevated,
                    border = BorderStroke(0.7.dp, palette.bubbleStroke),
                    shadowElevation = 10.dp,
                    modifier = Modifier.width(264.dp),
                ) {
                    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(vertical = 6.dp)) {
                        PreviewMenuItem(
                            icon = Icons.Filled.PushPin,
                            label = if (pinned) "取消置顶" else "置顶",
                            onClick = onTogglePin,
                        )
                        Row(
                            Modifier.fillMaxWidth().clickable { moveExpanded = !moveExpanded }.padding(horizontal = 18.dp, vertical = 13.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Icon(Icons.Filled.Folder, null, tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(19.dp))
                            Text("移动到", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                            Icon(
                                Icons.Filled.ExpandMore,
                                null,
                                tint = palette.textSecondary,
                                modifier = Modifier.size(18.dp).rotate(if (moveExpanded) 0f else -90f),
                            )
                        }
                        AnimatedVisibility(visible = moveExpanded) {
                            Column(Modifier.fillMaxWidth().background(palette.surface.copy(alpha = 0.55f))) {
                                FolderOptionRow(if (entry.isSystem) "系统" else "群聊", selected = currentFolderId == null) { onMoveToFolder(null) }
                                org.folders.forEach { folder ->
                                    FolderOptionRow(folder.name, selected = currentFolderId == folder.id) { onMoveToFolder(folder.id) }
                                }
                                HorizontalDivider(color = palette.hairline, modifier = Modifier.padding(horizontal = 16.dp))
                                Row(
                                    Modifier.fillMaxWidth().clickable(onClick = onCreateFolderForEntry).padding(start = 34.dp, end = 18.dp, top = 11.dp, bottom = 11.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Icon(Icons.Filled.CreateNewFolder, null, tint = palette.ok, modifier = Modifier.size(17.dp))
                                    Text("新建分组", style = MaterialTheme.typography.bodyMedium, color = palette.ok)
                                }
                            }
                        }
                        PreviewMenuItem(
                            icon = Icons.Filled.Info,
                            label = "群聊详情",
                            onClick = onOpenDetails,
                        )
                        HorizontalDivider(color = palette.hairline, modifier = Modifier.padding(vertical = 4.dp))
                        PreviewMenuItem(
                            icon = Icons.Filled.VisibilityOff,
                            label = "隐藏",
                            tint = Color(0xFFE53935),
                            onClick = onHide,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PreviewMenuItem(
    icon: ImageVector,
    label: String,
    tint: Color = MaterialTheme.colorScheme.onSurface,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 18.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(19.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, color = tint, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun FolderOptionRow(name: String, selected: Boolean, onClick: () -> Unit) {
    val palette = LocalSummonPalette.current
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 34.dp, end = 18.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(Icons.Filled.Folder, null, tint = palette.textSecondary, modifier = Modifier.size(16.dp))
        Text(name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (selected) Icon(Icons.Filled.Check, null, tint = palette.ok, modifier = Modifier.size(16.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HiddenConversationsSheet(
    entries: List<HomeEntry>,
    bots: List<SummonBot>,
    onRestore: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val palette = LocalSummonPalette.current
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = palette.surfaceElevated,
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("已隐藏群聊", style = MaterialTheme.typography.titleLarge)
            if (entries.isEmpty()) {
                Text("没有已隐藏的群聊", color = palette.textSecondary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 12.dp))
            } else {
                entries.forEach { entry ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        HomeEntryAvatar(entry, bots, 40.dp)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(entry.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(entry.preview, style = MaterialTheme.typography.labelSmall, color = palette.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        OutlinedButton(onClick = { onRestore(entry.key) }) { Text("取消隐藏") }
                    }
                }
            }
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) { Text("完成") }
            Spacer(Modifier.height(16.dp))
        }
    }
}

private fun messageSummary(message: SummonMessage): String {
    val cleaned = message.content.replace('\n', ' ').trim()
    if (cleaned.isNotEmpty()) return cleaned
    if (message.attachments.isNotEmpty()) return "[附件] " + message.attachments.joinToString("、") { it.name }
    return "共享了引用"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsSheet(
    store: SummonStore,
    updater: SummonAppUpdater,
    onOpenModels: () -> Unit,
    onOpenWakeups: () -> Unit,
    onOpenConnections: () -> Unit,
    onDismiss: () -> Unit,
) {
    val palette = LocalSummonPalette.current
    val scope = rememberCoroutineScope()
    val display = LocalSummonDisplay.current
    var baseURL by remember { mutableStateOf(store.settings.baseURL) }
    var token by remember { mutableStateOf(store.savedToken) }
    var userName by remember { mutableStateOf(store.settings.userName) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = palette.surfaceElevated) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(painterResource(R.drawable.summon_icon), null, Modifier.size(52.dp).clip(RoundedCornerShape(14.dp)))
                Spacer(Modifier.width(16.dp))
                Column {
                    Text("Summon Bot", style = MaterialTheme.typography.titleMedium)
                    Text("Android 原生客户端", color = palette.textSecondary)
                }
            }
            Spacer(Modifier.height(16.dp))
            Text("通用", style = MaterialTheme.typography.titleSmall, color = palette.textSecondary)
            OutlinedTextField(userName, { userName = it }, label = { Text("显示名称") }, modifier = Modifier.fillMaxWidth())
            TextButton(enabled = userName != store.settings.userName, onClick = {
                store.setUserName(userName); userName = store.settings.userName
            }) { Text("保存显示名称") }
            Spacer(Modifier.height(10.dp))
            Text("显示与外观", style = MaterialTheme.typography.titleSmall, color = palette.textSecondary)
            DisplaySettingsControls()
            TextButton(onClick = { display.reset() }) { Text("恢复默认显示") }
            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = palette.hairline)
            Text("模型、订阅与连接", style = MaterialTheme.typography.titleSmall, color = palette.textSecondary)
            Spacer(Modifier.height(6.dp))
            Surface(shape = RoundedCornerShape(14.dp), color = palette.surface, border = BorderStroke(0.6.dp, palette.hairline)) {
                Column {
                    PreviewMenuItem(Icons.Filled.Memory, "模型连接") { if (store.protocolReady) onOpenModels() }
                    HorizontalDivider(color = palette.hairline)
                    PreviewMenuItem(Icons.Filled.Schedule, "订阅与提醒") { if (store.protocolReady) onOpenWakeups() }
                    HorizontalDivider(color = palette.hairline)
                    PreviewMenuItem(Icons.Filled.Link, "执行连接与目录") { if (store.protocolReady) onOpenConnections() }
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = palette.hairline)
            Text("账号与已绑定电脑（${store.onlineNodes.size} 台在线）", style = MaterialTheme.typography.titleSmall, color = palette.textSecondary)
            Spacer(Modifier.height(6.dp))
            Text("账号：${store.settings.hubUsername ?: store.settings.userName}", style = MaterialTheme.typography.bodyMedium)
            Text("中枢：${store.settings.baseURL.ifEmpty { SummonApiClient.DEFAULT_HUB_URL }}", color = palette.textSecondary, style = MaterialTheme.typography.bodySmall)
            Text("实时连接：${if (store.isConnected) "已连接" else "重连中"}", color = palette.textSecondary, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(8.dp))
            if (store.hubNodes.isNotEmpty()) {
                Surface(shape = RoundedCornerShape(14.dp), color = palette.surface, border = BorderStroke(0.6.dp, palette.hairline)) {
                    Column {
                        store.hubNodes.forEachIndexed { idx, node ->
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable(enabled = node.online && node.id != store.activeNodeID) {
                                        scope.launch { store.switchNode(node.id) }
                                    }
                                    .padding(horizontal = 14.dp, vertical = 12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(node.name, color = if (node.online) palette.textPrimary else palette.textSecondary)
                                    Text(if (node.online) "在线" else "离线", style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
                                }
                                if (node.id == store.activeNodeID) {
                                    Text("当前配置", style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                                }
                            }
                            if (idx < store.hubNodes.lastIndex) HorizontalDivider(color = palette.hairline)
                        }
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            OutlinedButton(
                onClick = { scope.launch { store.logoutHub(); onDismiss() } },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("退出账号", color = palette.warn) }
            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = palette.hairline)
            ClientUpdateSettings(updater)
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) { Text("完成") }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun CreateBotSheet(store: SummonStore, onCreated: (SummonBot) -> Unit = {}, onDismiss: () -> Unit) {
    val palette = LocalSummonPalette.current
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var avatar by remember { mutableStateOf(SummonAvatar()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = palette.background) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("创建新 Bot", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(16.dp))
            GreetingAvatar(avatar)
            val title = name.trim()
            OutlinedTextField(name, { name = it }, placeholder = { Text("为 Bot 取个名字") },
                modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp))
            if (title.length > 100) Text("Bot 名称不能超过 100 个字符。", color = palette.warn)
            AvatarPicker(avatar) { avatar = it }
            error?.let { Text(it, color = palette.warn) }
            Button(onClick = {
                scope.launch {
                    busy = true; error = null
                    try {
                        val bot = store.createBot(name.trim(), avatar, "")
                        onDismiss(); onCreated(bot)
                    } catch (exception: Exception) { error = exception.message }
                    finally { busy = false }
                }
            }, enabled = !busy && store.protocolReady && title.isNotEmpty() && title.length <= 100,
                modifier = Modifier.fillMaxWidth().padding(top = 18.dp)) {
                Text("创建")
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AvatarPicker(avatar: SummonAvatar, onChange: (SummonAvatar) -> Unit) {
    val palette = LocalSummonPalette.current
    val context = androidx.compose.ui.platform.LocalContext.current
    val templates = remember { PaperLibrary.data(context).getJSONArray("templates") }
    var custom by remember { mutableStateOf(false) }
    FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
        SummonAvatar.shapes.forEach { (id,label) ->
            val selected=avatar.image == null && PaperLibrary.role(avatar.shape)==id
            Column(Modifier.width(68.dp).clip(RoundedCornerShape(10.dp)).background(if(selected) palette.selectionBg else Color.Transparent).border(if(selected) 1.5.dp else 0.dp, if(selected) palette.ok else Color.Transparent, RoundedCornerShape(10.dp)).summonPress { onChange(avatar.copy(shape=id,color=PaperLibrary.paperColor(context,avatar.color,avatar.shape),secondary="#E6DDC8",ink="#414A3C",paper="#FFFBF0",image=null)) }.padding(5.dp),horizontalAlignment=Alignment.CenterHorizontally) {
                BotAvatar(id,avatar.color,size=43.dp,secondary=avatar.secondary,ink=avatar.ink,paper=avatar.paper,animated=false)
                Text(label,style=MaterialTheme.typography.labelSmall)
            }
        }
    }
    Text("配色模板",modifier=Modifier.padding(top=12.dp,bottom=8.dp))
    FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
        for(i in 0 until templates.length()) {
            val t=templates.getJSONObject(i)
            val selected=avatar.color.equals(t.getString("color"),true) && avatar.secondary.equals(t.getString("secondary"),true)
            Column(Modifier.width(68.dp).clip(RoundedCornerShape(8.dp)).background(if(selected) palette.selectionBg else Color.Transparent).border(if(selected) 1.5.dp else 0.dp, if(selected) palette.ok else Color.Transparent, RoundedCornerShape(8.dp)).summonPress { onChange(avatar.copy(color=t.getString("color"),secondary=t.getString("secondary"),ink=t.getString("ink"),paper=t.getString("paper"),image=null)) }.padding(4.dp)) {
                Row(Modifier.clip(RoundedCornerShape(5.dp))) { Box(Modifier.weight(1f).height(24.dp).background(summonColor(t.getString("color"))));Box(Modifier.weight(1f).height(24.dp).background(summonColor(t.getString("secondary")))) }
                Text(t.getString("name"),style=MaterialTheme.typography.labelSmall)
            }
        }
    }
    TextButton(onClick={custom=!custom}) { Text(if(custom) "收起自定义颜色 ▴" else "展开自定义颜色 ▾") }
    if(custom) {
        CrewColorField("纸片颜色",PaperLibrary.paperColor(context,avatar.color,avatar.shape)) { onChange(avatar.copy(shape=PaperLibrary.role(avatar.shape),color=it,image=null)) }
        CrewColorField("衬纸颜色",avatar.secondary ?: "#E6DDC8") { onChange(avatar.copy(secondary=it,image=null)) }
        CrewColorField("边线颜色",avatar.ink ?: "#414A3C") { onChange(avatar.copy(ink=it,image=null)) }
        CrewColorField("眼睛留白",avatar.paper ?: "#FFFBF0") { onChange(avatar.copy(paper=it,image=null)) }
    }
}

@Composable
private fun CrewColorField(label:String,value:String,onChange:(String)->Unit) {
    var text by remember(value) { mutableStateOf(value) }
    val valid=Regex("#[0-9a-fA-F]{6}").matches(text)
    OutlinedTextField(text,{ text=it; if(Regex("#[0-9a-fA-F]{6}").matches(it)) onChange(it.uppercase()) },label={Text(label)},supportingText={Text("HEX 颜色，如 #FFC18E")},isError=!valid,singleLine=true,leadingIcon={Box(Modifier.size(22.dp).background(summonColor(value)))},modifier=Modifier.fillMaxWidth())
    val rgb=value.removePrefix("#").toLongOrNull(16) ?: 0L
    listOf("R","G","B").forEachIndexed { i,name ->
        val shift=(2-i)*8
        Row(verticalAlignment=Alignment.CenterVertically) {
            Text(name,modifier=Modifier.width(20.dp))
            androidx.compose.material3.Slider(value=((rgb shr shift) and 255).toFloat(),onValueChange={ component ->
                val next=(rgb and (255L shl shift).inv()) or (component.toLong() shl shift)
                onChange("#%06X".format(next))
            },valueRange=0f..255f,modifier=Modifier.weight(1f))
        }
    }
}

private data class NewGroupSuggestion(
    val id: String,
    val title: String,
    val desc: String,
    val prompt: String,
)

private val newGroupSuggestions = listOf(
    NewGroupSuggestion(
        id = "dev",
        title = "软件与网页开发",
        desc = "写代码、做网页或应用，按需配前端与测试专员",
        prompt = "我想建一个软件与网页开发群，用来推进架构、代码和界面实现，先帮我配好团队并确认要绑定的项目目录。",
    ),
    NewGroupSuggestion(
        id = "schedule",
        title = "个人日程与事务",
        desc = "排差旅、管待办，个人习惯说一遍永久记住",
        prompt = "我想建一个个人日程与日常事务群，帮我整理待办、规划行程并长期记住我的习惯偏好。",
    ),
    NewGroupSuggestion(
        id = "ops",
        title = "服务器运维排障",
        desc = "查日志、盯告警，高风险操作主动拦住",
        prompt = "我想建一个线上服务运维与排障群，负责查日志、处理故障并长期维护运维手册。",
    ),
    NewGroupSuggestion(
        id = "research",
        title = "专题研究与写作",
        desc = "查资料、磨方案，把讨论沉淀成活文档",
        prompt = "我想建一个专题研究与方案写作群，用来收集资料、推演方案并长期维护专业文档。",
    ),
)

@Composable
fun NewGroupDraftScreen(
    store: SummonStore,
    onBack: () -> Unit,
    onCreated: (String) -> Unit,
) {
    val palette = LocalSummonPalette.current
    val scope = rememberCoroutineScope()
    var draftText by remember { mutableStateOf("") }
    var workspaces by remember { mutableStateOf<List<SummonJson>>(emptyList()) }
    var selectedWorkspaceId by remember { mutableStateOf<String?>(null) }
    var workspaceMenuOpen by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val eggBot = remember(store.bots) {
        store.bots.firstOrNull { it.roleId == "eggbot" && !it.isPaused }
            ?: store.bots.firstOrNull { it.roleId == "eggbot" }
    }
    val eggAvatar = eggBot?.resolvedAvatar ?: SummonAvatar.defaultFor("bot-default-eggbot-local")
    val writableWorkspaces = remember(workspaces) {
        workspaces.filter { it["write"].bool != false && !it["id"].string.isNullOrEmpty() }
    }
    val selectedWorkspaceName = remember(writableWorkspaces, selectedWorkspaceId) {
        selectedWorkspaceId?.let { id ->
            writableWorkspaces.firstOrNull { it["id"].string == id }?.get("name")?.string ?: id
        }
    }

    LaunchedEffect(store.protocolReady) {
        if (store.protocolReady) {
            runCatching { store.list("/api/workspaces") }.onSuccess { workspaces = it }
        }
    }

    fun startGroup(text: String, suggestedTitle: String = "") {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || busy || !store.protocolReady) return
        busy = true
        error = null
        scope.launch {
            try {
                val room = store.createConversationalGroup(trimmed, suggestedTitle, selectedWorkspaceId)
                draftText = ""
                selectedWorkspaceId = null
                onCreated(room.id)
            } catch (failure: Exception) {
                error = failure.localizedMessage ?: "创建群聊失败"
            } finally {
                busy = false
            }
        }
    }

    Column(
        Modifier.fillMaxSize().background(palette.background).statusBarsPadding().navigationBarsPadding().imePadding(),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Surface(
                shape = CircleShape,
                color = palette.glassPill,
                border = BorderStroke(0.8.dp, palette.bubbleStroke),
                shadowElevation = 2.dp,
                modifier = Modifier.size(38.dp).clip(CircleShape).clickable(onClick = onBack),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = MaterialTheme.colorScheme.onBackground, modifier = Modifier.size(20.dp))
                }
            }
            Text("新建群聊", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold))
        }

        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp, vertical = 14.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Spacer(Modifier.height(6.dp))
            GreetingAvatar(eggAvatar)

            Surface(
                shape = RoundedCornerShape(22.dp),
                color = palette.surface,
                border = BorderStroke(0.8.dp, palette.bubbleStroke),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 18.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        "${eggBot?.name ?: "EggBot"} · 团队孵化",
                        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = palette.ok,
                    )
                    Text(
                        if (busy) "正在为你建群并安排伙伴…" else "你想要建一个什么群呢？",
                        style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold),
                        textAlign = TextAlign.Center,
                    )
                    Text(
                        if (busy) "群主控、EggBot 与接口 Bot 正在就位，马上进入对话。"
                        else "直接告诉我你想推进的项目、长期事务或想要的专员，我会立刻建群、命名并为你配齐团队。",
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.textSecondary,
                        textAlign = TextAlign.Center,
                    )
                }
            }

            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                newGroupSuggestions.chunked(2).forEach { rowItems ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        rowItems.forEach { item ->
                            Surface(
                                shape = RoundedCornerShape(16.dp),
                                color = palette.surface,
                                border = BorderStroke(0.7.dp, palette.bubbleStroke),
                                modifier = Modifier.weight(1f).clip(RoundedCornerShape(16.dp))
                                    .clickable(enabled = !busy && store.protocolReady) {
                                        startGroup(item.prompt, item.title)
                                    },
                            ) {
                                Column(
                                    Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
                                    verticalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    Text(item.title, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
                                    Text(item.desc, style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                                }
                            }
                        }
                    }
                }
            }

            error?.let { Text(it, color = palette.warn, style = MaterialTheme.typography.bodySmall) }
            Spacer(Modifier.height(12.dp))
        }

        Column(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (writableWorkspaces.isNotEmpty()) {
                Box {
                    Surface(
                        shape = CircleShape,
                        color = if (selectedWorkspaceId != null) palette.selectionBg else palette.glassPill,
                        border = BorderStroke(0.7.dp, palette.bubbleStroke),
                        modifier = Modifier.clip(CircleShape).clickable(enabled = !busy) { workspaceMenuOpen = true },
                    ) {
                        Row(
                            Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Icon(Icons.Filled.Folder, null, tint = palette.textSecondary, modifier = Modifier.size(15.dp))
                            Text(
                                selectedWorkspaceName?.let { "目录：$it" } ?: "绑定项目目录（可选）",
                                style = MaterialTheme.typography.labelMedium,
                                color = if (selectedWorkspaceId != null) MaterialTheme.colorScheme.onSurface else palette.textSecondary,
                            )
                        }
                    }
                    DropdownMenu(expanded = workspaceMenuOpen, onDismissRequest = { workspaceMenuOpen = false }) {
                        writableWorkspaces.forEach { ws ->
                            val wsId = ws["id"].string.orEmpty()
                            val wsName = ws["name"].string?.takeIf { it.isNotBlank() } ?: wsId
                            DropdownMenuItem(
                                text = { Text(wsName) },
                                leadingIcon = {
                                    Icon(if (selectedWorkspaceId == wsId) Icons.Filled.Check else Icons.Filled.Folder, null)
                                },
                                onClick = {
                                    selectedWorkspaceId = wsId
                                    workspaceMenuOpen = false
                                },
                            )
                        }
                        if (selectedWorkspaceId != null) {
                            HorizontalDivider(color = palette.hairline)
                            DropdownMenuItem(
                                text = { Text("暂不绑定目录") },
                                leadingIcon = { Icon(Icons.Filled.Close, null) },
                                onClick = {
                                    selectedWorkspaceId = null
                                    workspaceMenuOpen = false
                                },
                            )
                        }
                    }
                }
            }

            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Surface(
                    shape = RoundedCornerShape(24.dp),
                    color = palette.surface,
                    border = BorderStroke(0.8.dp, palette.bubbleStroke),
                    modifier = Modifier.weight(1f),
                ) {
                    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                        if (draftText.isEmpty()) {
                            Text("说说想建什么群、要做什么事…", color = palette.textTertiary, style = MaterialTheme.typography.bodyLarge)
                        }
                        BasicTextField(
                            value = draftText,
                            onValueChange = { draftText = it },
                            enabled = !busy,
                            maxLines = 5,
                            textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }

                val canSend = !busy && store.protocolReady && draftText.isNotBlank()
                Surface(
                    shape = CircleShape,
                    color = if (canSend) MaterialTheme.colorScheme.primary else palette.surfaceElevated,
                    modifier = Modifier.size(44.dp).clip(CircleShape).clickable(enabled = canSend) {
                        startGroup(draftText)
                    },
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        if (busy) {
                            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                        } else {
                            Icon(
                                Icons.AutoMirrored.Filled.Send,
                                "创建并发送",
                                tint = if (canSend) MaterialTheme.colorScheme.onPrimary else palette.textTertiary,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

fun shareText(context: android.content.Context, text: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(intent, "分享"))
}

fun shareFile(context: android.content.Context, file: java.io.File, mime: String) {
    val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = mime
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(intent, "分享文件"))
}

@Composable
fun rememberPhotoPicker(onPicked: (Uri) -> Unit) = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
    if (uri != null) onPicked(uri)
}

fun photoRequest() = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
