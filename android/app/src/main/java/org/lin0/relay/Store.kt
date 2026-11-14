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
    var bots by mutableStateOf<List<SummonBot>>(emptyList())
        private set
    var rooms by mutableStateOf<List<SummonRoom>>(emptyList())
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
    var profiles by mutableStateOf<List<SummonWorkspaceProfile>>(emptyList())
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
    var errorMessage by mutableStateOf<String?>(null)

    private var drafts by mutableStateOf<Map<String, String>>(emptyMap())
    private var messageHistory by mutableStateOf<Map<String, List<SummonMessage>>>(emptyMap())
    private var deliveries by mutableStateOf<Map<String, List<SummonDelivery>>>(emptyMap())
    private var cursors by mutableStateOf<Map<String, String>>(emptyMap())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var client: SummonApiClient? = null
    private var streamJob: Job? = null
    private var refreshJob: Job? = null
    private var recoveryJob: Job? = null
    private var persistenceJob: Job? = null
    private val roomReads = mutableSetOf<String>()
    private var connectionGeneration = 0
    private var historyEpoch: String? = null
    private var activeRoomID: String? = null
    private var refreshAgain = false
    private var foreground = false
    private val prefs = app.getSharedPreferences(SETTINGS_KEY, Context.MODE_PRIVATE)
    private val storageDirectory = File(app.filesDir, "RelayNative")

    val isConfigured: Boolean get() = client != null
    val savedToken: String get() = SummonKeystore.token(app, settings.baseURL)

    init {
        val saved = prefs.getString(SETTINGS_KEY, null)
        if (saved != null) settings = runCatching { SummonConnectionSettings.parse(SummonJson.parse(saved)) }.getOrDefault(settings)
        client = runCatching { SummonApiClient(SummonApiClient.normalized(settings.baseURL), savedToken, settings.workspaceID) }.getOrNull()
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
        isConnected = false; protocolReady = false; isLoading = false; isRefreshing = false; refreshAgain = false
        pendingMessages = pendingMessages.map { if (it.status == "sending") it.copy(status = "failed", error = "保存状态待确认。") else it }
        sendingRoomIDs = emptySet()
        persistNow()
    }

    suspend fun saveConnection(baseURL: String, token: String, userName: String? = null) {
        val url = SummonApiClient.normalized(baseURL)
        val endpoint = url.toString()
        val changed = endpoint != settings.baseURL
        val newClient = SummonApiClient(url, token.trim(), if (changed) null else settings.workspaceID)
        val startup = try { withContext(Dispatchers.IO) { newClient.bootstrap() } }
        catch (error: SummonApiException) { throw SummonApiException(startupError(error)) }
        SummonKeystore.save(app, token.trim(), endpoint)
        disconnect()
        if (changed) clearWorkspace()
        settings = SummonConnectionSettings(endpoint, userName?.trim()?.takeIf { it.isNotEmpty() } ?: settings.userName, newClient.workspaceID)
        prefs.edit().putString(SETTINGS_KEY, settings.toJson().encode().toString()).apply()
        client = newClient
        if (changed) restoreSnapshot()
        acceptStartup(startup)
        errorMessage = null
        persistNow()
        start()
    }

    suspend fun selectWorkspace(id: String?) {
        if (settings.workspaceID == id) return
        val api = SummonApiClient(SummonApiClient.normalized(settings.baseURL), savedToken, id)
        val startup = withContext(Dispatchers.IO) { api.bootstrap() }
        if (!startup.ready) throw SummonApiException(startup.notice ?: "暂时无法切换工作区。")
        disconnect()
        clearWorkspace()
        settings = settings.copy(workspaceID = id)
        prefs.edit().putString(SETTINGS_KEY, settings.toJson().encode().toString()).apply()
        client = api
        restoreSnapshot()
        acceptStartup(startup)
        errorMessage = null
        persistNow()
        start()
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
            if (!protocolReady) {
                val startup = withContext(Dispatchers.IO) { api.bootstrap() }
                if (connection != connectionGeneration) return
                acceptStartup(startup)
                if (!startup.ready) return
            }
            val state = withContext(Dispatchers.IO) { api.requestJson("/api/state") }
            if (connection != connectionGeneration) return
            val epoch = state["historyEpoch"].string
            if (historyEpoch != epoch) { messageHistory = emptyMap(); deliveries = emptyMap(); cursors = emptyMap() }
            historyEpoch = epoch
            bots = (state["bots"].array ?: throw SummonApiException.invalidResponse).map(SummonBot::parse)
            rooms = (state["rooms"].array ?: throw SummonApiException.invalidResponse).map { SummonRoom.parse(it) }
            if (state["modelSettings"].obj != null) modelSummary = state["modelSettings"]
            errorMessage = null
            lastSyncAt = System.currentTimeMillis()
            activeRoomID?.takeIf { room(it) != null }?.let { loadRoom(it) }
            if (connection == connectionGeneration) schedulePersistence()
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (connection != connectionGeneration) return
            if (!protocolReady) protocolNotice = startupError(error) else handle(error)
        } finally {
            if (connection == connectionGeneration) {
                isRefreshing = false; isLoading = false
                if (refreshAgain) { refreshAgain = false; scheduleRefresh() }
            }
        }
    }

    private fun acceptStartup(startup: SummonBootstrap) {
        if (!startup.updating) startup.workspaceProfiles?.let { profiles = it }
        protocolReady = startup.ready
        protocolNotice = startup.notice
        needsClientUpdate = startup.protocolVersion > SummonApiClient.PROTOCOL_VERSION
    }

    private fun startupError(error: Exception): String = when ((error as? SummonApiException)?.status) {
        404 -> "正在等待服务支持当前协议。草稿和待确认的发送已保留。"
        503 -> "服务正在更新。草稿和待确认的发送已保留。"
        else -> error.localizedMessage ?: "暂时无法连接服务。"
    }

    private fun handle(error: Exception) {
        when (val status = (error as? SummonApiException)?.status) {
            426, 503 -> {
                protocolReady = false; isConnected = false
                protocolNotice = if (status == 503) "服务正在更新。草稿和待确认的发送已保留。" else "正在重新检查服务协议。"
                scheduleRefresh()
            }
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

    fun room(id: String): SummonRoom? = rooms.firstOrNull { it.id == id }
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
        "session" -> "执行会话 · " + ref.id
        "conversation" -> "内部对话 · " + ref.id
        else -> ref.id
    }

    fun deliveryFacts(id: String): List<SummonDelivery> = deliveries[id].orEmpty()
    fun pendingMessage(message: SummonMessage): SummonPendingMessage? =
        pendingMessages.firstOrNull { it.clientID == message.clientId && it.roomID == message.roomId }

    fun canLoadOlder(id: String): Boolean = id in cursors

    suspend fun loadRoom(id: String, older: Boolean = false) {
        val api = client ?: return
        if (!protocolReady || !roomReads.add(id)) return
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
            val confirmed = page.filter(SummonMessage::isOwn).mapNotNull(SummonMessage::clientId).toSet()
            val staged = pendingMessages.filter { it.roomID == id && it.clientID in confirmed }.flatMap { it.message.attachments }
            pendingMessages = pendingMessages.filterNot { it.roomID == id && it.clientID in confirmed }
            if (staged.isNotEmpty() && persistNow()) staged.forEach(::discardStagedAttachment)
            schedulePersistence()
            lastSyncAt = System.currentTimeMillis()
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { if (connection == connectionGeneration && id == activeRoomID) handle(error) }
        finally { if (connection == connectionGeneration) roomReads.remove(id) }
    }

    suspend fun openDirectMessage(bot: SummonBot): SummonRoom =
        rooms.firstOrNull { !it.isGroup && bot.id in it.members } ?: createGroup(bot.name, listOf(bot.id))

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

    suspend fun createGroup(name: String, members: List<String>): SummonRoom {
        val body = SummonJson.Obj(buildMap {
            put("members", members.toJsonStrings())
            if (name.isNotEmpty()) put("title", SummonJson.Str(name))
        })
        return SummonRoom.parse(request("/api/rooms", "POST", body, newID())).also(::upsertRoom)
    }

    suspend fun updateRoom(room: SummonRoom, name: String, members: List<String>) {
        changeRoom(room, mapOf("title" to SummonJson.Str(name),
            "add_members" to members.filterNot { it in room.members }.toJsonStrings(),
            "remove_members" to room.members.filter { it != "user" && it !in members }.toJsonStrings()))
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

    suspend fun retryMessage(clientID: String) = deliver(clientID, queryFirst = true)

    private suspend fun deliver(id: String, queryFirst: Boolean) {
        val api = client ?: return
        val item = pendingMessages.firstOrNull { it.clientID == id } ?: return
        if (!protocolReady || item.status == "sent" || item.roomID in sendingRoomIDs) return
        val connection = connectionGeneration
        sendingRoomIDs = sendingRoomIDs + item.roomID
        updatePending(id) { it.copy(status = "sending", error = null) }
        try {
            if (!persistNow()) throw SummonApiException("本机发送记录无法保存。")
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
                })
                receipt = SummonReceipt.parse(withContext(Dispatchers.IO) { api.requestJson(path, "POST", body, id) })
            }
            if (connection != connectionGeneration) return
            val confirmed = receipt ?: throw SummonApiException.invalidReceipt
            val message = confirmed.message
            if (message.clientId != id || message.roomId != item.roomID || !message.isOwn || message.id.isEmpty()) throw SummonApiException.invalidReceipt
            deliveries = deliveries + (message.id to confirmed.deliveries)
            updatePending(id) { it.copy(message = message, status = "sent", error = null) }
            rooms = rooms.map { if (it.id == item.roomID) it.copy(lastMessage = message) else it }
            if (persistNow()) item.message.attachments.forEach(::discardStagedAttachment)
            scheduleRefresh()
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (connection == connectionGeneration) {
                updatePending(id) { it.copy(status = "failed", error = error.localizedMessage) }
                persistNow()
                if ((error as? SummonApiException)?.status in listOf(426, 503)) handle(error)
            }
        } finally {
            if (connection == connectionGeneration) {
                sendingRoomIDs = sendingRoomIDs - item.roomID
                if (pendingMessages.any { it.clientID == id && it.status == "sending" }) {
                    updatePending(id) { it.copy(status = "failed", error = protocolNotice ?: "保存状态待确认。") }
                    persistNow()
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

    suspend fun downloadFile(id: String, name: String): File {
        val api = apiClient()
        return withContext(Dispatchers.IO) { api.download(app, "/api/files/" + SummonApiClient.component(id) + "/download", name) }
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
            if (connection == connectionGeneration && error.status in listOf(426, 503)) handle(error)
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
        var cursor: String? = null
        do {
            val endpoint = path + (cursor?.let { (if ("?" in path) "&" else "?") + "cursor=" + SummonApiClient.component(it) }).orEmpty()
            val page = request(endpoint)
            items += page["items"].array.orEmpty()
            cursor = page["next_cursor"].string
        } while (cursor != null)
        return items
    }

    private fun apiClient(): SummonApiClient {
        val api = client ?: throw SummonApiException.noConnection
        if (!protocolReady) throw SummonApiException(protocolNotice ?: "正在连接工作区。")
        return api
    }

    private fun startStream() {
        val api = client ?: return
        if (streamJob != null) return
        val connection = connectionGeneration
        streamJob = scope.launch {
            var seconds = 1L
            while (isActive && foreground && connection == connectionGeneration) {
                if (!protocolReady) refresh()
                if (protocolReady) {
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
                        if ((error as? SummonApiException)?.status in listOf(426, 503)) handle(error)
                        if (android.os.SystemClock.elapsedRealtime() - started >= 30_000) seconds = 1
                    }
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

    private fun clearWorkspace() {
        bots = emptyList(); rooms = emptyList(); messageHistory = emptyMap(); deliveries = emptyMap(); cursors = emptyMap()
        pendingMessages = emptyList(); drafts = emptyMap(); draftAttachments = emptyMap(); draftMentions = emptyMap()
        draftReplies = emptyMap(); draftReferences = emptyMap(); activeRoomID = null; historyEpoch = null; lastSyncAt = null
        modelSummary = SummonJson.Null
    }

    private fun snapshotFile(): File? {
        if (settings.baseURL.isEmpty()) return null
        val keyText = settings.workspaceID?.let { settings.baseURL + "|" + it } ?: settings.baseURL
        val key = android.util.Base64.encodeToString(keyText.toByteArray(), android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE)
        val directory = key.chunked(120).fold(File(storageDirectory, "workspaces")) { root, part -> File(root, part) }
        return File(directory, "snapshot.json")
    }

    private fun restoreSnapshot() {
        val current = snapshotFile() ?: return
        val old = File(storageDirectory, "workspace.json")
        val useLegacy = settings.workspaceID == null && !current.exists() && old.exists()
        val source = if (useLegacy) old else current
        val saved = runCatching { SummonJson.parse(AtomicFile(source).readFully().toString(Charsets.UTF_8)) }.getOrNull() ?: return
        if (saved["endpoint"].string != settings.baseURL || saved["workspaceID"].string != settings.workspaceID) return
        runCatching {
            historyEpoch = saved["historyEpoch"].string
            bots = saved["bots"].array.orEmpty().map(SummonBot::parse)
            rooms = saved["rooms"].array.orEmpty().map { SummonRoom.parse(it, stored = true) }
            messageHistory = saved["messageHistory"].obj.orEmpty().mapValues { (_, list) ->
                list.array.orEmpty().map { SummonMessage.parse(it, stored = true) }
            }
            pendingMessages = saved["pendingMessages"].array.orEmpty().map(SummonPendingMessage::parse).map {
                if (it.status in listOf("sending", "queued")) it.copy(status = "failed", error = "上次发送的保存状态待确认。") else it
            }
            drafts = saved["drafts"].obj.orEmpty().mapValues { it.value.stringValue }
            draftAttachments = saved["draftAttachments"].obj.orEmpty().mapValues { it.value.array.orEmpty().map(SummonAttachment::parse) }
            draftMentions = saved["draftMentions"].obj?.mapValues { it.value.array.orEmpty().mapNotNull { entry -> entry.string } }
                ?: saved["draftTargets"].obj.orEmpty().mapValues { listOfNotNull(it.value.string) }
            draftReferences = saved["draftReferences"].obj.orEmpty().mapValues { it.value.array.orEmpty().mapNotNull(SummonReference::parse) }
            draftReplies = saved["draftReplies"].obj.orEmpty().mapValues { it.value.stringValue }
            lastSyncAt = (saved["savedAt"] as? SummonJson.Num)?.value?.toLong()
                ?: parseSummonDate(saved["savedAt"].string)?.toEpochMilli()
        }.onSuccess { if (useLegacy && persistNow()) old.delete() }
    }

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
        val cachedMessages = messageHistory.mapValues { SummonJson.Arr(it.value.takeLast(100).map(SummonMessage::toJson)) }
        val snapshot = SummonJson.obj(
            "endpoint" to SummonJson.Str(settings.baseURL), "workspaceID" to settings.workspaceID.strOrNull(), "historyEpoch" to historyEpoch.strOrNull(),
            "bots" to SummonJson.Arr(bots.map(SummonBot::toJson)), "rooms" to SummonJson.Arr(rooms.map(SummonRoom::toJson)),
            "messageHistory" to SummonJson.Obj(cachedMessages),
            "pendingMessages" to SummonJson.Arr(pendingMessages.map(SummonPendingMessage::toJson)),
            "drafts" to SummonJson.Obj(drafts.mapValues { SummonJson.Str(it.value) }),
            "draftAttachments" to SummonJson.Obj(draftAttachments.mapValues { SummonJson.Arr(it.value.map(SummonAttachment::toJson)) }),
            "draftMentions" to SummonJson.Obj(draftMentions.mapValues { it.value.toJsonStrings() }),
            "draftReplies" to SummonJson.Obj(draftReplies.mapValues { SummonJson.Str(it.value) }),
            "draftReferences" to SummonJson.Obj(draftReferences.mapValues { SummonJson.Arr(it.value.map(SummonReference::toJson)) }),
            "savedAt" to SummonJson.Num((lastSyncAt ?: System.currentTimeMillis()).toDouble()),
        )
        val file = AtomicFile(target)
        return try {
            target.parentFile?.mkdirs()
            val stream = file.startWrite()
            try { stream.write(snapshot.bytes()); file.finishWrite(stream) }
            catch (error: Exception) { file.failWrite(stream); throw error }
            true
        } catch (error: Exception) {
            errorMessage = "无法保存本机草稿：" + error.localizedMessage
            false
        }
    }

    companion object {
        private const val SETTINGS_KEY = "SummonNative.connection.v1"
        fun newID(): String = UUID.randomUUID().toString()
        private fun roomPath(id: String): String = "/api/rooms/" + SummonApiClient.component(id)
    }
}
