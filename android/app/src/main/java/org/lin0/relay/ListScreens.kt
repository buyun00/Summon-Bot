package org.lin0.relay

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Contrast
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Terminal
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

enum class ResourceSection(val title: String, val icon: ImageVector, val path: String) {
    Bots("成员", Icons.Filled.Groups, "/api/bots"),
    Executions("执行会话", Icons.Filled.Terminal, "/api/executions"),
    Files("资料", Icons.Filled.Folder, "/api/files"),
    Wakeups("订阅与提醒", Icons.Filled.Schedule, "/api/wakeups"),
    Connections("执行连接与额度", Icons.Filled.Link, "/api/connections"),
}

private data class HomeFolder(val id: String, val name: String, val keys: List<String>)

private data class HomeOrg(
    val pinnedKeys: List<String> = emptyList(),
    val folders: List<HomeFolder> = emptyList(),
    val collapsedIds: Set<String> = emptySet(),
) {
    fun isPinned(key: String) = key in pinnedKeys
    fun togglePin(key: String): HomeOrg = copy(
        pinnedKeys = if (key in pinnedKeys) pinnedKeys - key else pinnedKeys + key,
    )
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
        obj.put("collapsedIds", JSONArray(collapsedIds.toList()))
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
                val collapsed = obj.optJSONArray("collapsedIds")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }.orEmpty()
                val folders = obj.optJSONArray("folders")?.let { a ->
                    (0 until a.length()).map { idx ->
                        val f = a.getJSONObject(idx)
                        val keys = f.optJSONArray("keys")?.let { k -> (0 until k.length()).map { k.getString(it) } }.orEmpty()
                        HomeFolder(f.getString("id"), f.getString("name"), keys)
                    }
                }.orEmpty()
                HomeOrg(pinned, folders, collapsed)
            }.getOrDefault(HomeOrg())
        }
    }
}

private sealed interface HomeEntryKind {
    data class Room(val room: SummonRoom) : HomeEntryKind
    data class Bot(val bot: SummonBot, val directRoom: SummonRoom?) : HomeEntryKind
}

private data class HomeEntry(
    val key: String,
    val kind: HomeEntryKind,
    val title: String,
    val preview: String,
    val timestamp: String,
    val sortDate: String,
    val isPaused: Boolean,
)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun ConversationListScreen(
    store: SummonStore,
    updater: SummonAppUpdater,
    onOpenUsage: () -> Unit,
    onOpenModels: () -> Unit,
    onOpenRoom: (String) -> Unit,
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
    var showCreateBot by remember { mutableStateOf(false) }
    var showCreateRoom by remember { mutableStateOf(false) }
    var showFolderManager by remember { mutableStateOf(false) }
    var actionEntry by remember { mutableStateOf<HomeEntry?>(null) }
    var newFolderTargetKey by remember { mutableStateOf<String?>(null) }
    var showNewFolderDialog by remember { mutableStateOf(false) }
    var newFolderName by remember { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var plus by remember { mutableStateOf(false) }
    var opening by remember { mutableStateOf(false) }
    var quotaItem by remember { mutableStateOf<SummonJson?>(null) }

    val allEntries = remember(store.rooms, store.bots, store.settings.userName) {
        val directByBot = store.bots.mapNotNull { bot -> directRoom(store, bot)?.let { bot.id to it } }.toMap()
        val primaryDirectIds = directByBot.values.map { it.id }.toSet()

        val roomEntries = store.rooms
            .filterNot { it.id in primaryDirectIds }
            .map { room ->
                val last = room.lastMessage
                val summary = if (last != null) {
                    "${store.name(last.senderId)}：${messageSummary(last)}"
                } else "开始聊天"
                HomeEntry(
                    key = "room:${room.id}",
                    kind = HomeEntryKind.Room(room),
                    title = room.name,
                    preview = summary,
                    timestamp = formatSummonTime(last?.createdAt),
                    sortDate = last?.createdAt ?: room.updatedAt ?: room.createdAt.orEmpty(),
                    isPaused = false,
                )
            }

        val botEntries = store.bots.map { bot ->
            val room = directByBot[bot.id]
            val last = room?.lastMessage
            val summary = when {
                bot.isPaused -> "已暂停"
                last != null -> messageSummary(last)
                else -> "开始聊天"
            }
            HomeEntry(
                key = "bot:${bot.id}",
                kind = HomeEntryKind.Bot(bot, room),
                title = bot.name,
                preview = summary,
                timestamp = formatSummonTime(last?.createdAt),
                sortDate = last?.createdAt ?: room?.updatedAt ?: room?.createdAt.orEmpty(),
                isPaused = bot.isPaused,
            )
        }

        (roomEntries + botEntries).sortedWith(compareByDescending<HomeEntry> { it.sortDate }.thenBy { it.title })
    }

    val trimmedQuery = query.trim()
    val filteredEntries = remember(allEntries, trimmedQuery) {
        if (trimmedQuery.isEmpty()) allEntries
        else allEntries.filter { it.title.contains(trimmedQuery, ignoreCase = true) || it.preview.contains(trimmedQuery, ignoreCase = true) }
    }
    val entryByKey = remember(allEntries) { allEntries.associateBy { it.key } }
    val pinnedEntries = if (trimmedQuery.isEmpty()) org.pinnedKeys.mapNotNull { entryByKey[it] } else emptyList()
    val pinnedSet = org.pinnedKeys.toSet()
    val unpinnedEntries = if (trimmedQuery.isEmpty()) filteredEntries.filterNot { it.key in pinnedSet } else filteredEntries
    val assignedKeys = org.folders.flatMap { it.keys }.toSet()
    val defaultEntries = unpinnedEntries.filterNot { it.key in assignedKeys }

    fun openEntry(entry: HomeEntry) {
        when (val kind = entry.kind) {
            is HomeEntryKind.Room -> onOpenRoom(kind.room.id)
            is HomeEntryKind.Bot -> {
                if (kind.directRoom != null) {
                    onOpenRoom(kind.directRoom.id)
                    return
                }
                if (opening) return
                opening = true
                scope.launch {
                    try {
                        val room = store.openDirectMessage(kind.bot)
                        onOpenRoom(room.id)
                    } catch (error: Exception) {
                        store.errorMessage = error.message
                    } finally { opening = false }
                }
            }
        }
    }

    val model = store.modelSummary["chat"]
    val menuHeight = (LocalConfiguration.current.screenHeightDp * 100f / LocalSummonDisplay.current.zoom * .7f).dp
    val statusBarTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val topClearance = statusBarTop + 58.dp
    val bottomClearance = 94.dp

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
                contentPadding = PaddingValues(top = topClearance + 6.dp, bottom = bottomClearance + 12.dp),
            ) {
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
                        Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            pinnedEntries.chunked(3).forEach { rowItems ->
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                    rowItems.forEach { entry ->
                                        Column(
                                            Modifier.weight(1f).clip(RoundedCornerShape(16.dp))
                                                .combinedClickable(onClick = { openEntry(entry) }, onLongClick = { actionEntry = entry })
                                                .padding(vertical = 4.dp),
                                            horizontalAlignment = Alignment.CenterHorizontally,
                                            verticalArrangement = Arrangement.spacedBy(7.dp),
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
                        HomeConversationRow(entry, store.bots, onClick = { openEntry(entry) }, onLongClick = { actionEntry = entry })
                    }
                } else {
                    if (defaultEntries.isNotEmpty()) {
                        val defaultCollapsed = "__default__" in org.collapsedIds
                        item(key = "folder-header-default") {
                            FolderSectionHeader("主要", defaultCollapsed) { updateOrg(org.toggleCollapsed("__default__")) }
                        }
                        if (!defaultCollapsed) {
                            items(defaultEntries, key = { it.key }) { entry ->
                                HomeConversationRow(entry, store.bots, onClick = { openEntry(entry) }, onLongClick = { actionEntry = entry })
                            }
                        }
                    }
                    org.folders.forEach { folder ->
                        val folderKeySet = folder.keys.toSet()
                        val folderEntries = unpinnedEntries.filter { it.key in folderKeySet }
                        val collapsed = folder.id in org.collapsedIds
                        item(key = "folder-header-${folder.id}") {
                            FolderSectionHeader(folder.name, collapsed) { updateOrg(org.toggleCollapsed(folder.id)) }
                        }
                        if (!collapsed) {
                            if (folderEntries.isEmpty()) {
                                item(key = "folder-empty-${folder.id}") {
                                    Text(
                                        "长按会话可移入此文件夹",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = palette.textTertiary,
                                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
                                    )
                                }
                            } else {
                                items(folderEntries, key = { "${folder.id}:${it.key}" }) { entry ->
                                    HomeConversationRow(entry, store.bots, onClick = { openEntry(entry) }, onLongClick = { actionEntry = entry })
                                }
                            }
                        }
                    }
                }

                if (store.bots.isEmpty() && store.rooms.isEmpty() && !store.isLoading && store.protocolReady) {
                    item(key = "empty-workspace") {
                        Column(Modifier.fillMaxWidth().padding(top = 80.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("你的工作空间", style = MaterialTheme.typography.titleLarge)
                            Text(if (store.errorMessage == null) "创建第一位 Bot，开始聊天。" else "暂时无法获取记录，请检查服务连接。", color = palette.textSecondary, modifier = Modifier.padding(16.dp))
                            Button(onClick = { showCreateBot = true }) { Text("创建 Bot") }
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
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, modifier = Modifier.width(268.dp).heightIn(max = menuHeight)) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        ModelQuotaSignal(model, "默认模型", Modifier.weight(1f)) { menu = false; quotaItem = model }
                    }
                    DropdownMenuItem(text = { Text("Token 统计") }, leadingIcon = { Icon(Icons.Filled.BarChart, null) }, onClick = { menu = false; onOpenUsage() })
                    DropdownMenuItem(text = { Text("显示与外观") }, leadingIcon = { Icon(Icons.Filled.Contrast, null) }, onClick = { menu = false; showDisplay = true })
                    DropdownMenuItem(text = { Text("设置") }, leadingIcon = { Icon(Icons.Filled.Settings, null) }, onClick = { menu = false; showSettings = true })
                    DropdownMenuItem(text = { Text("模型与用量") }, leadingIcon = { Icon(Icons.Filled.Memory, null) }, onClick = { menu = false; onOpenModels() })
                    HorizontalDivider(Modifier.padding(vertical = 6.dp), color = palette.hairline)
                    ResourceSection.entries.forEach { section ->
                        DropdownMenuItem(text = { Text(section.title) }, leadingIcon = { Icon(section.icon, null) }, onClick = { menu = false; onOpenResource(section) })
                    }
                }
            }
            Box {
                Surface(
                    shape = CircleShape,
                    color = palette.glassPill,
                    border = BorderStroke(0.8.dp, palette.bubbleStroke),
                    shadowElevation = 2.dp,
                    modifier = Modifier.size(40.dp).clip(CircleShape).clickable(enabled = store.protocolReady) { plus = true },
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.Add, "新建", tint = MaterialTheme.colorScheme.onBackground, modifier = Modifier.size(22.dp))
                    }
                }
                DropdownMenu(expanded = plus, onDismissRequest = { plus = false }, modifier = Modifier.heightIn(max = menuHeight)) {
                    DropdownMenuItem(text = { Text("创建新 Bot") }, onClick = { plus = false; showCreateBot = true })
                    DropdownMenuItem(text = { Text("创建群聊") }, onClick = { plus = false; showCreateRoom = true })
                    HorizontalDivider(color = palette.hairline)
                    DropdownMenuItem(text = { Text("新建文件夹") }, onClick = {
                        plus = false
                        newFolderTargetKey = null
                        newFolderName = ""
                        showNewFolderDialog = true
                    })
                }
            }
        }

        // Floating bottom bar: left circular folder button + right translucent glass search pill
        Box(
            Modifier.fillMaxWidth().align(Alignment.BottomCenter)
                .background(Brush.verticalGradient(0f to Color.Transparent, 0.32f to palette.background.copy(alpha = 0.74f), 0.65f to palette.background.copy(alpha = 0.94f), 1f to palette.background))
                .navigationBarsPadding()
                .padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 10.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Surface(
                    shape = CircleShape,
                    color = palette.glassPill,
                    border = BorderStroke(0.8.dp, palette.bubbleStroke),
                    shadowElevation = 2.dp,
                    modifier = Modifier.size(46.dp).clip(CircleShape).clickable { showFolderManager = true },
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.GridView, "管理文件夹", tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(20.dp))
                    }
                }
                Surface(
                    shape = CircleShape,
                    color = palette.glassPill,
                    border = BorderStroke(0.8.dp, palette.bubbleStroke),
                    shadowElevation = 2.dp,
                    modifier = Modifier.weight(1f),
                ) {
                    Row(Modifier.padding(start = 12.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Search, null, tint = palette.textSecondary, modifier = Modifier.size(20.dp))
                        TextField(
                            value = query,
                            onValueChange = { query = it },
                            placeholder = { Text("搜索", color = palette.textTertiary) },
                            singleLine = true,
                            modifier = Modifier.weight(1f),
                            colors = TextFieldDefaults.colors(
                                focusedContainerColor = Color.Transparent,
                                unfocusedContainerColor = Color.Transparent,
                                disabledContainerColor = Color.Transparent,
                                focusedIndicatorColor = Color.Transparent,
                                unfocusedIndicatorColor = Color.Transparent,
                                disabledIndicatorColor = Color.Transparent,
                            ),
                        )
                        if (query.isNotEmpty()) {
                            IconButton(onClick = { query = "" }, modifier = Modifier.size(32.dp)) {
                                Icon(Icons.Filled.Close, "清除搜索", tint = palette.textTertiary, modifier = Modifier.size(16.dp))
                            }
                        }
                    }
                }
            }
        }
    }

    actionEntry?.let { entry ->
        val pinned = org.isPinned(entry.key)
        val currentFolderId = org.folderIdFor(entry.key)
        ModalBottomSheet(onDismissRequest = { actionEntry = null }, containerColor = palette.surfaceElevated) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(entry.title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 6.dp))
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable {
                        updateOrg(org.togglePin(entry.key))
                        actionEntry = null
                    }.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(Icons.Filled.PushPin, null, tint = palette.ok)
                    Text(if (pinned) "取消置顶" else "置顶到顶部")
                }
                HorizontalDivider(color = palette.hairline)
                Text("移到文件夹", style = MaterialTheme.typography.labelMedium, color = palette.textSecondary, modifier = Modifier.padding(top = 6.dp, start = 4.dp))
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable {
                        updateOrg(org.move(entry.key, null))
                        actionEntry = null
                    }.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("主要（默认）", modifier = Modifier.weight(1f))
                    if (currentFolderId == null) Icon(Icons.Filled.Check, null, tint = palette.ok)
                }
                org.folders.forEach { folder ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable {
                            updateOrg(org.move(entry.key, folder.id))
                            actionEntry = null
                        }.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.Folder, null, tint = palette.textSecondary, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(10.dp))
                        Text(folder.name, modifier = Modifier.weight(1f))
                        if (currentFolderId == folder.id) Icon(Icons.Filled.Check, null, tint = palette.ok)
                    }
                }
                TextButton(onClick = {
                    newFolderTargetKey = entry.key
                    newFolderName = ""
                    actionEntry = null
                    showNewFolderDialog = true
                }) { Text("+ 新建文件夹并移入") }
                Spacer(Modifier.height(16.dp))
            }
        }
    }

    if (showNewFolderDialog) {
        AlertDialog(
            onDismissRequest = { showNewFolderDialog = false; newFolderTargetKey = null },
            title = { Text("新建文件夹") },
            text = {
                OutlinedTextField(newFolderName, { newFolderName = it }, placeholder = { Text("如 Tech、工作") }, singleLine = true)
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

    if (showFolderManager) {
        HomeFolderManagerSheet(org = org, entries = allEntries, bots = store.bots, onUpdate = ::updateOrg, onDismiss = { showFolderManager = false })
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
    if (showSettings) SettingsSheet(store, updater) { showSettings = false }
    if (showCreateBot) CreateBotSheet(store, onOpenRoom) { showCreateBot = false }
    if (showCreateRoom) CreateRoomSheet(store, onOpenRoom) { showCreateRoom = false }
}

@Composable
private fun FolderSectionHeader(title: String, collapsed: Boolean, onToggle: () -> Unit) {
    val palette = LocalSummonPalette.current
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
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
    when (val kind = entry.kind) {
        is HomeEntryKind.Room -> RoomAvatar(kind.room, bots, size)
        is HomeEntryKind.Bot -> MemberAvatar(kind.bot, size)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HomeConversationRow(entry: HomeEntry, bots: List<SummonBot>, onClick: () -> Unit, onLongClick: () -> Unit) {
    val palette = LocalSummonPalette.current
    Row(
        Modifier.fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 20.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.alpha(if (entry.isPaused) 0.45f else 1f)) {
            HomeEntryAvatar(entry, bots, 48.dp)
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
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
                color = palette.textSecondary,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeFolderManagerSheet(
    org: HomeOrg,
    entries: List<HomeEntry>,
    bots: List<SummonBot>,
    onUpdate: (HomeOrg) -> Unit,
    onDismiss: () -> Unit,
) {
    val palette = LocalSummonPalette.current
    var newName by remember { mutableStateOf("") }
    var editingFolderId by remember { mutableStateOf<String?>(null) }
    var renamingFolder by remember { mutableStateOf<HomeFolder?>(null) }
    var renameText by remember { mutableStateOf("") }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = palette.surfaceElevated,
    ) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val activeFolder = org.folders.firstOrNull { it.id == editingFolderId }
            if (activeFolder != null) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { editingFolderId = null }) { Text("返回") }
                    Text(activeFolder.name, style = MaterialTheme.typography.titleMedium)
                    TextButton(onClick = onDismiss) { Text("完成") }
                }
                entries.forEach { entry ->
                    val included = entry.key in activeFolder.keys
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable {
                            onUpdate(org.move(entry.key, if (included) null else activeFolder.id))
                        }.padding(vertical = 8.dp, horizontal = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        HomeEntryAvatar(entry, bots, 34.dp)
                        Text(entry.title, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (included) Icon(Icons.Filled.Check, null, tint = palette.ok)
                    }
                }
            } else {
                Text("文件夹分栏", style = MaterialTheme.typography.titleLarge)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(newName, { newName = it }, placeholder = { Text("新建文件夹名称") }, singleLine = true, modifier = Modifier.weight(1f))
                    Button(enabled = newName.isNotBlank(), onClick = {
                        val (next, _) = org.createFolder(newName)
                        onUpdate(next)
                        newName = ""
                    }) { Text("添加") }
                }
                if (org.folders.isEmpty()) {
                    Text("新建文件夹后可在此勾选分配会话，或在主界面长按任意会话置顶或归类。", style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
                }
                org.folders.forEach { folder ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { editingFolderId = folder.id }.padding(vertical = 8.dp, horizontal = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.Folder, null, tint = palette.textSecondary)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(folder.name, style = MaterialTheme.typography.bodyLarge)
                            Text("${folder.keys.size} 个会话", style = MaterialTheme.typography.labelSmall, color = palette.textSecondary)
                        }
                        IconButton(onClick = { renamingFolder = folder; renameText = folder.name }) {
                            Icon(Icons.Filled.Edit, "重命名", tint = palette.textSecondary, modifier = Modifier.size(18.dp))
                        }
                        IconButton(onClick = { onUpdate(org.deleteFolder(folder.id)) }) {
                            Icon(Icons.Filled.Delete, "删除", tint = palette.textSecondary, modifier = Modifier.size(18.dp))
                        }
                    }
                }
                TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) { Text("完成") }
            }
            Spacer(Modifier.height(16.dp))
        }
    }
    renamingFolder?.let { folder ->
        AlertDialog(
            onDismissRequest = { renamingFolder = null },
            title = { Text("重命名文件夹") },
            text = { OutlinedTextField(renameText, { renameText = it }, singleLine = true) },
            confirmButton = {
                TextButton(enabled = renameText.isNotBlank(), onClick = {
                    onUpdate(org.renameFolder(folder.id, renameText))
                    renamingFolder = null
                }) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { renamingFolder = null }) { Text("取消") } },
        )
    }
}

private fun directRoom(store: SummonStore, bot: SummonBot) =
    store.rooms.firstOrNull { !it.isGroup && bot.id in it.members }

private fun messageSummary(message: SummonMessage): String {
    val cleaned = message.content.replace('\n', ' ').trim()
    if (cleaned.isNotEmpty()) return cleaned
    if (message.attachments.isNotEmpty()) return "[附件] " + message.attachments.joinToString("、") { it.name }
    return "共享了引用"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsSheet(store: SummonStore, updater: SummonAppUpdater, onDismiss: () -> Unit) {
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
            Text("个人信息", color = palette.textSecondary)
            OutlinedTextField(userName, { userName = it }, label = { Text("显示名称") }, modifier = Modifier.fillMaxWidth())
            TextButton(enabled = userName != store.settings.userName, onClick = {
                store.setUserName(userName); userName = store.settings.userName
            }) { Text("保存显示名称") }
            Spacer(Modifier.height(12.dp))
            Text("服务连接", color = palette.textSecondary)
            OutlinedTextField(baseURL, { baseURL = it }, label = { Text("https://你的实例地址") }, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), singleLine = true)
            OutlinedTextField(token, { token = it }, label = { Text("实例访问令牌") }, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), singleLine = true)
            Text("使用部署机提供的 HTTPS 地址和访问令牌。本机回环及 .local 地址可使用 HTTP。令牌保存在系统加密存储中。", color = palette.textSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 8.dp))
            Text("实时消息  ${if (store.isConnected) "已连接" else "未连接"}")
            Text("Bot  ${store.bots.size}")
            Text("会话  ${store.rooms.size}")
            error?.let { Text(it, color = palette.warn, modifier = Modifier.padding(vertical = 6.dp)) }
            Button(onClick = {
                scope.launch {
                    saving = true; error = null
                    try { store.saveConnection(baseURL, token); onDismiss() }
                    catch (exception: Exception) { error = exception.message }
                    finally { saving = false }
                }
            }, enabled = !saving && baseURL.isNotBlank(), modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                if (saving) CircularProgressIndicator(Modifier.size(18.dp)) else Text("保存并连接")
            }
            Text("草稿和待确认的发送保存在这台设备。重新连接后，可按原发送记录查询保存状态。", color = palette.textSecondary, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(20.dp))
            Text("显示与外观", style = MaterialTheme.typography.titleMedium)
            DisplaySettingsControls()
            TextButton(onClick = { display.reset() }) { Text("恢复默认显示") }
            ClientUpdateSettings(updater)
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) { Text("完成") }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun CreateBotSheet(store: SummonStore, onOpenRoom: (String) -> Unit, onDismiss: () -> Unit) {
    val palette = LocalSummonPalette.current
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var avatar by remember { mutableStateOf(SummonAvatar()) }
    var busy by remember { mutableStateOf(false) }
    var created by remember { mutableStateOf<SummonBot?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = palette.background) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("创建新 Bot", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(16.dp))
            GreetingAvatar(avatar)
            val savedBot = created
            val title = name.trim()
            if (savedBot == null) {
                OutlinedTextField(name, { name = it }, placeholder = { Text("为 Bot 取个名字") },
                    modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp))
                if (title.length > 100) Text("Bot 名称不能超过 100 个字符。", color = palette.warn)
                AvatarPicker(avatar) { avatar = it }
            } else Text("${savedBot.name} 已创建", Modifier.padding(vertical = 16.dp))
            error?.let { Text(it, color = palette.warn) }
            Button(onClick = {
                scope.launch {
                    busy = true; error = null
                    try {
                        val bot = created ?: store.createBot(name.trim(), avatar, "").also { created = it }
                        val room = store.openDirectMessage(bot)
                        onDismiss(); onOpenRoom(room.id)
                    } catch (exception: Exception) { error = exception.message }
                    finally { busy = false }
                }
            }, enabled = !busy && store.protocolReady && (created != null || title.isNotEmpty() && title.length <= 100),
                modifier = Modifier.fillMaxWidth().padding(top = 18.dp)) {
                Text(if (created == null) "创建" else "打开聊天")
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateRoomSheet(store: SummonStore, onOpenRoom: (String) -> Unit, onDismiss: () -> Unit) {
    val palette = LocalSummonPalette.current
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf("") }
    var members by remember { mutableStateOf<Set<String>>(emptySet()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = palette.surfaceElevated) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("创建群聊", style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(title, { title = it }, label = { Text("群名称（可选）") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Text("成员", style = MaterialTheme.typography.titleMedium)
            store.bots.forEach { bot ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    MemberAvatar(bot, 30.dp)
                    Text(bot.name, Modifier.padding(horizontal = 12.dp).weight(1f))
                    Checkbox(checked = bot.id in members, onCheckedChange = { included ->
                        members = if (included) members + bot.id else members - bot.id
                    })
                }
            }
            error?.let { Text(it, color = Color(0xFFFF9F0A)) }
            Button(enabled = !busy && store.protocolReady, onClick = {
                busy = true; error = null
                scope.launch {
                    try {
                        val record = store.createGroup(title.trim(), store.bots.map { it.id }.filter { it in members })
                        onDismiss(); onOpenRoom(record.id)
                    } catch (failure: Exception) { error = failure.localizedMessage }
                    finally { busy = false }
                }
            }) { Text("创建") }
            Spacer(Modifier.height(20.dp))
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
