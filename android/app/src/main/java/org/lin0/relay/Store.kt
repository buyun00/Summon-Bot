package org.lin0.relay

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.UUID

class SummonStore(private val app: Context) {
    var settings by mutableStateOf(SummonConnectionSettings(baseURL = DEFAULT_URL))
        private set
    var bots by mutableStateOf<List<SummonBot>>(emptyList())
        private set
    var rooms by mutableStateOf<List<SummonRoom>>(emptyList())
        private set
    var messages by mutableStateOf<List<SummonMessage>>(emptyList())
        private set
    var jobs by mutableStateOf<List<SummonJob>>(emptyList())
        private set
    var agentRuns by mutableStateOf<List<SummonAgentRun>>(emptyList())
        private set
    var agentRunDetails by mutableStateOf<Map<String, SummonAgentRun>>(emptyMap())
        private set
    var pendingMessages by mutableStateOf<List<SummonPendingMessage>>(emptyList())
        private set
    var drafts by mutableStateOf<Map<String, String>>(emptyMap())
        private set
    var draftAttachments by mutableStateOf<Map<String, List<SummonAttachment>>>(emptyMap())
        private set
    var draftTargets by mutableStateOf<Map<String, String>>(emptyMap())
        private set
    var draftReplies by mutableStateOf<Map<String, String>>(emptyMap())
        private set
    var selectedRoomID by mutableStateOf<String?>(null)
        private set
    var isLoading by mutableStateOf(false)
        private set
    var isRefreshing by mutableStateOf(false)
        private set
    var isConnected by mutableStateOf(false)
        private set
    var sendingRoomIDs by mutableStateOf<Set<String>>(emptySet())
        private set
    var lastSyncAt by mutableStateOf<Long?>(null)
        private set
    var errorMessage by mutableStateOf<String?>(null)

    private var messageHistory by mutableStateOf<Map<String, List<SummonMessage>>>(emptyMap())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var client: SummonApiClient? = null
    private var streamJob: Job? = null
    private var refreshJob: Job? = null
    private var roomRefreshJob: Job? = null
    private var roomRecoveryJob: Job? = null
    private var persistenceJob: Job? = null
    private val roomJobs = mutableMapOf<String, Job>()
    private val runDetailJobs = mutableMapOf<String, Job>()
    private val runDetailTokens = mutableMapOf<String, String>()
    private val runDetailLastRequested = mutableMapOf<String, Long>()
    private var runDetailGeneration = 0
    private var connectionGeneration = 0
    private var historyGeneration = 0
    private val roomReadGeneration = mutableMapOf<String, Int>()
    private val roomLoadsInFlight = mutableSetOf<String>()
    private val roomsNeedingReload = mutableSetOf<String>()
    private val roomLastRead = mutableMapOf<String, Long>()
    private var workspaceLastRequested = 0L
    private var activeRoomID: String? = null
    private var isForeground = false
    private var historyEpoch: String? = null
    private var hasSnapshot = false
    private var refreshAgain = false
    private var roomRefreshAgain = false
    private var roomRefreshGeneration = 0
    private var startingConnection: Int? = null
    private val prefs = app.getSharedPreferences(SETTINGS_KEY, Context.MODE_PRIVATE)
    private val cacheFile = File(File(app.filesDir, "RelayNative").apply { mkdirs() }, "workspace.json")
    private val ioMutex = Mutex()

    val isConfigured: Boolean get() = client != null
    val savedToken: String get() = SummonKeystore.token(app, settings.baseURL)
    val selectedRoom: SummonRoom? get() = rooms.firstOrNull { it.id == selectedRoomID }

    init {
        prefs.getString(SETTINGS_KEY, null)?.let { raw ->
            runCatching { settings = SummonConnectionSettings.parse(SummonJson.parse(raw)) }
        }
        runCatching { SummonApiClient.normalized(settings.baseURL) }.getOrNull()?.let { url ->
            client = SummonApiClient(url, SummonKeystore.token(app, settings.baseURL))
        }
        restoreSnapshot()
    }

    fun dispose() {
        disconnect()
        scope.coroutineContext[Job]?.cancel()
    }

    suspend fun start() {
        if (client == null || startingConnection == connectionGeneration) return
        isForeground = true
        val connection = connectionGeneration
        startingConnection = connection
        try {
            startStream()
            startRoomRecovery()
            refresh()
        } finally {
            if (startingConnection == connection) startingConnection = null
        }
    }

    suspend fun reconnect() {
        if (startingConnection == connectionGeneration) return
        disconnect()
        runCatching { SummonApiClient.normalized(settings.baseURL) }.getOrNull()?.let { url ->
            client = SummonApiClient(url, savedToken)
        }
        start()
    }

    fun disconnect() {
        connectionGeneration += 1
        isForeground = false
        startingConnection = null
        streamJob?.cancel(); streamJob = null
        refreshJob?.cancel(); refreshJob = null
        roomRefreshJob?.cancel(); roomRefreshJob = null
        roomRefreshGeneration += 1
        roomRecoveryJob?.cancel(); roomRecoveryJob = null
        roomJobs.values.forEach { it.cancel() }
        roomJobs.clear()
        cancelRunDetailRefreshes()
        roomLoadsInFlight.clear()
        roomsNeedingReload.clear()
        isConnected = false
        isRefreshing = false
        isLoading = false
        refreshAgain = false
        roomRefreshAgain = false
        pendingMessages = pendingMessages.map { item ->
            if (item.status == "sending") item.copy(status = "failed", error = "连接已暂停，送达状态待确认。请刷新后手动重试。") else item
        }
        sendingRoomIDs = emptySet()
        persistNow()
    }

    suspend fun saveConnection(baseURL: String, token: String, userName: String? = null) {
        val url = SummonApiClient.normalized(baseURL)
        val endpoint = url.toString()
        SummonKeystore.save(app, token.trim(), endpoint)
        val changed = endpoint != settings.baseURL
        disconnect()
        val name = userName?.trim()?.ifBlank { null } ?: settings.userName
        settings = SummonConnectionSettings(endpoint, name.ifBlank { "你" })
        if (changed) clearWorkspace()
        client = SummonApiClient(url, SummonKeystore.token(app, endpoint))
        prefs.edit().putString(SETTINGS_KEY, settings.toJson().encode().toString()).apply()
        errorMessage = null
        persistNow()
        start()
        errorMessage?.let { throw SummonApiException.http(0, it) }
    }

    fun setUserName(name: String) {
        settings = settings.copy(userName = name.trim().ifBlank { "你" })
        prefs.edit().putString(SETTINGS_KEY, settings.toJson().encode().toString()).apply()
    }

    suspend fun refresh() {
        val api = client ?: return
        scheduleRoomRefresh()
        if (isRefreshing) {
            refreshAgain = true
            return
        }
        val connection = connectionGeneration
        workspaceLastRequested = SystemClock.elapsedRealtime()
        isRefreshing = true
        isLoading = !hasSnapshot
        try {
            val snapshot = withContext(Dispatchers.IO) { SummonWorkspace.parse(api.requestJson("/api/state")) }
            if (connection != connectionGeneration) return
            acceptEpoch(snapshot.historyEpoch)
            bots = snapshot.bots
            rooms = snapshot.rooms.map { room ->
                val latest = messageHistory[room.id]?.lastOrNull()
                if (latest != null && (latest.createdAt ?: "") > (room.lastMessage?.createdAt ?: "")) room.copy(lastMessage = latest) else room
            }
            agentRuns = snapshot.agentRuns
            hasSnapshot = true
            lastSyncAt = System.currentTimeMillis()
            errorMessage = null
            val selected = selectedRoomID
            if (selected != null && rooms.none { it.id == selected }) {
                selectedRoomID = null
                messages = emptyList()
                jobs = emptyList()
                if (activeRoomID == selected) deactivateRoom(selected)
            }
            scheduleRoomRefresh()
            schedulePersistence()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (connection == connectionGeneration) errorMessage = error.message
        } finally {
            if (connection == connectionGeneration) {
                isRefreshing = false
                isLoading = false
                if (refreshAgain) {
                    refreshAgain = false
                    scheduleRefresh()
                }
            }
        }
    }

    suspend fun selectRoom(id: String) {
        if (activeRoomID != id) cancelRunDetailRefreshes()
        selectedRoomID = id
        activeRoomID = id
        roomRefreshJob?.cancel(); roomRefreshJob = null
        roomRefreshAgain = false
        roomRefreshGeneration += 1
        messages = messagesForRoom(id)
        jobs = emptyList()
        schedulePersistence()
        startRoomRecovery()
        val api = client ?: return
        loadRoom(id, api, connectionGeneration)
    }

    fun ensureRoomActive(id: String) {
        if (activeRoomID == id) return
        cancelRunDetailRefreshes()
        roomRefreshJob?.cancel(); roomRefreshJob = null
        roomRefreshAgain = false
        roomRefreshGeneration += 1
        activeRoomID = id
        if (selectedRoomID != id) {
            selectedRoomID = id
            messages = messagesForRoom(id)
            jobs = emptyList()
            schedulePersistence()
        }
        startRoomRecovery()
        scheduleRoomRefresh(id)
    }

    fun deactivateRoom(id: String) {
        if (activeRoomID != id) return
        activeRoomID = null
        roomRefreshJob?.cancel(); roomRefreshJob = null
        roomRefreshAgain = false
        roomRefreshGeneration += 1
        roomRecoveryJob?.cancel(); roomRecoveryJob = null
        roomJobs[id]?.cancel()
        roomsNeedingReload.remove(id)
        cancelRunDetailRefreshes()
    }

    fun messagesForRoom(id: String): List<SummonMessage> {
        val remote = messageHistory[id].orEmpty()
        val confirmed = remote.filter { it.senderId == "user" }.mapNotNull { it.clientId }.toSet()
        return remote + pendingMessages.filter { it.roomID == id && it.clientID !in confirmed }.map { it.message }
    }

    fun bot(id: String): SummonBot? = bots.firstOrNull { it.id == id }
    fun room(id: String): SummonRoom? = rooms.firstOrNull { it.id == id }
    fun name(id: String): String = when (id) {
        "user" -> settings.userName
        "system" -> bot(id)?.name ?: "Summon Bot"
        else -> bot(id)?.name ?: id
    }

    suspend fun openDirectMessage(bot: SummonBot): SummonRoom {
        rooms.firstOrNull { it.kind == "dm" && it.members.contains("user") && it.members.contains(bot.id) && it.members.size == 2 }?.let { room ->
            selectRoom(room.id)
            return room
        }
        val room = createGroup("与 ${bot.name} 的私聊", listOf("user", bot.id), kind = "dm")
        selectRoom(room.id)
        return room
    }

    suspend fun createBot(name: String, avatar: SummonAvatar, role: String = "项目协作", expertise: String = "", prompt: String = ""): SummonBot {
        val connection = connectionGeneration
        val result = withContext(Dispatchers.IO) {
            SummonBot.parse(apiClient().requestJson("/api/bots", "POST", SummonJson.obj(
                "id" to SummonJson.Str("bot-${UUID.randomUUID().toString().lowercase()}"),
                "name" to SummonJson.Str(name),
                "role" to SummonJson.Str(role),
                "expertise" to SummonJson.Str(expertise),
                "prompt" to SummonJson.Str(prompt),
                "avatar" to avatar.toJson(),
            )))
        }
        if (connection == connectionGeneration) {
            upsertBot(result)
            schedulePersistence()
        }
        return result
    }

    suspend fun updateBot(id: String, name: String? = null, role: String? = null, expertise: String? = null, prompt: String? = null, status: String? = null, avatar: SummonAvatar? = null): SummonBot {
        val connection = connectionGeneration
        val body = buildMap<String, SummonJson> {
            listOf("name" to name, "role" to role, "expertise" to expertise, "prompt" to prompt, "status" to status).forEach { (key, value) ->
                if (value != null) put(key, SummonJson.Str(value))
            }
            if (avatar != null) put("avatar", avatar.toJson())
        }
        val result = withContext(Dispatchers.IO) {
            SummonBot.parse(apiClient().requestJson("/api/bots/${SummonApiClient.component(id)}", "PATCH", SummonJson.Obj(body)))
        }
        if (connection == connectionGeneration) {
            upsertBot(result)
            schedulePersistence()
        }
        return result
    }

    suspend fun createGroup(name: String, members: List<String>, goal: String = "", kind: String = "group"): SummonRoom {
        val connection = connectionGeneration
        val result = withContext(Dispatchers.IO) {
            SummonRoom.parse(apiClient().requestJson("/api/rooms", "POST", SummonJson.obj(
                "name" to SummonJson.Str(name),
                "kind" to SummonJson.Str(kind),
                "goal" to SummonJson.Str(goal),
                "members" to SummonJson.Arr(members.map(SummonJson::Str)),
            )))
        }
        if (connection == connectionGeneration) {
            upsertRoom(result)
            schedulePersistence()
        }
        return result
    }

    suspend fun updateRoom(id: String, name: String, members: List<String>, goal: String = ""): SummonRoom {
        val connection = connectionGeneration
        val result = withContext(Dispatchers.IO) {
            SummonRoom.parse(apiClient().requestJson("/api/rooms/${SummonApiClient.component(id)}", "PATCH", SummonJson.obj(
                "name" to SummonJson.Str(name),
                "members" to SummonJson.Arr(members.map(SummonJson::Str)),
                "goal" to SummonJson.Str(goal),
            )))
        }
        if (connection == connectionGeneration) {
            upsertRoom(result)
            schedulePersistence()
        }
        return result
    }

    fun draft(id: String): String = drafts[id].orEmpty()
    fun setDraft(value: String, id: String) { drafts = drafts + (id to value); schedulePersistence() }
    fun setDraftAttachments(value: List<SummonAttachment>, id: String) { draftAttachments = draftAttachments + (id to value.take(8)); schedulePersistence() }
    fun setDraftTarget(value: String?, id: String) {
        draftTargets = if (value == null) draftTargets - id else draftTargets + (id to value)
        schedulePersistence()
    }
    fun setDraftReply(value: String?, id: String) {
        draftReplies = if (value == null) draftReplies - id else draftReplies + (id to value)
        schedulePersistence()
    }

    suspend fun sendMessage(roomID: String, content: String, attachments: List<SummonAttachment> = emptyList(), toBotID: String? = null, replyTo: String? = null) {
        if (roomID in sendingRoomIDs) return
        val text = content.trim()
        if (text.isEmpty() && attachments.isEmpty()) { errorMessage = SummonApiException.emptyMessage.message; return }
        if (attachments.size > 8) { errorMessage = SummonApiException.tooManyAttachments.message; return }
        if (client == null) { errorMessage = SummonApiException.noConnection.message; return }
        val id = UUID.randomUUID().toString().lowercase()
        val message = SummonMessage(
            id = "local-$id", roomId = roomID, senderId = "user", content = text, attachments = attachments,
            replyTo = replyTo, toBotId = toBotID, clientId = id,
            createdAt = DateTimeFormatter.ISO_INSTANT.format(Instant.now()),
        )
        pendingMessages = pendingMessages + SummonPendingMessage(id, message, "sending")
        drafts = drafts + (roomID to "")
        draftAttachments = draftAttachments + (roomID to emptyList())
        draftTargets = draftTargets - roomID
        draftReplies = draftReplies - roomID
        updateVisibleMessages(roomID)
        persistNow()
        deliver(id)
    }

    suspend fun retryMessage(clientID: String) {
        val pending = pendingMessages.firstOrNull { it.clientID == clientID } ?: return
        if (pending.status != "failed") return
        deliver(clientID)
    }

    suspend fun cancelRun(id: String) {
        withContext(Dispatchers.IO) { apiClient().requestJson("/api/agent-runs/${SummonApiClient.component(id)}/cancel", "POST", SummonJson.Obj(emptyMap())) }
        refresh()
    }

    suspend fun uploadAttachment(uri: Uri): SummonAttachment = withContext(Dispatchers.IO) {
        val resolver = app.contentResolver
        val length = resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1
        if (length > 20L * 1024 * 1024) throw SummonApiException.attachmentTooLarge
        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: throw SummonApiException.invalidResponse
        if (bytes.size > 20 * 1024 * 1024) throw SummonApiException.attachmentTooLarge
        apiClient().upload(bytes, displayName(app, uri), mimeFor(app, uri))
    }

    suspend fun uploadAttachment(data: ByteArray, name: String, mimeType: String): SummonAttachment =
        withContext(Dispatchers.IO) { apiClient().upload(data, name, mimeType) }

    suspend fun attachmentFile(attachment: SummonAttachment): File = withContext(Dispatchers.IO) {
        apiClient().download(app, "/api/attachments/${SummonApiClient.component(attachment.id)}", attachment.name)
    }

    suspend fun attachmentPreview(attachment: SummonAttachment): ByteArray = withContext(Dispatchers.IO) {
        apiClient().bytes("/api/attachments/${SummonApiClient.component(attachment.id)}/preview")
    }

    suspend fun artifactFile(artifact: SummonArtifact, runID: String, toolID: String): File = withContext(Dispatchers.IO) {
        val component = SummonApiClient::component
        apiClient().download(app, "/api/agent-runs/${component(runID)}/tools/${component(toolID)}/artifacts/${component(artifact.id)}", artifact.name ?: "产物")
    }

    suspend fun request(path: String, method: String = "GET", body: SummonJson? = null): SummonJson =
        withContext(Dispatchers.IO) { apiClient().requestJson(path, method, body) }

    private fun apiClient(): SummonApiClient = client ?: throw SummonApiException.noConnection

    private suspend fun deliver(clientID: String) {
        val api = client ?: return
        val item = pendingMessages.firstOrNull { it.clientID == clientID } ?: return
        if (item.roomID in sendingRoomIDs) return
        val connection = connectionGeneration
        val history = historyGeneration
        sendingRoomIDs = sendingRoomIDs + item.roomID
        updatePending(clientID) { it.copy(status = "sending", error = null) }
        persistNow()
        try {
            val message = item.message
            val body = buildMap {
                put("content", SummonJson.Str(message.content))
                put("clientId", SummonJson.Str(clientID))
                put("attachments", SummonJson.Arr(message.attachments.map { SummonJson.obj("id" to SummonJson.Str(it.id)) }))
                message.toBotId?.let { put("toBotId", SummonJson.Str(it)) }
                message.replyTo?.let { put("replyTo", SummonJson.Str(it)) }
            }
            val sent = withContext(Dispatchers.IO) {
                SummonMessage.parse(api.requestJson("/api/rooms/${SummonApiClient.component(item.roomID)}/messages", "POST", SummonJson.Obj(body)))
            }
            if (connection != connectionGeneration || history != historyGeneration) return
            if (sent.clientId != clientID || sent.roomId != item.roomID || sent.id.isEmpty()) throw SummonApiException.invalidReceipt
            updatePending(clientID) { it.copy(message = sent, status = "sent", error = null) }
            rooms = rooms.map { room -> if (room.id == item.roomID) room.copy(lastMessage = sent) else room }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (connection != connectionGeneration || history != historyGeneration) return
            if (messageHistory[item.roomID].orEmpty().any { it.clientId == clientID && it.senderId == "user" }) return
            updatePending(clientID) { it.copy(status = "failed", error = error.message) }
            errorMessage = "消息尚未确认送达，可在消息旁手动重试。"
        } finally {
            if (connection == connectionGeneration && history == historyGeneration) {
                sendingRoomIDs = sendingRoomIDs - item.roomID
                updateVisibleMessages(item.roomID)
                schedulePersistence()
                scheduleRoomRefresh(item.roomID)
                scheduleRefresh()
            }
        }
    }

    private suspend fun loadRoom(id: String, api: SummonApiClient, connection: Int) {
        if (!isForeground || connection != connectionGeneration) return
        if (id in roomLoadsInFlight) {
            roomsNeedingReload.add(id)
            return
        }
        roomLoadsInFlight.add(id)
        val read = (roomReadGeneration[id] ?: 0) + 1
        roomReadGeneration[id] = read
        val history = historyGeneration
        val job = scope.launch { }
        roomJobs[id] = job
        try {
            val snapshot = withContext(Dispatchers.IO) {
                SummonRoomSnapshot.parse(api.requestJson("/api/rooms/${SummonApiClient.component(id)}/messages"))
            }
            if (connection != connectionGeneration || history != historyGeneration || roomReadGeneration[id] != read) return
            if (hasSnapshot && snapshot.historyEpoch != historyEpoch) {
                scheduleRefresh()
                return
            }
            upsertRoom(snapshot.room.copy(lastMessage = snapshot.messages.lastOrNull()))
            messageHistory = messageHistory + (id to snapshot.messages)
            val confirmed = snapshot.messages.filter { it.senderId == "user" }.mapNotNull { it.clientId }.toSet()
            pendingMessages = pendingMessages.filterNot { it.roomID == id && it.clientID in confirmed }
            val replied = snapshot.messages.mapNotNull { it.jobId }.toSet()
            if (selectedRoomID == id) {
                messages = messagesForRoom(id)
                jobs = snapshot.jobs
            }
            scheduleActiveRunDetails(id, snapshot.jobs, replied)
            lastSyncAt = System.currentTimeMillis()
            roomLastRead[id] = SystemClock.elapsedRealtime()
            schedulePersistence()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (connection == connectionGeneration && activeRoomID == id) errorMessage = error.message
        } finally {
            if (connection == connectionGeneration) {
                roomJobs.remove(id)
                roomLoadsInFlight.remove(id)
                if (roomsNeedingReload.remove(id)) {
                    if (roomRefreshJob != null) roomRefreshAgain = true else scheduleRoomRefresh(id)
                }
            }
        }
    }

    private fun startStream() {
        if (!isForeground || streamJob != null || client == null) return
        val api = client ?: return
        val connection = connectionGeneration
        streamJob = scope.launch {
            var delaySec = 1L
            while (isActive) {
                val started = SystemClock.elapsedRealtime()
                try {
                    SummonEventStream(api).consume { event ->
                        withContext(Dispatchers.Main.immediate) { receiveStream(event, connection) }
                    }
                    delaySec = 1
                } catch (error: CancellationException) {
                    return@launch
                } catch (_: Exception) {
                    if (connection != connectionGeneration) return@launch
                    isConnected = false
                    if (SystemClock.elapsedRealtime() - started >= 30_000) delaySec = 1
                    scheduleRoomRefresh()
                    delay(delaySec * 1000)
                    delaySec = minOf(delaySec * 2, 30)
                }
            }
        }
    }

    private fun receiveStream(event: SummonStreamEvent, connection: Int) {
        if (!isForeground || connection != connectionGeneration) return
        isConnected = true
        when (event) {
            SummonStreamEvent.Connected -> {
                scheduleRoomRefresh()
                scheduleRefresh()
            }
            SummonStreamEvent.KeepAlive -> Unit
            is SummonStreamEvent.Change -> {
                val active = activeRoomID?.let { id -> rooms.firstOrNull { it.id == id } }
                val concerns = when {
                    event.roomID != null -> event.roomID == activeRoomID
                    event.botID != null -> active?.members?.contains(event.botID) == true
                    else -> event.type == null || event.type == "change" || event.type == "state"
                }
                if (concerns) scheduleRoomRefresh()
                if (event.type != "connected") scheduleRefresh()
            }
        }
    }

    private fun scheduleRefresh() {
        if (!isForeground || client == null || refreshJob != null) return
        val connection = connectionGeneration
        val elapsed = SystemClock.elapsedRealtime() - workspaceLastRequested
        val delayMs = maxOf(300L, 5_000L - elapsed)
        refreshJob = scope.launch {
            delay(delayMs)
            if (connection != connectionGeneration) return@launch
            refreshJob = null
            refresh()
        }
    }

    private fun scheduleRoomRefresh(id: String? = null) {
        val active = activeRoomID ?: return
        val api = client ?: return
        if (!isForeground || (id != null && id != active)) return
        if (roomRefreshJob != null) {
            if (active in roomLoadsInFlight) roomRefreshAgain = true
            return
        }
        val connection = connectionGeneration
        roomRefreshGeneration += 1
        val generation = roomRefreshGeneration
        roomRefreshJob = scope.launch {
            delay(180)
            try {
                if (!isForeground || connection != connectionGeneration || generation != roomRefreshGeneration || active != activeRoomID) return@launch
                loadRoom(active, api, connection)
            } finally {
                if (connection == connectionGeneration && generation == roomRefreshGeneration) {
                    roomRefreshJob = null
                    if (roomRefreshAgain) {
                        roomRefreshAgain = false
                        scheduleRoomRefresh()
                    }
                }
            }
        }
    }

    private fun startRoomRecovery() {
        if (!isForeground || activeRoomID == null || roomRecoveryJob != null) return
        val connection = connectionGeneration
        roomRecoveryJob = scope.launch {
            while (isActive) {
                delay(5_000)
                if (!isForeground || connection != connectionGeneration) return@launch
                val id = activeRoomID ?: return@launch
                val api = client ?: return@launch
                val interval = if (!isConnected || jobs.any { it.isActive }) 5_000L else 15_000L
                val last = roomLastRead[id]
                if (last != null && SystemClock.elapsedRealtime() - last < interval) continue
                loadRoom(id, api, connection)
            }
        }
    }

    private fun scheduleActiveRunDetails(roomID: String, roomJobs: List<SummonJob>, repliedJobIDs: Set<String>) {
        if (!isForeground || activeRoomID != roomID || client == null) return
        val api = client ?: return
        val settled = roomJobs.filter { !it.isActive || it.id in repliedJobIDs }
        val settledIDs = settled.flatMap { listOfNotNull(it.taskId, it.agentRunId) }.toSet()
        val wanted = roomJobs.filter { it.isActive && it.id !in repliedJobIDs }.mapNotNull { it.agentRunId ?: it.taskId }.toMutableSet()
        agentRuns.filter { it.roomId == roomID && it.isActive && it.id !in settledIDs }.forEach { wanted += it.id }
        runDetailJobs.keys.filter { it !in wanted }.forEach { id ->
            runDetailJobs.remove(id)?.cancel()
            runDetailTokens.remove(id)
        }
        val connection = connectionGeneration
        val generation = runDetailGeneration
        val now = SystemClock.elapsedRealtime()
        for (id in wanted) {
            if (runDetailJobs[id] != null) continue
            val previous = runDetailLastRequested[id]
            if (previous != null && now - previous < 5_000) continue
            runDetailLastRequested[id] = now
            val token = UUID.randomUUID().toString()
            runDetailTokens[id] = token
            runDetailJobs[id] = scope.launch {
                try {
                    val detail = withContext(Dispatchers.IO) {
                        SummonAgentRun.parse(api.requestJson("/api/agent-runs/${SummonApiClient.component(id)}"))
                    }
                    if (!isForeground || activeRoomID != roomID || connection != connectionGeneration || generation != runDetailGeneration || runDetailTokens[id] != token) return@launch
                    agentRunDetails = agentRunDetails + (id to detail)
                } catch (_: CancellationException) {
                    throw CancellationException()
                } catch (_: Exception) {
                } finally {
                    if (connection == connectionGeneration && generation == runDetailGeneration && runDetailTokens[id] == token) {
                        runDetailJobs.remove(id)
                        runDetailTokens.remove(id)
                    }
                }
            }
        }
    }

    private fun cancelRunDetailRefreshes() {
        runDetailGeneration += 1
        runDetailJobs.values.forEach { it.cancel() }
        runDetailJobs.clear()
        runDetailTokens.clear()
    }

    private fun acceptEpoch(epoch: String?) {
        if (hasSnapshot && historyEpoch != epoch) {
            historyGeneration += 1
            messageHistory = emptyMap()
            messages = emptyList()
            jobs = emptyList()
            pendingMessages = emptyList()
            drafts = emptyMap()
            draftAttachments = emptyMap()
            draftTargets = emptyMap()
            draftReplies = emptyMap()
            sendingRoomIDs = emptySet()
            agentRunDetails = emptyMap()
            cancelRunDetailRefreshes()
            runDetailLastRequested.clear()
        }
        historyEpoch = epoch
    }

    private fun clearWorkspace() {
        historyGeneration += 1
        hasSnapshot = false
        historyEpoch = null
        bots = emptyList(); rooms = emptyList(); messages = emptyList(); jobs = emptyList()
        agentRuns = emptyList(); agentRunDetails = emptyMap(); messageHistory = emptyMap()
        pendingMessages = emptyList(); drafts = emptyMap(); draftAttachments = emptyMap()
        draftTargets = emptyMap(); draftReplies = emptyMap(); selectedRoomID = null
        sendingRoomIDs = emptySet(); lastSyncAt = null; activeRoomID = null
        roomLastRead.clear(); runDetailLastRequested.clear()
    }

    private fun upsertBot(bot: SummonBot) {
        bots = if (bots.any { it.id == bot.id }) bots.map { if (it.id == bot.id) bot else it } else bots + bot
    }

    private fun upsertRoom(room: SummonRoom) {
        rooms = if (rooms.any { it.id == room.id }) {
            rooms.map { current ->
                if (current.id != room.id) current
                else room.copy(lastMessage = room.lastMessage ?: current.lastMessage)
            }
        } else rooms + room
    }

    private fun updatePending(id: String, mutate: (SummonPendingMessage) -> SummonPendingMessage) {
        pendingMessages = pendingMessages.map { if (it.clientID == id) mutate(it) else it }
    }

    private fun updateVisibleMessages(roomID: String) {
        if (selectedRoomID == roomID) messages = messagesForRoom(roomID)
    }

    private fun restoreSnapshot() {
        val raw = runCatching { cacheFile.readText() }.getOrNull() ?: return
        val json = runCatching { SummonJson.parse(raw) }.getOrNull() ?: return
        if (json["endpoint"].string != settings.baseURL) return
        historyEpoch = json["historyEpoch"].string
        bots = json["bots"].array.orEmpty().map(SummonBot::parse)
        rooms = json["rooms"].array.orEmpty().map(SummonRoom::parse)
        agentRuns = json["agentRuns"].array.orEmpty().map(SummonAgentRun::parse)
        messageHistory = json["messageHistory"].obj.orEmpty().mapValues { (_, value) -> value.array.orEmpty().map(SummonMessage::parse) }
        pendingMessages = json["pendingMessages"].array.orEmpty().map(SummonPendingMessage::parse).map { entry ->
            if (entry.status == "sending") entry.copy(status = "failed", error = "上次发送尚未确认，请手动重试。") else entry
        }
        drafts = json["drafts"].obj.orEmpty().mapValues { it.value.stringValue }
        draftAttachments = json["draftAttachments"].obj.orEmpty().mapValues { it.value.array.orEmpty().map(SummonAttachment::parse) }
        draftTargets = json["draftTargets"].obj.orEmpty().mapValues { it.value.stringValue }
        draftReplies = json["draftReplies"].obj.orEmpty().mapValues { it.value.stringValue }
        selectedRoomID = json["selectedRoomID"].string
        selectedRoomID?.let { messages = messagesForRoom(it) }
        lastSyncAt = json["savedAt"].string?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
        hasSnapshot = true
    }

    private fun schedulePersistence() {
        persistenceJob?.cancel()
        persistenceJob = scope.launch {
            delay(250)
            persistNow()
        }
    }

    private fun persistNow() {
        persistenceJob?.cancel()
        persistenceJob = null
        val snapshot = SummonJson.obj(
            "endpoint" to SummonJson.Str(settings.baseURL),
            "historyEpoch" to (historyEpoch?.let(SummonJson::Str) ?: SummonJson.Null),
            "bots" to SummonJson.Arr(bots.map { it.toJson() }),
            "rooms" to SummonJson.Arr(rooms.map { it.toJson() }),
            "agentRuns" to SummonJson.Arr(agentRuns.map { it.toJson() }),
            "messageHistory" to SummonJson.Obj(messageHistory.mapValues { SummonJson.Arr(it.value.map { message -> message.toJson() }) }),
            "pendingMessages" to SummonJson.Arr(pendingMessages.map { it.toJson() }),
            "drafts" to SummonJson.Obj(drafts.mapValues { SummonJson.Str(it.value) }),
            "draftAttachments" to SummonJson.Obj(draftAttachments.mapValues { SummonJson.Arr(it.value.map { item -> item.toJson() }) }),
            "draftTargets" to SummonJson.Obj(draftTargets.mapValues { SummonJson.Str(it.value) }),
            "draftReplies" to SummonJson.Obj(draftReplies.mapValues { SummonJson.Str(it.value) }),
            "selectedRoomID" to (selectedRoomID?.let(SummonJson::Str) ?: SummonJson.Null),
            "savedAt" to SummonJson.Str(Instant.ofEpochMilli(lastSyncAt ?: System.currentTimeMillis()).toString()),
        )
        runCatching { cacheFile.writeText(snapshot.encode().toString()) }.onFailure { error ->
            errorMessage = "本机草稿暂时无法保存：${error.message}"
        }
    }

    companion object {
        const val DEFAULT_URL = "https://bot.lin0.org"
        private const val SETTINGS_KEY = "SummonNative.connection.v1"
    }
}
