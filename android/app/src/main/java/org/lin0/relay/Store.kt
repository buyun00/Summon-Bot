package org.lin0.relay

import android.content.Context
import android.net.Uri
import android.util.AtomicFile
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.Instant
import java.util.UUID

class SummonStore(private val app: Context) {
    var settings by mutableStateOf(SummonConnectionSettings(baseURL = ""))
        private set
    var hubNodes by mutableStateOf<List<SummonHubNode>>(emptyList())
        private set
    var activeNodeID by mutableStateOf<String?>(null)
        private set
    var filterNodeID by mutableStateOf<String?>(null)
    var remoteNodeRooms by mutableStateOf<Map<String, List<SummonRoom>>>(emptyMap())
        private set
    var remoteNodeBots by mutableStateOf<Map<String, List<SummonBot>>>(emptyMap())
        private set
    var bots by mutableStateOf<List<SummonBot>>(emptyList())
        private set
    var rooms by mutableStateOf<List<SummonRoom>>(emptyList())
        private set
    var archivedRooms by mutableStateOf<List<SummonRoom>>(emptyList())
        private set
    var pendingMessages by mutableStateOf<List<SummonPendingMessage>>(emptyList())
        private set
    var draftAttachments by mutableStateOf<Map<String, List<SummonAttachment>>>(emptyMap())
        private set
    var draftMentions by mutableStateOf<Map<String, List<String>>>(emptyMap())
        private set
    var draftReplies by mutableStateOf<Map<String, String>>(emptyMap())
        private set
    var draftReferences by mutableStateOf<Map<String, List<SummonReference>>>(emptyMap())
        private set
    var isLoading by mutableStateOf(false)
        private set
    var isRefreshing by mutableStateOf(false)
        private set
    var isConnected by mutableStateOf(false)
        private set
    var protocolReady by mutableStateOf(false)
        private set
    var protocolNotice by mutableStateOf<String?>(null)
        private set
    var needsClientUpdate by mutableStateOf(false)
        private set
    var sendingRoomIDs by mutableStateOf<Set<String>>(emptySet())
        private set
    var lastSyncAt by mutableStateOf<Long?>(null)
        private set
    var modelSummary by mutableStateOf<SummonJson>(SummonJson.Null)
        private set
    var roomExecutions by mutableStateOf<Map<String, List<SummonJson>>>(emptyMap())
        private set
    var roomActivities by mutableStateOf<Map<String, List<SummonRoomActivity>>>(emptyMap())
        private set
    var roomSuspendedRuns by mutableStateOf<Map<String, List<SummonJson>>>(emptyMap())
        private set
    var roomMessageStates by mutableStateOf<Map<String, Map<String, SummonJson>>>(emptyMap())
        private set
    var errorMessage by mutableStateOf<String?>(null)

    private var drafts by mutableStateOf<Map<String, String>>(emptyMap())
    private var messageHistory by mutableStateOf<Map<String, List<SummonMessage>>>(emptyMap())
    private var deliveries by mutableStateOf<Map<String, List<SummonDelivery>>>(emptyMap())
    private var messageSummaries by mutableStateOf<Map<String, List<SummonMessageSummary>>>(emptyMap())
    private var cursors by mutableStateOf<Map<String, String>>(emptyMap())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var client: SummonApiClient? = null
    private var streamJob: Job? = null
    private var refreshJob: Job? = null
    private var recoveryJob: Job? = null
    private var persistenceJob: Job? = null
    private val roomReads = mutableSetOf<String>()
    private val olderReadsWaiting = mutableSetOf<String>()
    private var connectionGeneration = 0
    private var historyEpoch: String? = null
    private var activeRoomID: String? = null
    private var refreshAgain = false
    private var foreground = false
    private val prefs = app.getSharedPreferences(SETTINGS_KEY, Context.MODE_PRIVATE)
    private val storageDirectory = File(app.filesDir, "RelayNative")

    val isConfigured: Boolean get() = client != null
    val savedToken: String get() = SummonKeystore.token(app, settings.baseURL)
    val onlineNodes: List<SummonHubNode> get() = hubNodes.filter { it.online }
    val offlineNodes: List<SummonHubNode> get() = hubNodes.filterNot { it.online }
    val mixedGroupRooms: List<Triple<String, String, SummonRoom>>
        get() = buildList {
            for (node in onlineNodes) {
                val filter = filterNodeID
                if (filter != null && filter != node.id) continue
                val list = if (node.id == activeNodeID) rooms else remoteNodeRooms[node.id].orEmpty()
                for (room in list) if (room.isGroup) add(Triple(node.id, node.name, room))
            }
        }
    fun anyBot(id: String): SummonBot? =
        bots.firstOrNull { it.id == id } ?: remoteNodeBots.values.firstNotNullOfOrNull { list -> list.firstOrNull { it.id == id } }

    init {
        val saved = prefs.getString(SETTINGS_KEY, null)
        if (saved != null) runCatching {
            val previous = SummonJson.parse(saved)
            settings = SummonConnectionSettings.parse(previous)
            if (previous.obj?.containsKey("workspaceID") == true)
                prefs.edit().putString(SETTINGS_KEY, settings.toJson().encode().toString()).apply()
        }
        activeNodeID = settings.activeNodeID
        client = runCatching { SummonApiClient(SummonApiClient.normalized(settings.baseURL), savedToken, activeNodeID) }.getOrNull()
        restoreSnapshot()
    }

    fun dispose() {
        disconnect()
        scope.cancel()
    }

    suspend fun start() {
        if (client == null || foreground) return
        foreground = true
        val connection = connectionGeneration
        refresh()
        if (!foreground || connection != connectionGeneration) return
        startStream()
        startRecovery()
    }

    suspend fun reconnect() = start()

    fun disconnect() {
        connectionGeneration++
        foreground = false
        streamJob?.cancel(); streamJob = null
        refreshJob?.cancel(); refreshJob = null
        recoveryJob?.cancel(); recoveryJob = null
        roomReads.clear()
        olderReadsWaiting.clear()
        isConnected = false; protocolReady = false; isLoading = false; isRefreshing = false; refreshAgain = false
        pendingMessages = pendingMessages.map { if (it.status == "sending") it.copy(status = "failed", error = "保存状态待确认。") else it }
        sendingRoomIDs = emptySet()
        persistNow()
    }

    suspend fun loginHub(baseURL: String, username: String, password: String) {
        val url = SummonApiClient.normalized(baseURL.trim().ifEmpty { SummonApiClient.DEFAULT_HUB_URL })
        val authClient = SummonApiClient(url, "")
        val result = withContext(Dispatchers.IO) { authClient.hubLogin(username.trim(), password) }
        finishHubAuth(url, result)
    }

    suspend fun registerHub(baseURL: String, inviteCode: String, username: String, password: String, displayName: String?) {
        val url = SummonApiClient.normalized(baseURL.trim().ifEmpty { SummonApiClient.DEFAULT_HUB_URL })
        val authClient = SummonApiClient(url, "")
        val result = withContext(Dispatchers.IO) {
            authClient.hubRegister(inviteCode.trim(), username.trim(), password, displayName?.trim())
        }
        finishHubAuth(url, result)
    }

    private suspend fun finishHubAuth(url: java.net.URI, result: SummonHubAuthResult) {
        val endpoint = url.toString()
        SummonKeystore.save(app, result.token, endpoint)
        disconnect()
        clearServerState()
        hubNodes = emptyList()
        remoteNodeRooms = emptyMap()
        remoteNodeBots = emptyMap()
        activeNodeID = null
        filterNodeID = null
        settings = SummonConnectionSettings(
            baseURL = endpoint,
            userName = result.displayName.ifBlank { result.username },
            hubUsername = result.username,
            activeNodeID = null,
        )
        prefs.edit().putString(SETTINGS_KEY, settings.toJson().encode().toString()).apply()
        client = SummonApiClient(url, result.token, null)
        errorMessage = null
        protocolNotice = null
        persistNow()
        start()
    }

    suspend fun logoutHub() {
        val api = client
        if (api != null) withContext(Dispatchers.IO) { api.hubLogout() }
        disconnect()
        clearServerState()
        hubNodes = emptyList()
        remoteNodeRooms = emptyMap()
        remoteNodeBots = emptyMap()
        activeNodeID = null
        filterNodeID = null
        if (settings.baseURL.isNotEmpty()) SummonKeystore.save(app, "", settings.baseURL)
        settings = SummonConnectionSettings("", settings.userName, null, null)
        prefs.edit().putString(SETTINGS_KEY, settings.toJson().encode().toString()).apply()
        client = null
    }

    suspend fun switchNode(nodeID: String) {
        val api = client ?: return
        if (nodeID == activeNodeID) return
        if (hubNodes.none { it.id == nodeID && it.online }) return
        activeNodeID = nodeID
        settings = settings.copy(activeNodeID = nodeID)
        prefs.edit().putString(SETTINGS_KEY, settings.toJson().encode().toString()).apply()
        client = api.forNode(nodeID)
        historyEpoch = null
        messageHistory = emptyMap(); deliveries = emptyMap(); messageSummaries = emptyMap()
        roomActivities = emptyMap(); cursors = emptyMap(); roomSuspendedRuns = emptyMap(); roomMessageStates = emptyMap()
        remoteNodeRooms[nodeID]?.let { rooms = it }
        remoteNodeBots[nodeID]?.let { bots = it }
        protocolReady = false
        protocolNotice = null
        refresh()
    }

    suspend fun saveConnection(baseURL: String, token: String) {
        val url = SummonApiClient.normalized(baseURL)
        val endpoint = url.toString()
        val changed = endpoint != settings.baseURL
        val newClient = SummonApiClient(url, token.trim())
        val startup = try { withContext(Dispatchers.IO) { newClient.bootstrap() } }
        catch (error: SummonApiException) {
            if (error.status == 503 && error.code == "updating") null else throw SummonApiException(startupError(error))
        }
        catch (_: java.net.UnknownHostException) { null }
        catch (_: java.io.InterruptedIOException) { null }
        catch (_: java.net.SocketException) { null }
        SummonKeystore.save(app, token.trim(), endpoint)
        disconnect()
        if (changed) clearServerState()
        settings = SummonConnectionSettings(endpoint, settings.userName)
        prefs.edit().putString(SETTINGS_KEY, settings.toJson().encode().toString()).apply()
        client = newClient
        if (changed) restoreSnapshot()
        if (startup != null) acceptStartup(startup) else protocolNotice = "连接已保存，等待服务响应。"
        errorMessage = null
        persistNow()
        if (startup != null) start() else scope.launch { start() }
    }

    fun setUserName(name: String) {
        settings = settings.copy(userName = name.trim().ifEmpty { "Lin" })
        prefs.edit().putString(SETTINGS_KEY, settings.toJson().encode().toString()).apply()
    }

    suspend fun refresh() {
        val api = client ?: return
        if (!foreground) return
        if (isRefreshing) { refreshAgain = true; return }
        val connection = connectionGeneration
        isRefreshing = true
        isLoading = bots.isEmpty() && rooms.isEmpty()
        try {
            val nodes = withContext(Dispatchers.IO) { api.hubNodes() }
            if (connection != connectionGeneration) return
            hubNodes = nodes
            val online = nodes.filter { it.online }
            if (online.isEmpty()) {
                activeNodeID = null
                rooms = emptyList(); archivedRooms = emptyList(); bots = emptyList()
                remoteNodeRooms = emptyMap(); remoteNodeBots = emptyMap()
                protocolReady = false
                protocolNotice = "当前没有在线电脑。请在任意电脑启动 Summon Bot 并登录同一账号。"
                errorMessage = null
                return
            }
            if (activeNodeID == null || online.none { it.id == activeNodeID }) {
                activeNodeID = online.first().id
                settings = settings.copy(activeNodeID = activeNodeID)
                prefs.edit().putString(SETTINGS_KEY, settings.toJson().encode().toString()).apply()
            }
            val activeApi = api.forNode(activeNodeID)
            client = activeApi
            if (!protocolReady || protocolNotice != null) {
                val startup = withContext(Dispatchers.IO) { activeApi.bootstrap() }
                if (connection != connectionGeneration) return
                acceptStartup(startup)
                if (!startup.ready) return
            }
            val state = withContext(Dispatchers.IO) { activeApi.requestJson("/api/state") }
            if (connection != connectionGeneration) return
            val epoch = state["historyEpoch"].string
            if (historyEpoch != epoch) { messageHistory = emptyMap(); deliveries = emptyMap(); messageSummaries = emptyMap(); roomActivities = emptyMap(); cursors = emptyMap(); roomSuspendedRuns = emptyMap(); roomMessageStates = emptyMap() }
            historyEpoch = epoch
            bots = (state["bots"].array ?: throw SummonApiException.invalidResponse).map(SummonBot::parse)
            rooms = (state["rooms"].array ?: throw SummonApiException.invalidResponse).map { SummonRoom.parse(it) }
            archivedRooms = state["archivedRooms"].array.orEmpty().map { SummonRoom.parse(it) }
            if (state["modelSettings"].obj != null) modelSummary = state["modelSettings"]
            val nextRemoteRooms = remoteNodeRooms.toMutableMap()
            val nextRemoteBots = remoteNodeBots.toMutableMap()
            activeNodeID?.let { aid -> nextRemoteRooms[aid] = rooms; nextRemoteBots[aid] = bots }
            for (other in online) {
                if (other.id == activeNodeID) continue
                runCatching {
                    val otherState = withContext(Dispatchers.IO) { activeApi.forNode(other.id).requestJson("/api/state") }
                    nextRemoteRooms[other.id] = otherState["rooms"].array.orEmpty().map { SummonRoom.parse(it) }
                    nextRemoteBots[other.id] = otherState["bots"].array.orEmpty().map(SummonBot::parse)
                }
            }
            remoteNodeRooms = nextRemoteRooms
            remoteNodeBots = nextRemoteBots
            errorMessage = null
            lastSyncAt = System.currentTimeMillis()
            activeRoomID?.takeIf { room(it) != null }?.let { loadRoom(it) }
            if (connection == connectionGeneration) schedulePersistence()
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (connection != connectionGeneration) return
            if ((error as? SummonApiException)?.status == 401) {
                logoutHub()
                errorMessage = "请使用 Summon Bot 账号登录。"
                return
            }
            if (!protocolReady) protocolNotice = startupError(error) else handle(error)
        } finally {
            if (connection == connectionGeneration) {
                isRefreshing = false; isLoading = false
                if (refreshAgain) { refreshAgain = false; scheduleRefresh() }
            }
        }
    }

    private fun acceptStartup(startup: SummonBootstrap) {
        protocolReady = startup.ready
        protocolNotice = startup.notice
        needsClientUpdate = startup.protocolVersion > SummonApiClient.PROTOCOL_VERSION
    }

    private fun startupError(error: Exception): String = when {
        error is SummonApiException && error.status == 404 && error.code == null -> "正在等待服务支持当前协议。草稿和待确认的发送已保留。"
        error is SummonApiException && error.status == 503 && error.code == "updating" -> "服务正在更新。草稿和待确认的发送已保留。"
        else -> error.localizedMessage ?: "暂时无法连接服务。"
    }

    private fun handle(error: Exception) {
        when {
            error is SummonApiException && error.status == 426 -> {
                protocolReady = false; isConnected = false
                protocolNotice = "正在重新检查服务协议。"
                scheduleRefresh()
            }
            error is SummonApiException && error.status == 503 && error.code == "updating" ->
                protocolNotice = "服务正在更新。草稿和待确认的发送已保留。"
            else -> errorMessage = error.localizedMessage
        }
    }

    suspend fun selectRoom(id: String) {
        ensureRoomActive(id)
        loadRoom(id)
    }

    fun ensureRoomActive(id: String) { activeRoomID = id }
    fun deactivateRoom(id: String) { if (activeRoomID == id) activeRoomID = null }

    fun messagesForRoom(id: String): List<SummonMessage> {
        val remote = messageHistory[id].orEmpty()
        val confirmed = remote.filter(SummonMessage::isOwn).mapNotNull(SummonMessage::clientId).toSet()
        return remote + pendingMessages.filter { it.roomID == id && it.clientID !in confirmed }.map(SummonPendingMessage::message)
    }

    fun room(id: String): SummonRoom? = rooms.firstOrNull { it.id == id } ?: archivedRooms.firstOrNull { it.id == id }
    fun bot(id: String): SummonBot? = bots.firstOrNull { it.id == id }
    fun name(id: String): String = when (id) {
        "user" -> settings.userName
        "system", "platform" -> "Summon 平台"
        else -> bot(id)?.name ?: id
    }

    fun label(ref: SummonReference): String = when (ref.kind) {
        "bot", "user" -> name(ref.id)
        "room" -> room(ref.id)?.name ?: ref.id
        "event" -> "消息 · " + ref.id
        "file" -> "资料 · " + ref.id
        "workspace_file" -> "工作区 · " + (ref.filePath?.substringAfterLast('/') ?: ref.filePath ?: ref.id)
        "session" -> "执行会话 · " + ref.id
        "conversation" -> "内部对话 · " + ref.id
        else -> ref.id
    }

    fun deliveryFacts(id: String): List<SummonDelivery> = deliveries[id].orEmpty()
    fun summaryFacts(id: String): List<SummonMessageSummary> = messageSummaries[id].orEmpty()
    fun activitiesForRoom(id: String): List<SummonRoomActivity> = roomActivities[id].orEmpty()
    fun executionsForRoom(id: String): List<SummonJson> = roomExecutions[id].orEmpty()
    fun activeExecutionsForRoom(id: String): List<SummonJson> {
        val live = setOf("opening", "running", "submitted", "waiting", "queued", "needs_input", "awaiting_input")
        return roomExecutions[id].orEmpty().filter { it["status"].stringValue in live }
    }
    fun suspendedRunsForRoom(roomId: String): List<SummonJson> =
        roomSuspendedRuns[roomId].orEmpty()
    suspend fun retrySuspendedRun(conversationId: String, runId: String?) {
        val fields = mutableListOf(
            "target" to SummonJson.obj("kind" to SummonJson.Str("conversation"), "id" to SummonJson.Str(conversationId))
        )
        if (!runId.isNullOrBlank()) fields += "run_id" to SummonJson.Str(runId)
        request("/api/executions/retry", "POST", SummonJson.Obj(fields.toMap()))
        scheduleRefresh()
    }
    suspend fun stopRoom(roomId: String) {
        request(roomPath(roomId) + "/stop", "POST", SummonJson.obj())
        scheduleRefresh()
    }
    fun pendingMessage(message: SummonMessage): SummonPendingMessage? =
        pendingMessages.firstOrNull { it.clientID == message.clientId && it.roomID == message.roomId }

    fun canLoadOlder(id: String): Boolean = id in cursors

    suspend fun loadRoom(id: String, older: Boolean = false) {
        val api = client ?: return
        if (!protocolReady) return
        if (!roomReads.add(id)) {
            if (older) olderReadsWaiting.add(id)
            return
        }
        val connection = connectionGeneration
        try {
            val cursor = if (older) cursors[id] ?: return else null
            val suffix = cursor?.let { "?cursor=" + SummonApiClient.component(it) }.orEmpty()
            val snapshot = withContext(Dispatchers.IO) { api.requestJson(roomPath(id) + "/messages" + suffix) }
            if (connection != connectionGeneration) return
            if (snapshot["historyEpoch"].string != historyEpoch) { scheduleRefresh(); return }
            upsertRoom(SummonRoom.parse(snapshot["room"]))
            val page = snapshot["messages"].array.orEmpty().map { SummonMessage.parse(it) }
            val cached = messageHistory[id].orEmpty()
            val pageIDs = page.map(SummonMessage::id).toSet()
            val retainCache = older || cached.any { it.id in pageIDs }
            val all = ((if (retainCache) cached else emptyList()) + page).associateBy(SummonMessage::id).values
                .sortedWith(compareBy({ it.createdAt.orEmpty() }, { it.sequence ?: 0 }, { it.id }))
            messageHistory = messageHistory + (id to all)
            if (older || all.firstOrNull()?.id == page.firstOrNull()?.id) {
                val next = snapshot["cursor"].string
                cursors = if (next != null) cursors + (id to next) else cursors - id
            } else if (id !in cursors) {
                all.firstOrNull()?.id?.let { cursors = cursors + (id to it) }
            }
            deliveries = deliveries + snapshot["deliveries"].obj.orEmpty().mapValues { SummonDelivery.list(it.value) }
            messageSummaries = messageSummaries + snapshot["summaries"].obj.orEmpty().mapValues { SummonMessageSummary.list(it.value) }
            val pageStates = snapshot["messageStates"].obj.orEmpty()
            val baseStates = if (retainCache) roomMessageStates[id].orEmpty() else emptyMap()
            roomMessageStates = roomMessageStates + (id to (baseStates + pageStates))
            if (!older) {
                roomActivities = roomActivities + (id to SummonRoomActivity.list(snapshot["activities"]))
                roomSuspendedRuns = roomSuspendedRuns + (id to snapshot["suspendedRuns"].array.orEmpty())
            }
            val confirmed = page.filter(SummonMessage::isOwn).mapNotNull(SummonMessage::clientId).toSet()
            val staged = pendingMessages.filter { it.roomID == id && it.clientID in confirmed }.flatMap { it.message.attachments }
            pendingMessages = pendingMessages.filterNot { it.roomID == id && it.clientID in confirmed }
            if (staged.isNotEmpty() && persistComposer()) staged.forEach(::discardStagedAttachment)
            schedulePersistence()
            lastSyncAt = System.currentTimeMillis()
            if (!older) {
                runCatching { list("/api/executions?room=" + SummonApiClient.component(id)) }.getOrNull()?.let { execs ->
                    if (connection == connectionGeneration) roomExecutions = roomExecutions + (id to execs)
                }
            }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { if (connection == connectionGeneration && id == activeRoomID) handle(error) }
        finally {
            if (connection == connectionGeneration) {
                roomReads.remove(id)
                if (olderReadsWaiting.remove(id) && activeRoomID == id) scope.launch {
                    if (connection == connectionGeneration && activeRoomID == id) loadRoom(id, older = true)
                }
            }
        }
    }

    suspend fun createBot(name: String, avatar: SummonAvatar, instructions: String): SummonBot {
        val body = SummonJson.obj("name" to SummonJson.Str(name), "instructions" to SummonJson.Str(instructions), "avatar" to avatar.toJson())
        return SummonBot.parse(request("/api/bots", "POST", body, newID())).also(::upsertBot)
    }

    suspend fun updateBot(bot: SummonBot, vararg changes: Pair<String, SummonJson>): SummonBot {
        val revision = bot.revision ?: throw SummonApiException.invalidResponse
        val body = SummonJson.Obj(mapOf(*changes) + ("revision" to revision.numOrNull()))
        val result = request("/api/bots/" + SummonApiClient.component(bot.id), "PATCH", body, newID())
        return SummonBot.parse(result).also(::upsertBot)
    }

    suspend fun setAvatar(avatar: SummonAvatar, botID: String): SummonBot {
        val result = request("/api/bots/" + SummonApiClient.component(botID), "PATCH", SummonJson.obj("avatar" to avatar.toJson()), newID())
        return SummonBot.parse(result).also(::upsertBot)
    }

    suspend fun createGroup(name: String, members: List<String>, workspaceID: String? = null, skipWelcome: Boolean = false): SummonRoom {
        val room = createRoom(name, members, mode = "group", workspaceID = workspaceID, skipWelcome = skipWelcome)
        refresh()
        return room
    }

    suspend fun createConversationalGroup(rawText: String, suggestedTitle: String = "", workspaceID: String? = null): SummonRoom {
        val text = rawText.trim()
        if (text.isEmpty() || !protocolReady) throw SummonApiException.invalidResponse
        val title = deriveInitialGroupTitle(text, suggestedTitle)
        val room = createRoom(title, emptyList(), mode = "group", workspaceID = workspaceID, skipWelcome = true)
        refresh()
        val egg = bots.firstOrNull { it.roleId == "eggbot" && !it.isPaused }
        val mentions = if (egg != null && egg.id in room.members) listOf(egg.id) else emptyList()
        val id = newID()
        val message = SummonMessage(
            id = "local-$id",
            roomId = room.id,
            senderId = "user",
            content = text,
            mentions = mentions,
            clientId = id,
            createdAt = Instant.now().toString(),
        )
        pendingMessages = pendingMessages + SummonPendingMessage(id, message, "queued", null)
        deliver(id, queryFirst = false)
        return room
    }

    private fun deriveInitialGroupTitle(rawText: String, suggestedTitle: String = ""): String {
        val suggested = suggestedTitle.trim()
        if (suggested.isNotEmpty()) return suggested.take(24)
        val firstLine = rawText.trim().lineSequence().firstOrNull().orEmpty()
        val cleaned = firstLine
            .replace(Regex("^(?:你好|嗨|hi|hello|请|麻烦|帮我|给我|我要|我想|想|想要|准备|打算|可以)?\\s*(?:新建|创建|建立|建|开|搭|组建|拉)?(?:一个|个)?\\s*", RegexOption.IGNORE_CASE), "")
            .replace(Regex("^(?:关于|用来|用于|专门)?\\s*"), "")
            .replace(Regex("[，。！？；：、,.!?;:~～]+.*$"), "")
            .replace(Regex("(?:的)?(?:群聊|群|工作群|项目群|协作群|小群)$"), "")
            .trim()
        return if (cleaned.isEmpty()) "新群聊" else cleaned.take(16)
    }

    private suspend fun createRoom(name: String, members: List<String>, mode: String, workspaceID: String? = null, skipWelcome: Boolean = false): SummonRoom {
        val body = SummonJson.Obj(buildMap {
            put("members", members.toJsonStrings())
            put("mode", SummonJson.Str(mode))
            if (name.isNotEmpty()) put("title", SummonJson.Str(name))
            if (!workspaceID.isNullOrEmpty()) put("workspace", SummonJson.Str(workspaceID))
            if (skipWelcome) put("skip_welcome", SummonJson.Bool(true))
        })
        return SummonRoom.parse(request("/api/rooms", "POST", body, newID())).also(::upsertRoom)
    }

    suspend fun updateRoom(room: SummonRoom, name: String, members: List<String>) {
        val title = name.trim()
        changeRoom(room, buildMap {
            if (title.isNotEmpty() && title != room.name) put("title", SummonJson.Str(title))
            put("add_members", members.filterNot { it in room.members }.toJsonStrings())
            put("remove_members", room.members.filter { it != "user" && it !in members }.toJsonStrings())
        })
    }

    suspend fun leaveRoom(room: SummonRoom) {
        changeRoom(room, mapOf("remove_members" to listOf("user").toJsonStrings()))
        removeLocalRoom(room.id)
    }

    suspend fun archiveRoom(room: SummonRoom) {
        val revision = room.revision ?: throw SummonApiException.invalidResponse
        request(roomPath(room.id) + "/archive", "POST", SummonJson.obj("revision" to revision.numOrNull()))
        refresh()
    }

    suspend fun restoreRoom(room: SummonRoom) {
        val revision = room.revision ?: throw SummonApiException.invalidResponse
        request(roomPath(room.id) + "/restore", "POST", SummonJson.obj("revision" to revision.numOrNull()))
        refresh()
    }

    suspend fun deleteGroup(room: SummonRoom) {
        val revision = room.revision ?: throw SummonApiException.invalidResponse
        request(roomPath(room.id), "DELETE", SummonJson.obj("revision" to revision.numOrNull()))
        removeLocalRoom(room.id)
    }

    private fun removeLocalRoom(id: String) {
        rooms = rooms.filterNot { it.id == id }
        archivedRooms = archivedRooms.filterNot { it.id == id }
        if (activeRoomID == id) activeRoomID = null
        schedulePersistence()
    }

    suspend fun setPin(ref: SummonReference, room: SummonRoom, remove: Boolean) {
        val field = if (remove) "pin_remove" else "pin_add"
        changeRoom(room, mapOf(field to SummonJson.Arr(listOf(ref.toJson()))))
    }

    private suspend fun changeRoom(room: SummonRoom, changes: Map<String, SummonJson>) {
        val revision = room.revision ?: throw SummonApiException.invalidResponse
        val body = SummonJson.Obj(changes + ("revision" to revision.numOrNull()))
        upsertRoom(SummonRoom.parse(request(roomPath(room.id), "PATCH", body, newID())))
    }

    fun draft(id: String): String = drafts[id].orEmpty()
    fun setDraft(value: String, id: String) { drafts = drafts + (id to value); schedulePersistence() }
    fun setDraftAttachments(value: List<SummonAttachment>, id: String) {
        draftAttachments = draftAttachments + (id to value)
        persistNow()
    }
    fun setDraftMentions(value: List<String>, id: String) { draftMentions = draftMentions + (id to value); schedulePersistence() }
    fun setDraftReply(value: String?, id: String) {
        draftReplies = if (value == null) draftReplies - id else draftReplies + (id to value)
        schedulePersistence()
    }
    fun setDraftReferences(value: List<SummonReference>, id: String) { draftReferences = draftReferences + (id to value); schedulePersistence() }

    suspend fun sendMessage(roomID: String) {
        if (!protocolReady || roomID in sendingRoomIDs) return
        val text = draft(roomID)
        val files = draftAttachments[roomID].orEmpty()
        val refs = draftReferences[roomID].orEmpty()
        if (text.isBlank() && files.isEmpty() && refs.isEmpty()) return
        if (files.size > 8) { errorMessage = SummonApiException.tooManyAttachments.message; return }
        val id = newID()
        val message = SummonMessage("local-$id", roomID, "user", text, files, refs, draftMentions[roomID].orEmpty(),
            draftReplies[roomID], id, Instant.now().toString())
        pendingMessages = pendingMessages + SummonPendingMessage(id, message, "queued", null)
        drafts = drafts - roomID; draftAttachments = draftAttachments - roomID; draftMentions = draftMentions - roomID
        draftReplies = draftReplies - roomID; draftReferences = draftReferences - roomID
        deliver(id, queryFirst = false)
    }

    suspend fun sendPromptResponse(roomID: String, message: SummonMessage, answers: List<SummonJson>, summaryText: String, skipped: Boolean = false) {
        if (!protocolReady || roomID in sendingRoomIDs || (!skipped && answers.isEmpty())) return
        val room = room(roomID)
        val mentions = if (message.senderId != "user" && message.senderId != "system" && room?.members?.contains(message.senderId) == true) {
            listOf(message.senderId)
        } else emptyList()
        val promptResponse = SummonJson.Obj(buildMap {
            put("prompt_message_id", SummonJson.Str(message.id))
            put("answers", SummonJson.Arr(answers))
            if (skipped) put("skipped", SummonJson.Bool(true))
        })
        val id = newID()
        val outgoing = SummonMessage(
            id = "local-$id", roomId = roomID, senderId = "user", content = summaryText,
            mentions = mentions, replyTo = message.id, clientId = id,
            createdAt = Instant.now().toString(), promptResponse = promptResponse,
        )
        pendingMessages = pendingMessages + SummonPendingMessage(id, outgoing, "queued", null)
        deliver(id, queryFirst = false)
    }

    suspend fun submitPendingExecutionInput(target: SummonJson, controlVersion: Int, inputTarget: SummonJson, input: String) {
        if (!protocolReady) throw SummonApiException.invalidResponse
        request(
            "/api/executions/input",
            "POST",
            SummonJson.obj(
                "target" to target,
                "kind" to SummonJson.Str("reply"),
                "control_version" to controlVersion.numOrNull(),
                "input_target" to inputTarget,
                "input" to SummonJson.Str(input),
            ),
            newID(),
        )
        refresh()
    }

    suspend fun retryMessage(clientID: String) = deliver(clientID, queryFirst = true)

    fun restoreRejectedMessage(item: SummonPendingMessage) {
        val id = item.roomID
        if (pendingMessages.none { it.clientID == item.clientID && it.status == "rejected" }) return
        if (draft(id).isNotEmpty() || !draftAttachments[id].isNullOrEmpty() || !draftMentions[id].isNullOrEmpty() ||
            !draftReferences[id].isNullOrEmpty() || draftReplies[id] != null) {
            throw SummonApiException("请先保存或清空输入框里的草稿，再恢复这条消息。")
        }
        val message = item.message
        drafts = drafts + (id to message.content); draftAttachments = draftAttachments + (id to message.attachments)
        draftMentions = draftMentions + (id to message.mentions); draftReferences = draftReferences + (id to message.references)
        message.replyTo?.let { draftReplies = draftReplies + (id to it) }
        pendingMessages = pendingMessages.filterNot { it.clientID == item.clientID }
        persistComposer()
    }

    private suspend fun deliver(id: String, queryFirst: Boolean) {
        val api = client ?: return
        val item = pendingMessages.firstOrNull { it.clientID == id } ?: return
        if (!protocolReady || item.status in listOf("sent", "rejected") || item.roomID in sendingRoomIDs) return
        val connection = connectionGeneration
        sendingRoomIDs = sendingRoomIDs + item.roomID
        updatePending(id) { it.copy(status = "sending", error = null) }
        var submittingMessage = false
        try {
            if (!persistComposer()) throw SummonApiException("本机发送记录无法保存。")
            val path = roomPath(item.roomID) + "/messages"
            var receipt: SummonReceipt? = null
            if (queryFirst) {
                try {
                    val result = withContext(Dispatchers.IO) { api.requestJson(path + "/receipt?clientId=" + SummonApiClient.component(id)) }
                    receipt = SummonReceipt.parse(result)
                } catch (error: SummonApiException) { if (error.status != 404) throw error }
            }
            if (receipt == null) {
                val message = item.message
                val uploaded = mutableListOf<SummonJson>()
                for (file in message.attachments) {
                    if (connection != connectionGeneration || !protocolReady) return
                    val prepared = withContext(Dispatchers.IO) { preparedAttachment(file, api) }
                    uploaded += SummonReference("file", prepared.id).toJson()
                }
                if (connection != connectionGeneration || !protocolReady) return
                val body = SummonJson.Obj(buildMap {
                    put("text", SummonJson.Str(message.content)); put("clientId", SummonJson.Str(id))
                    put("attachments", SummonJson.Arr(uploaded)); put("references", SummonJson.Arr(message.references.map(SummonReference::toJson)))
                    put("mentions", message.mentions.toJsonStrings())
                    message.replyTo?.let { put("reply_to", SummonReference("event", it).toJson()) }
                    message.promptResponse?.let { put("prompt_response", it) }
                })
                submittingMessage = true
                receipt = SummonReceipt.parse(withContext(Dispatchers.IO) { api.requestJson(path, "POST", body, id) })
            }
            if (connection != connectionGeneration) return
            val confirmed = receipt ?: throw SummonApiException.invalidReceipt
            val message = confirmed.message
            if (message.clientId != id || message.roomId != item.roomID || !message.isOwn || message.id.isEmpty()) throw SummonApiException.invalidReceipt
            deliveries = deliveries + (message.id to confirmed.deliveries)
            updatePending(id) { it.copy(message = message, status = "sent", error = null) }
            rooms = rooms.map { if (it.id == item.roomID) it.copy(lastMessage = message) else it }
            if (persistComposer()) item.message.attachments.forEach(::discardStagedAttachment)
            schedulePersistence()
            scheduleRefresh()
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (connection == connectionGeneration) {
                val rejected = submittingMessage && (error as? SummonApiException)?.status in listOf(400, 413, 415, 422)
                updatePending(id) { it.copy(status = if (rejected) "rejected" else "failed", error = error.localizedMessage) }
                persistComposer()
                if ((error as? SummonApiException)?.interruptsProtocol == true) handle(error)
            }
        } finally {
            if (connection == connectionGeneration) {
                sendingRoomIDs = sendingRoomIDs - item.roomID
                if (pendingMessages.any { it.clientID == id && it.status == "sending" }) {
                    updatePending(id) { it.copy(status = "failed", error = protocolNotice ?: "保存状态待确认。") }
                    persistComposer()
                }
            }
        }
    }

    suspend fun stageAttachment(uri: Uri): SummonAttachment = withContext(Dispatchers.IO) {
        val max = 20 * 1024 * 1024
        val data = app.contentResolver.openInputStream(uri)?.use { stream ->
            val buffer = ByteArray(8192)
            val output = java.io.ByteArrayOutputStream()
            while (true) {
                val count = stream.read(buffer)
                if (count < 0) break
                if (output.size() + count > max) throw SummonApiException.attachmentTooLarge
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        } ?: throw SummonApiException.missingAttachment
        val id = newID()
        val file = stagingFile(id) ?: throw SummonApiException.missingAttachment
        file.parentFile?.mkdirs()
        file.writeBytes(data)
        SummonAttachment(id, displayName(app, uri), mimeFor(app, uri), data.size, staged = true)
    }

    fun discardStagedAttachment(attachment: SummonAttachment) {
        if (attachment.staged) stagingFile(attachment.id)?.delete()
    }

    private fun stagingFile(id: String): File? =
        if (runCatching { UUID.fromString(id).toString() == id }.getOrDefault(false)) File(storageDirectory, "attachments/$id") else null

    private fun preparedAttachment(attachment: SummonAttachment, api: SummonApiClient): SummonAttachment {
        if (!attachment.staged) return attachment
        val file = stagingFile(attachment.id)?.takeIf(File::isFile) ?: throw SummonApiException.missingAttachment
        return api.upload(file.readBytes(), attachment.name, attachment.mimeType, attachment.id)
    }

    suspend fun attachmentFile(attachment: SummonAttachment): File {
        if (attachment.unavailable) throw SummonApiException.http(404, "附件不可用。")
        val api = apiClient()
        return withContext(Dispatchers.IO) { api.download(app, attachment.downloadPath, attachment.name) }
    }

    suspend fun attachmentPreview(attachment: SummonAttachment): ByteArray {
        val api = apiClient()
        return withContext(Dispatchers.IO) { api.bytes("/api/attachments/" + SummonApiClient.component(attachment.id) + "/preview") }
    }

    suspend fun downloadFile(id: String, name: String, revision: Int? = null): File {
        val api = apiClient()
        val query = if (revision != null && revision > 0) "?revision=$revision" else ""
        return withContext(Dispatchers.IO) { api.download(app, "/api/files/" + SummonApiClient.component(id) + "/download$query", name) }
    }

    suspend fun downloadWorkspaceFile(workspaceId: String, filePath: String): File {
        val api = apiClient()
        val name = filePath.substringAfterLast('/').ifBlank { "file" }
        val endpoint = "/api/workspaces/${SummonApiClient.component(workspaceId)}/file?path=${SummonApiClient.component(filePath)}"
        return withContext(Dispatchers.IO) { api.download(app, endpoint, name) }
    }

    suspend fun downloadRelativePath(relativePath: String, fallbackName: String = "download"): File {
        val api = apiClient()
        return withContext(Dispatchers.IO) { api.download(app, relativePath, fallbackName) }
    }

    suspend fun refreshModelUsage(force: Boolean = false): SummonJson =
        request("/api/model-settings/usage", "POST", SummonJson.obj("force" to SummonJson.Bool(force))).also { modelSummary = it }

    suspend fun request(path: String, method: String = "GET", body: SummonJson? = null, clientID: String? = null): SummonJson {
        val connection = connectionGeneration
        val api = apiClient()
        try {
            val result = withContext(Dispatchers.IO) { api.requestJson(path, method, body, clientID) }
            if (connection != connectionGeneration) throw CancellationException()
            return result
        } catch (error: SummonApiException) {
            if (connection == connectionGeneration && error.interruptsProtocol) handle(error)
            throw error
        }
    }

    suspend fun read(ref: SummonReference, cursor: String? = null): SummonJson {
        val path = ref.path
        if (path != null) return request(path + (cursor?.let { "?cursor=" + SummonApiClient.component(it) }).orEmpty())
        return request("/api/platform/read", "POST", SummonJson.obj("arguments" to SummonJson.obj("ref" to ref.toJson())))["result"]
    }

    suspend fun list(path: String): List<SummonJson> {
        val items = mutableListOf<SummonJson>()
        val visited = mutableSetOf<String>()
        var cursor: String? = null
        do {
            if (cursor != null && !visited.add(cursor)) break
            val endpoint = path + (cursor?.let { (if ("?" in path) "&" else "?") + "cursor=" + SummonApiClient.component(it) }).orEmpty()
            val page = request(endpoint)
            items += page["items"].array.orEmpty()
            cursor = page["next_cursor"].string
        } while (cursor != null)
        return items
    }

    private fun apiClient(): SummonApiClient {
        val api = client ?: throw SummonApiException.noConnection
        if (!protocolReady) throw SummonApiException(protocolNotice ?: "正在连接实例。")
        return api
    }

    private fun startStream() {
        val api = client ?: return
        if (streamJob != null) return
        val connection = connectionGeneration
        streamJob = scope.launch {
            var seconds = 1L
            while (isActive && foreground && connection == connectionGeneration) {
                val started = android.os.SystemClock.elapsedRealtime()
                try {
                    val current = SummonEventStream(api)
                    withContext(Dispatchers.IO) {
                        current.consume { event ->
                            withContext(Dispatchers.Main.immediate) {
                                if (connection == connectionGeneration && foreground) {
                                    isConnected = true
                                    if (event !is SummonStreamEvent.KeepAlive) scheduleRefresh()
                                }
                            }
                        }
                    }
                } catch (error: CancellationException) { throw error }
                catch (error: Exception) {
                    if (connection != connectionGeneration) return@launch
                    isConnected = false
                    if ((error as? SummonApiException)?.status == 401) {
                        protocolNotice = "账号会话已失效，请在设置中重新登录。"
                        return@launch
                    }
                    if ((error as? SummonApiException)?.interruptsProtocol == true) handle(error)
                    if (android.os.SystemClock.elapsedRealtime() - started >= 30_000) seconds = 1
                }
                delay(seconds * 1000)
                seconds = (seconds * 2).coerceAtMost(30)
            }
        }
    }

    private fun startRecovery() {
        if (recoveryJob != null) return
        recoveryJob = scope.launch {
            while (isActive && foreground) {
                delay(15_000)
                if (protocolReady) activeRoomID?.let { loadRoom(it) }
            }
        }
    }

    private fun scheduleRefresh() {
        if (!foreground || refreshJob != null) return
        refreshJob = scope.launch {
            delay(850)
            refreshJob = null
            refresh()
        }
    }

    private fun upsertRoom(room: SummonRoom) {
        val before = room(room.id)
        if (before == null) rooms = rooms + room
        else if ((room.revision ?: 0) >= (before.revision ?: 0)) rooms = rooms.map { if (it.id == room.id) room else it }
        schedulePersistence()
    }

    private fun upsertBot(bot: SummonBot) {
        if (this.bot(bot.id) == null) bots = bots + bot else bots = bots.map { if (it.id == bot.id) bot else it }
        schedulePersistence()
    }

    private fun updatePending(id: String, change: (SummonPendingMessage) -> SummonPendingMessage) {
        pendingMessages = pendingMessages.map { if (it.clientID == id) change(it) else it }
    }

    private fun clearServerState() {
        bots = emptyList(); rooms = emptyList(); archivedRooms = emptyList(); messageHistory = emptyMap(); deliveries = emptyMap(); messageSummaries = emptyMap(); cursors = emptyMap(); roomExecutions = emptyMap()
        roomActivities = emptyMap(); roomSuspendedRuns = emptyMap(); roomMessageStates = emptyMap()
        pendingMessages = emptyList(); drafts = emptyMap(); draftAttachments = emptyMap(); draftMentions = emptyMap()
        draftReplies = emptyMap(); draftReferences = emptyMap(); activeRoomID = null; historyEpoch = null; lastSyncAt = null
        modelSummary = SummonJson.Null
    }

    private fun snapshotFile(): File? {
        if (settings.baseURL.isEmpty()) return null
        val key = android.util.Base64.encodeToString(settings.baseURL.toByteArray(), android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE)
        val directory = key.chunked(120).fold(File(storageDirectory, "instances")) { root, part -> File(root, part) }
        return File(directory, "snapshot.json")
    }

    private fun restoreSnapshot() {
        val current = snapshotFile() ?: return
        val composerFile = File(current.parentFile, "composer.json")
        val cached = readLocal(current)
        if (cached != null) {
            loadSnapshot(cached)
            readLocal(composerFile)?.let(::loadComposer)
            return
        }

        val candidates = sequenceOf(File(storageDirectory, "workspace.json")) +
            File(storageDirectory, "workspaces").walkTopDown()
                .filter { it.isFile && it.name in setOf("snapshot.json", "composer.json") }
        val records = candidates.mapNotNull { path -> readLocal(path)?.let { path to it } }
            .sortedBy { it.first.lastModified() }.toList()
        val snapshots = records.filter { it.first.name != "composer.json" && it.second["rooms"].array != null }
            .sortedBy { snapshotTime(it.second) ?: it.first.lastModified() }
        val epoch = snapshots.lastOrNull()?.second?.get("historyEpoch")?.string
        snapshots.filter { it.second["historyEpoch"].string == epoch }.forEach { loadSnapshot(it.second) }
        val composerDirectories = records.filter { it.first.name == "composer.json" }.map { it.first.parent }.toSet()
        records.filter { it.first.name == "composer.json" || it.first.parent !in composerDirectories }
            .forEach { loadComposer(it.second) }
        readLocal(composerFile)?.let(::loadComposer)
        if (records.isNotEmpty() && persistNow()) records.forEach { (path, _) -> path.delete() }
    }

    private fun snapshotTime(snapshot: SummonJson): Long? =
        (snapshot["savedAt"] as? SummonJson.Num)?.value?.toLong()
            ?: parseSummonDate(snapshot["savedAt"].string)?.toEpochMilli()

    private fun loadSnapshot(snapshot: SummonJson) {
        historyEpoch = snapshot["historyEpoch"].string
        bots = (bots + snapshot["bots"].array.orEmpty().map(SummonBot::parse)).associateBy { it.id }.values.toList()
        rooms = (rooms + snapshot["rooms"].array.orEmpty().map { SummonRoom.parse(it, stored = true) }).associateBy { it.id }.values.toList()
        messageHistory = messageHistory + snapshot["messageHistory"].obj.orEmpty().mapValues { (_, list) ->
            list.array.orEmpty().map { SummonMessage.parse(it, stored = true) }
        }
        messageSummaries = messageSummaries + snapshot["summaries"].obj.orEmpty().mapValues { SummonMessageSummary.list(it.value) }
        lastSyncAt = snapshotTime(snapshot)
    }

    private fun loadComposer(saved: SummonJson) {
        val messages = saved["pendingMessages"].array.orEmpty().map(SummonPendingMessage::parse).map {
            if (it.status in listOf("sending", "queued")) it.copy(status = "failed", error = "上次发送的保存状态待确认。") else it
        }
        pendingMessages = (pendingMessages + messages).associateBy { it.roomID to it.clientID }.values.toList()
        drafts = drafts + saved["drafts"].obj.orEmpty().mapValues { it.value.stringValue }
        draftAttachments = draftAttachments + saved["draftAttachments"].obj.orEmpty().mapValues { it.value.array.orEmpty().map(SummonAttachment::parse) }
        val mentions = saved["draftMentions"].obj?.mapValues { it.value.array.orEmpty().mapNotNull { entry -> entry.string } }
            ?: saved["draftTargets"].obj.orEmpty().mapValues { listOfNotNull(it.value.string) }
        draftMentions = draftMentions + mentions
        draftReferences = draftReferences + saved["draftReferences"].obj.orEmpty().mapValues { it.value.array.orEmpty().mapNotNull(SummonReference::parse) }
        draftReplies = draftReplies + saved["draftReplies"].obj.orEmpty().mapValues { it.value.stringValue }
    }

    private fun readLocal(source: File): SummonJson? =
        runCatching { SummonJson.parse(AtomicFile(source).readFully().toString(Charsets.UTF_8)) }.getOrNull()
            ?.takeIf { it["endpoint"].string == settings.baseURL }

    private fun schedulePersistence() {
        persistenceJob?.cancel()
        persistenceJob = scope.launch {
            delay(220)
            persistenceJob = null
            persistNow()
        }
    }

    private fun persistNow(): Boolean {
        persistenceJob?.cancel(); persistenceJob = null
        val target = snapshotFile() ?: return false
        if (!persistComposer()) return false
        val trimmedHistory = messageHistory.mapValues { it.value.takeLast(100) }
        val keptMessageIDs = trimmedHistory.values.flatten().mapTo(mutableSetOf(), SummonMessage::id)
        val cachedMessages = trimmedHistory.mapValues { SummonJson.Arr(it.value.map(SummonMessage::toJson)) }
        val cachedSummaries = messageSummaries.filterKeys { it in keptMessageIDs }
            .mapValues { SummonJson.Arr(it.value.map(SummonMessageSummary::toJson)) }
        val snapshot = SummonJson.obj(
            "endpoint" to SummonJson.Str(settings.baseURL), "historyEpoch" to historyEpoch.strOrNull(),
            "bots" to SummonJson.Arr(bots.map(SummonBot::toJson)), "rooms" to SummonJson.Arr(rooms.map(SummonRoom::toJson)),
            "messageHistory" to SummonJson.Obj(cachedMessages),
            "summaries" to SummonJson.Obj(cachedSummaries),
            "savedAt" to SummonJson.Num((lastSyncAt ?: System.currentTimeMillis()).toDouble()),
        )
        return writeLocal(target, snapshot, "无法更新本机聊天缓存")
    }

    private fun persistComposer(): Boolean {
        val target = snapshotFile() ?: return false
        val composer = SummonJson.obj(
            "endpoint" to SummonJson.Str(settings.baseURL),
            "pendingMessages" to SummonJson.Arr(pendingMessages.map(SummonPendingMessage::toJson)),
            "drafts" to SummonJson.Obj(drafts.mapValues { SummonJson.Str(it.value) }),
            "draftAttachments" to SummonJson.Obj(draftAttachments.mapValues { SummonJson.Arr(it.value.map(SummonAttachment::toJson)) }),
            "draftMentions" to SummonJson.Obj(draftMentions.mapValues { it.value.toJsonStrings() }),
            "draftReplies" to SummonJson.Obj(draftReplies.mapValues { SummonJson.Str(it.value) }),
            "draftReferences" to SummonJson.Obj(draftReferences.mapValues { SummonJson.Arr(it.value.map(SummonReference::toJson)) }),
        )
        return writeLocal(File(target.parentFile, "composer.json"), composer, "无法保存本机草稿和发送记录")
    }

    private fun writeLocal(target: File, value: SummonJson, errorPrefix: String): Boolean {
        val file = AtomicFile(target)
        return try {
            target.parentFile?.mkdirs()
            val stream = file.startWrite()
            try { stream.write(value.bytes()); file.finishWrite(stream) }
            catch (error: Exception) { file.failWrite(stream); throw error }
            true
        } catch (error: Exception) {
            errorMessage = "$errorPrefix：" + error.localizedMessage
            false
        }
    }

    companion object {
        private const val SETTINGS_KEY = "SummonNative.connection.v1"
        fun newID(): String = UUID.randomUUID().toString()
        private fun roomPath(id: String): String = "/api/rooms/" + SummonApiClient.component(id)
    }
}
