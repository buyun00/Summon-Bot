package org.lin0.relay

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material.icons.filled.Work
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.Image
import kotlinx.coroutines.launch

enum class WorkspaceSection(val title: String, val icon: ImageVector) {
    Bots("管理 Bot", Icons.Filled.Groups),
    Works("工作", Icons.Filled.Work),
    Knowledge("知识", Icons.Filled.MenuBook),
    Routines("定时职责", Icons.Filled.Schedule),
    Event("投递事件", Icons.Filled.Bolt),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationListScreen(
    store: RelayStore,
    onOpenRoom: (String) -> Unit,
    onOpenWorkspace: (WorkspaceSection) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var showSettings by remember { mutableStateOf(false) }
    var showCreateBot by remember { mutableStateOf(false) }
    var roomKind by remember { mutableStateOf<String?>(null) }
    var showSystem by remember { mutableStateOf(false) }
    var showPeers by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var plus by remember { mutableStateOf(false) }
    var opening by remember { mutableStateOf(false) }
    fun matches(text: String) = query.isBlank() || text.contains(query, ignoreCase = true)
    val groups = store.rooms.filter { it.kind != "dm" && matches("${it.name} ${it.goal}") }
    val contacts = store.bots.filter { it.presetId.isNullOrEmpty() && matches("${it.name} ${it.role}") }
        .sortedByDescending { directRoom(store, it)?.lastMessage?.createdAt.orEmpty() }
    val systemBots = store.bots.filter { !it.presetId.isNullOrEmpty() && matches("${it.name} ${it.role}") }
    val peers = store.rooms.filter { it.kind == "dm" && !it.members.contains("user") && matches(it.name) }

    Scaffold(
        containerColor = Color.Black,
        topBar = {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                IconButton(onClick = { showSettings = true }) { Icon(Icons.Filled.Person, "设置", tint = Color.White) }
                Box {
                    IconButton(onClick = { plus = true }) { Icon(Icons.Filled.Add, "新建", tint = Color.White) }
                    DropdownMenu(expanded = plus, onDismissRequest = { plus = false }) {
                        DropdownMenuItem(text = { Text("创建新 Bot") }, onClick = { plus = false; showCreateBot = true })
                        DropdownMenuItem(text = { Text("创建群聊") }, onClick = { plus = false; roomKind = "group" })
                        DropdownMenuItem(text = { Text("发起深聊") }, onClick = { plus = false; roomKind = "deep" })
                    }
                }
            }
        },
        bottomBar = {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box {
                    Surface(shape = CircleShape, color = Color(0xFF2C2C2E), modifier = Modifier.size(48.dp).clickable { menu = true }) {
                        Box(contentAlignment = Alignment.Center) { Icon(Icons.Filled.GridView, "连接应用与工作台", tint = Color.White) }
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        WorkspaceSection.entries.forEach { section ->
                            DropdownMenuItem(text = { Text(section.title) }, leadingIcon = { Icon(section.icon, null) }, onClick = { menu = false; onOpenWorkspace(section) })
                        }
                        DropdownMenuItem(text = { Text("连接设置") }, onClick = { menu = false; showSettings = true })
                    }
                }
                Spacer(Modifier.width(12.dp))
                Surface(shape = RoundedCornerShape(28.dp), color = Color(0xFF2C2C2E), modifier = Modifier.weight(1f)) {
                    Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Search, null, tint = Color(0xFF8E8E93))
                        OutlinedTextField(
                            value = query, onValueChange = { query = it }, modifier = Modifier.weight(1f),
                            placeholder = { Text("搜索") }, singleLine = true,
                        )
                        if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Close, "清除搜索") }
                    }
                }
            }
        },
    ) { padding ->
        PullToRefreshBox(isRefreshing = store.isRefreshing, onRefresh = { scope.launch { store.refresh() } }, modifier = Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                item {
                    if (store.isLoading && store.bots.isEmpty()) {
                        Row(Modifier.fillMaxWidth().padding(top = 24.dp), horizontalArrangement = Arrangement.Center) {
                            CircularProgressIndicator(); Spacer(Modifier.width(8.dp)); Text("正在打开工作空间…")
                        }
                    }
                    store.errorMessage?.let { error ->
                        Row(Modifier.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(error, color = Color(0xFFFF9F0A), modifier = Modifier.weight(1f))
                            TextButton(onClick = { scope.launch { store.reconnect() } }) { Text("重连") }
                        }
                    } ?: run {
                        if (!store.isConnected && store.bots.isNotEmpty()) {
                            Row(Modifier.padding(20.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Filled.WifiOff, null, tint = Color(0xFF8E8E93))
                                Spacer(Modifier.width(8.dp))
                                Text("已显示本机记录，正在连接…", color = Color(0xFF8E8E93), style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
                if (groups.isNotEmpty()) {
                    item {
                        GroupGrid(groups, store.bots) { onOpenRoom(it) }
                    }
                }
                items(contacts, key = { it.id }) { bot ->
                    ContactRow(store, bot) {
                        if (opening) return@ContactRow
                        opening = true
                        scope.launch {
                            try {
                                val room = store.openDirectMessage(bot)
                                onOpenRoom(room.id)
                            } catch (error: Exception) {
                                store.errorMessage = error.message
                            } finally { opening = false }
                        }
                    }
                }
                if (systemBots.isNotEmpty()) {
                    item {
                        TextButton(onClick = { showSystem = !showSystem }, modifier = Modifier.padding(horizontal = 14.dp)) {
                            Text("系统 Bot · ${systemBots.size}", color = Color(0xFF8E8E93))
                        }
                    }
                    if (showSystem) items(systemBots, key = { "sys-${it.id}" }) { bot ->
                        ContactRow(store, bot) {
                            scope.launch {
                                try { onOpenRoom(store.openDirectMessage(bot).id) } catch (error: Exception) { store.errorMessage = error.message }
                            }
                        }
                    }
                }
                if (peers.isNotEmpty()) {
                    item {
                        TextButton(onClick = { showPeers = !showPeers }, modifier = Modifier.padding(horizontal = 14.dp)) {
                            Text("Bot 之间的对话", color = Color(0xFF8E8E93))
                        }
                    }
                    if (showPeers) items(peers, key = { "peer-${it.id}" }) { room ->
                        Row(Modifier.fillMaxWidth().clickable { onOpenRoom(room.id) }.padding(22.dp, 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            RoomAvatar(room, store.bots, 44.dp)
                            Spacer(Modifier.width(14.dp))
                            Text(room.name)
                        }
                    }
                }
                if (store.bots.isEmpty() && store.rooms.isEmpty() && !store.isLoading) {
                    item {
                        Column(Modifier.fillMaxWidth().padding(top = 80.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("你的工作空间", style = MaterialTheme.typography.titleLarge)
                            Text(if (store.errorMessage == null) "创建第一位 Bot，开始聊天。" else "暂时无法获取记录，请检查服务连接。", color = Color(0xFF8E8E93), modifier = Modifier.padding(16.dp))
                            Button(onClick = { showCreateBot = true }) { Text("创建 Bot") }
                            TextButton(onClick = { showSettings = true }) { Text("连接设置") }
                        }
                    }
                } else if (contacts.isEmpty() && groups.isEmpty() && systemBots.isEmpty() && query.isNotEmpty()) {
                    item { Text("没有与“$query”匹配的结果", modifier = Modifier.padding(24.dp), color = Color(0xFF8E8E93)) }
                }
            }
        }
    }
    if (showSettings) SettingsSheet(store) { showSettings = false }
    if (showCreateBot) CreateBotSheet(store, onOpenRoom) { showCreateBot = false }
    roomKind?.let { kind -> CreateRoomSheet(store, kind, onOpenRoom) { roomKind = null } }
}

@Composable
private fun GroupGrid(groups: List<RelayRoom>, bots: List<RelayBot>, onOpen: (String) -> Unit) {
    Column(Modifier.padding(horizontal = 28.dp, vertical = 16.dp)) {
        groups.chunked(2).forEach { row ->
            Row(Modifier.fillMaxWidth()) {
                row.forEach { room ->
                    Column(Modifier.weight(1f).clickable { onOpen(room.id) }.padding(vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        RoomAvatar(room, bots, 90.dp)
                        Text(room.name, color = Color(0xFF8E8E93), maxLines = 1)
                        if (room.kind == "deep") Text(if (room.status == "concluded") "已结束" else "深聊", color = Color(0xFF636366), style = MaterialTheme.typography.labelSmall)
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun ContactRow(store: RelayStore, bot: RelayBot, onClick: () -> Unit) {
    val room = directRoom(store, bot)
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 22.dp, vertical = 19.dp), verticalAlignment = Alignment.CenterVertically) {
        MemberAvatar(bot, 50.dp)
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Row {
                Text(bot.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f), maxLines = 1)
                Text(formatRelayTime(room?.lastMessage?.createdAt), color = Color(0xFF636366), style = MaterialTheme.typography.labelSmall)
            }
            val preview = if (bot.status == "paused") "已暂停" else preview(room, bot)
            Text(preview, color = Color(0xFF8E8E93), maxLines = 1)
        }
    }
}

private fun directRoom(store: RelayStore, bot: RelayBot) =
    store.rooms.firstOrNull { it.kind == "dm" && it.members.contains("user") && it.members.contains(bot.id) }

private fun preview(room: RelayRoom?, bot: RelayBot): String {
    val last = room?.lastMessage
    if (last != null) return last.content.ifEmpty { last.attachments.joinToString("、") { "[附件] ${it.name}" } }
    return bot.role.ifEmpty { "开始聊天" }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsSheet(store: RelayStore, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var baseURL by remember { mutableStateOf(store.settings.baseURL) }
    var token by remember { mutableStateOf(store.savedToken) }
    var userName by remember { mutableStateOf(store.settings.userName) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Color(0xFF1C1C1E)) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(painterResource(R.drawable.relay_icon), null, Modifier.size(52.dp).clip(RoundedCornerShape(14.dp)))
                Spacer(Modifier.width(16.dp))
                Column {
                    Text("Relay Bot", style = MaterialTheme.typography.titleMedium)
                    Text("Android 原生客户端", color = Color(0xFF8E8E93))
                }
            }
            Spacer(Modifier.height(16.dp))
            Text("个人信息", color = Color(0xFF8E8E93))
            OutlinedTextField(userName, { userName = it }, label = { Text("显示名称") }, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))
            Text("服务连接", color = Color(0xFF8E8E93))
            OutlinedTextField(baseURL, { baseURL = it }, label = { Text("https://bot.lin0.org") }, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), singleLine = true)
            OutlinedTextField(token, { token = it }, label = { Text("访问令牌（如服务需要）") }, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation(), singleLine = true)
            Text("填写现有 Relay Web 服务地址。直接连接网关时填写访问令牌，令牌保存在系统加密存储中。", color = Color(0xFF8E8E93), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 8.dp))
            Text("实时消息  ${if (store.isConnected) "已连接" else "未连接"}")
            Text("Bot  ${store.bots.size}")
            Text("会话  ${store.rooms.size}")
            error?.let { Text(it, color = Color(0xFFFF9F0A), modifier = Modifier.padding(vertical = 6.dp)) }
            Button(onClick = {
                scope.launch {
                    saving = true; error = null
                    try { store.saveConnection(baseURL, token, userName); onDismiss() }
                    catch (exception: Exception) { error = exception.message }
                    finally { saving = false }
                }
            }, enabled = !saving && baseURL.isNotBlank(), modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                if (saving) CircularProgressIndicator(Modifier.size(18.dp)) else Text("保存并连接")
            }
            Text("已读取的会话和草稿保存在这台设备，失败消息需要手动重试。切换服务时会清除这台设备上的会话缓存。", color = Color(0xFF8E8E93), style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) { Text("完成") }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun CreateBotSheet(store: RelayStore, onOpenRoom: (String) -> Unit, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var avatar by remember { mutableStateOf(RelayAvatar()) }
    var busy by remember { mutableStateOf(false) }
    var created by remember { mutableStateOf<RelayBot?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Color.Black) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("创建新 Bot", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(16.dp))
            BotAvatar(avatar.shape, avatar.color, avatar.image, 148.dp, secondary=avatar.secondary, ink=avatar.ink, paper=avatar.paper)
            OutlinedTextField(name, { name = it.take(100) }, placeholder = { Text("为 Bot 取个名字") }, modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp))
            AvatarPicker(avatar) { avatar = it }
            error?.let { Text(it, color = Color(0xFFFF9F0A)) }
            Button(onClick = {
                scope.launch {
                    busy = true; error = null
                    try {
                        val bot = created ?: store.createBot(name.trim(), avatar).also { created = it }
                        val room = store.openDirectMessage(bot)
                        onDismiss(); onOpenRoom(room.id)
                    } catch (exception: Exception) { error = exception.message }
                    finally { busy = false }
                }
            }, enabled = !busy && name.isNotBlank(), modifier = Modifier.fillMaxWidth().padding(top = 18.dp)) {
                Text(if (created == null) "创建" else "打开聊天")
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AvatarPicker(avatar: RelayAvatar, onChange: (RelayAvatar) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val templates = remember { CrewLibrary.data(context).getJSONArray("templates") }
    var custom by remember { mutableStateOf(false) }
    FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
        RelayAvatar.shapes.forEach { (id,label) ->
            val selected=avatar.image == null && CrewLibrary.role(avatar.shape)==id
            Column(Modifier.width(68.dp).clip(RoundedCornerShape(10.dp)).background(if(selected) Color(0xFF454559) else Color.Transparent).clickable { onChange(avatar.copy(shape=id,image=null)) }.padding(5.dp),horizontalAlignment=Alignment.CenterHorizontally) {
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
            Column(Modifier.width(68.dp).clip(RoundedCornerShape(8.dp)).background(if(selected) Color(0xFF454559) else Color.Transparent).clickable { onChange(avatar.copy(color=t.getString("color"),secondary=t.getString("secondary"),ink=t.getString("ink"),paper=t.getString("paper"),image=null)) }.padding(4.dp)) {
                Row { Box(Modifier.weight(1f).height(24.dp).background(relayColor(t.getString("color"))));Box(Modifier.weight(1f).height(24.dp).background(relayColor(t.getString("secondary")))) }
                Text(t.getString("name"),style=MaterialTheme.typography.labelSmall)
            }
        }
    }
    TextButton(onClick={custom=!custom}) { Text(if(custom) "收起自定义颜色 ▴" else "展开自定义颜色 ▾") }
    if(custom) {
        val model=CrewLibrary.model(context,CrewLibrary.role(avatar.shape))
        CrewColorField("主色块",avatar.color) { onChange(avatar.copy(color=it,image=null)) }
        CrewColorField("辅助色",avatar.secondary ?: model.secondary) { onChange(avatar.copy(secondary=it,image=null)) }
        CrewColorField("描边与眼睛",avatar.ink ?: "#142443") { onChange(avatar.copy(ink=it,image=null)) }
        CrewColorField("底色",avatar.paper ?: "#FFFAF1") { onChange(avatar.copy(paper=it,image=null)) }
    }
}

@Composable
private fun CrewColorField(label:String,value:String,onChange:(String)->Unit) {
    var text by remember(value) { mutableStateOf(value) }
    val valid=Regex("#[0-9a-fA-F]{6}").matches(text)
    OutlinedTextField(text,{ text=it; if(Regex("#[0-9a-fA-F]{6}").matches(it)) onChange(it.uppercase()) },label={Text(label)},supportingText={Text("HEX 颜色，如 #FFC18E")},isError=!valid,singleLine=true,leadingIcon={Box(Modifier.size(22.dp).background(relayColor(value)))},modifier=Modifier.fillMaxWidth())
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
fun CreateRoomSheet(store: RelayStore, initialKind: String, onOpenRoom: (String) -> Unit, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var goal by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf(initialKind) }
    var members by remember { mutableStateOf(setOf<String>()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val canCreate = name.isNotBlank() && members.isNotEmpty() && (kind != "deep" || goal.isNotBlank())
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Color(0xFF1C1C1E)) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp)) {
            Text(if (kind == "deep") "发起深聊" else "创建群聊", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(name, { name = it }, label = { Text("会话名称") }, modifier = Modifier.fillMaxWidth())
            Row {
                TextButton(onClick = { kind = "group" }) { Text(if (kind == "group") "群聊 ✓" else "群聊") }
                TextButton(onClick = { kind = "deep" }) { Text(if (kind == "deep") "深聊 ✓" else "深聊") }
            }
            OutlinedTextField(goal, { goal = it }, label = { Text("讨论目标") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
            Text("选择成员", modifier = Modifier.padding(vertical = 8.dp))
            store.bots.forEach { bot ->
                Row(Modifier.fillMaxWidth().clickable {
                    members = if (bot.id in members) members - bot.id else members + bot.id
                }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    MemberAvatar(bot, 32.dp)
                    Spacer(Modifier.width(12.dp))
                    Text(bot.name, modifier = Modifier.weight(1f))
                    if (bot.id in members) Icon(Icons.Filled.Check, null)
                }
            }
            error?.let { Text(it, color = Color(0xFFFF9F0A)) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss) { Text("取消") }
                TextButton(enabled = !busy && canCreate, onClick = {
                    scope.launch {
                        busy = true; error = null
                        try {
                            val room = store.createGroup(name, listOf("user") + members.sorted(), goal, kind)
                            onDismiss(); onOpenRoom(room.id)
                        } catch (exception: Exception) { error = exception.message }
                        finally { busy = false }
                    }
                }) { Text("创建") }
            }
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
