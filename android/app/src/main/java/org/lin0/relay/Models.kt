package org.lin0.relay

data class SummonAvatar(
    val shape: String = "cercle",
    val color: String = "#7D824B",
    val image: String? = null,
    val secondary: String? = null,
    val ink: String? = null,
    val paper: String? = null,
) {
    fun toJson(): SummonJson = SummonJson.obj(
        "shape" to SummonJson.Str(shape),
        "color" to SummonJson.Str(color),
        "image" to (image?.let { SummonJson.Str(it) } ?: SummonJson.Null),
        "secondary" to (secondary?.let { SummonJson.Str(it) } ?: SummonJson.Null),
        "ink" to (ink?.let { SummonJson.Str(it) } ?: SummonJson.Null),
        "paper" to (paper?.let { SummonJson.Str(it) } ?: SummonJson.Null),
    )

    companion object {
        val shapes = PaperLibrary.ids.zip(PaperLibrary.names)

        fun parse(json: SummonJson): SummonAvatar = SummonAvatar(
            shape = json["shape"].string ?: "cercle",
            color = json["color"].string ?: "#7D824B",
            image = json["image"].string,
            secondary = json["secondary"].string,
            ink = json["ink"].string,
            paper = json["paper"].string,
        )

        fun defaultFor(id: String): SummonAvatar {
            var value = 5381L
            for (character in id.codePoints().toArray()) value = ((value * 33) xor character.toLong()) and 0xFFFFFFFFL
            val role = when(id) { "bot-engineer" -> "squircle"; "bot-components" -> "hexagone"; "bot-qa" -> "nuage"; else -> PaperLibrary.ids[(value % PaperLibrary.ids.size).toInt()] }
            return SummonAvatar(shape=role, color=PaperLibrary.defaultColors[PaperLibrary.ids.indexOf(role)])
        }
    }
}

data class SummonReference(
    val kind: String,
    val id: String,
    val workspaceId: String? = null,
    val filePath: String? = null,
) {
    val path: String?
        get() {
            if (kind == "workspace_file" && !workspaceId.isNullOrBlank() && !filePath.isNullOrBlank()) {
                return "/api/workspaces/${SummonApiClient.component(workspaceId)}/file?path=${SummonApiClient.component(filePath)}"
            }
            val part = SummonApiClient.component(id)
            return when (kind) {
                "session", "conversation" -> "/api/executions/$kind/$part"
                "file" -> "/api/files/$part"
                "room" -> "/api/rooms/$part"
                "bot" -> "/api/bots/$part"
                "call" -> "/api/calls/$part"
                "workspace" -> "/api/workspaces/$part"
                else -> null
            }
        }

    fun toJson(): SummonJson = if (kind == "workspace_file" && !workspaceId.isNullOrBlank() && !filePath.isNullOrBlank()) {
        SummonJson.obj("kind" to SummonJson.Str(kind), "workspace_id" to SummonJson.Str(workspaceId), "path" to SummonJson.Str(filePath))
    } else {
        SummonJson.obj("kind" to SummonJson.Str(kind), "id" to SummonJson.Str(id))
    }

    companion object {
        fun parse(json: SummonJson): SummonReference? {
            val kind = json["kind"].string ?: return null
            if (kind == "workspace_file") {
                val wsId = json["workspace_id"].string?.takeIf { it.isNotEmpty() } ?: return null
                val relPath = json["path"].string?.takeIf { it.isNotEmpty() } ?: return null
                return SummonReference(kind = kind, id = "$wsId:$relPath", workspaceId = wsId, filePath = relPath)
            }
            val id = json["id"].string?.takeIf { it.isNotEmpty() } ?: return null
            return SummonReference(kind, id)
        }
    }
}

data class SummonBot(
    val id: String,
    val name: String,
    val instructions: String?,
    val model: SummonJson,
    val revision: Int?,
    val enabled: Boolean?,
    val control: SummonJson,
    val avatar: SummonAvatar?,
    val memoryItems: List<SummonJson> = emptyList(),
    val activity: String? = null,
    val roleId: String? = null,
    val homeRoomId: String? = null,
) {
    val isPaused: Boolean get() = enabled == false || control["state"].string == "paused" || activity == "paused"
    val resolvedActivity: String get() = if (isPaused) "paused" else activity ?: "idle"
    val activityMotion: String get() = when (resolvedActivity) {
        "paused" -> "sleep"
        "working" -> "work"
        "error" -> "failed"
        else -> "idle"
    }
    val resolvedAvatar: SummonAvatar get() = avatar ?: SummonAvatar.defaultFor(id)

    fun toJson(): SummonJson = SummonJson.obj(
        "id" to SummonJson.Str(id), "name" to SummonJson.Str(name),
        "instructions" to instructions.strOrNull(), "model" to model,
        "revision" to revision.numOrNull(), "enabled" to (enabled?.let(SummonJson::Bool) ?: SummonJson.Null),
        "control" to control,
        "avatar" to (avatar?.toJson() ?: SummonJson.Null),
        "memory_items" to SummonJson.Arr(memoryItems),
        "activity" to activity.strOrNull(),
        "role_id" to roleId.strOrNull(),
        "home_room_id" to homeRoomId.strOrNull(),
    )

    companion object {
        fun parse(json: SummonJson): SummonBot {
            val id = json["id"].string ?: throw SummonApiException.invalidResponse
            return SummonBot(id, json["name"].string ?: id, json["instructions"].string, json["model"], json["revision"].int,
                json["enabled"].bool, json["control"],
                json["avatar"].takeIf { it.obj != null }?.let(SummonAvatar::parse),
                json["memory_items"].array.orEmpty(),
                json["activity"].string,
                json["role_id"].string,
                json["home_room_id"].string)
        }
    }
}

data class SummonAttachment(
    val id: String,
    val name: String,
    val mimeType: String,
    val size: Int,
    val revision: Int? = null,
    val url: String? = null,
    val previewUrl: String? = null,
    val unavailable: Boolean = false,
    val staged: Boolean = false,
) {
    val isImage: Boolean get() = previewUrl != null
    val downloadPath: String
        get() {
            val part = SummonApiClient.component(id)
            return if (url?.startsWith("/api/files/") == true) url else "/api/attachments/$part"
        }

    fun toJson(): SummonJson = SummonJson.obj(
        "id" to SummonJson.Str(id), "name" to SummonJson.Str(name),
        "mimeType" to SummonJson.Str(mimeType), "size" to size.numOrNull(),
        "revision" to revision.numOrNull(),
        "url" to url.strOrNull(), "previewUrl" to previewUrl.strOrNull(),
        "unavailable" to SummonJson.Bool(unavailable), "staged" to SummonJson.Bool(staged),
    )

    companion object {
        fun parse(json: SummonJson): SummonAttachment = SummonAttachment(
            id = json["id"].string ?: throw SummonApiException.invalidResponse,
            name = json["name"].string ?: "附件",
            mimeType = json["mimeType"].string ?: "application/octet-stream",
            size = json["size"].int ?: 0,
            revision = json["revision"].int,
            url = json["url"].string,
            previewUrl = json["previewUrl"].string,
            unavailable = json["unavailable"].bool == true,
            staged = json["staged"].bool == true,
        )
    }
}

data class SummonMessage(
    val id: String,
    val roomId: String,
    val senderId: String,
    val content: String,
    val attachments: List<SummonAttachment> = emptyList(),
    val references: List<SummonReference> = emptyList(),
    val mentions: List<String> = emptyList(),
    val replyTo: String? = null,
    val clientId: String? = null,
    val createdAt: String? = null,
    val sequence: Int? = null,
    val prompt: SummonJson? = null,
    val promptResponse: SummonJson? = null,
    val promptAnswer: SummonJson? = null,
) {
    val isOwn: Boolean get() = senderId == "user"
    val stableListID: String get() = if (isOwn) (clientId ?: id) else id

    fun toJson(): SummonJson = SummonJson.obj(
        "id" to SummonJson.Str(id), "roomId" to SummonJson.Str(roomId), "senderId" to SummonJson.Str(senderId),
        "content" to SummonJson.Str(content), "attachments" to SummonJson.Arr(attachments.map(SummonAttachment::toJson)),
        "references" to SummonJson.Arr(references.map(SummonReference::toJson)), "mentions" to mentions.toJsonStrings(),
        "replyTo" to replyTo.strOrNull(), "clientId" to clientId.strOrNull(), "createdAt" to createdAt.strOrNull(),
        "sequence" to sequence.numOrNull(),
        "prompt" to (prompt ?: SummonJson.Null),
        "promptResponse" to (promptResponse ?: SummonJson.Null),
        "promptAnswer" to (promptAnswer ?: SummonJson.Null),
    )

    companion object {
        fun parse(json: SummonJson, stored: Boolean = false): SummonMessage = SummonMessage(
            id = json["id"].string ?: throw SummonApiException.invalidResponse,
            roomId = json["roomId"].string ?: throw SummonApiException.invalidResponse,
            senderId = json["senderId"].string ?: "platform",
            content = json["content"].string.orEmpty(),
            attachments = json["attachments"].array.orEmpty().map(SummonAttachment::parse),
            references = json["references"].array.orEmpty().mapNotNull(SummonReference::parse),
            mentions = json["mentions"].array?.mapNotNull { it.string }
                ?: (if (stored) listOfNotNull(json["toBotId"].string) else emptyList()),
            replyTo = json["replyTo"].string,
            clientId = json["clientId"].string,
            createdAt = json["createdAt"].string,
            sequence = json["sequence"].int,
            prompt = json["prompt"].takeIf { it.obj != null },
            promptResponse = json["promptResponse"].takeIf { it.obj != null },
            promptAnswer = json["promptAnswer"].takeIf { it.obj != null },
        )
    }
}

data class SummonRoom(
    val id: String,
    val name: String,
    val members: List<String>,
    val pins: List<SummonReference>,
    val revision: Int?,
    val lastMessage: SummonMessage?,
    val createdAt: String?,
    val updatedAt: String?,
    val deletable: Boolean = false,
    val archivable: Boolean = false,
    val archivedAt: String? = null,
    val leadBotId: String? = null,
    val autoTitlePending: Boolean = false,
    val mode: String? = null,
) {
    val isArchived: Boolean get() = !archivedAt.isNullOrBlank()
    val isGroup: Boolean get() = if (mode != null) mode != "direct" else members.size != 2 || "user" !in members

    fun toJson(): SummonJson = SummonJson.obj(
        "id" to SummonJson.Str(id), "name" to SummonJson.Str(name), "members" to members.toJsonStrings(),
        "mode" to mode.strOrNull(),
        "deletable" to SummonJson.Bool(deletable),
        "archivable" to SummonJson.Bool(archivable),
        "archived_at" to archivedAt.strOrNull(),
        "lead_bot_id" to leadBotId.strOrNull(),
        "auto_title_pending" to SummonJson.Bool(autoTitlePending),
        "pins" to SummonJson.Arr(pins.map(SummonReference::toJson)), "revision" to revision.numOrNull(),
        "lastMessage" to (lastMessage?.toJson() ?: SummonJson.Null),
        "createdAt" to createdAt.strOrNull(), "updatedAt" to updatedAt.strOrNull(),
    )

    companion object {
        fun parse(json: SummonJson, stored: Boolean = false): SummonRoom = SummonRoom(
            deletable = json["deletable"].bool == true,
            archivable = json["archivable"].bool == true,
            archivedAt = json["archived_at"].string,
            id = json["id"].string ?: throw SummonApiException.invalidResponse,
            name = json["name"].string ?: "会话",
            members = json["members"].array.orEmpty().mapNotNull { it.string },
            pins = json["pins"].array.orEmpty().mapNotNull(SummonReference::parse),
            revision = json["revision"].int,
            lastMessage = json["lastMessage"].takeIf { it.obj != null }?.let { SummonMessage.parse(it, stored) },
            createdAt = json["createdAt"].string,
            updatedAt = json["updatedAt"].string,
            leadBotId = json["lead_bot_id"].string,
            autoTitlePending = json["auto_title_pending"].bool == true,
            mode = json["mode"].string,
        )
    }
}

data class SummonDelivery(val botId: String, val status: String, val diagnostic: String?) {
    companion object {
        fun list(json: SummonJson): List<SummonDelivery> = json.array.orEmpty().mapNotNull {
            val id = it["bot_id"].string ?: return@mapNotNull null
            val status = it["status"].string ?: return@mapNotNull null
            SummonDelivery(id, status, it["fast_read_diagnostic"]["message"].string)
        }
    }
}

data class SummonMessageSummary(val botId: String, val summary: String, val updatedAt: String? = null) {
    fun toJson(): SummonJson = SummonJson.obj(
        "bot_id" to SummonJson.Str(botId),
        "summary" to SummonJson.Str(summary),
        "updated_at" to updatedAt.strOrNull(),
    )

    companion object {
        fun list(json: SummonJson): List<SummonMessageSummary> = json.array.orEmpty().mapNotNull {
            val id = it["bot_id"].string ?: return@mapNotNull null
            val summary = it["summary"].string?.takeIf { text -> text.isNotBlank() } ?: return@mapNotNull null
            SummonMessageSummary(id, summary, it["updated_at"].string)
        }
    }
}

data class SummonOptimisticWork(
    val botId: String,
    val sentMessageId: String,
    val startedAtMs: Long,
)

data class SummonRoomActivity(
    val botId: String,
    val phase: String? = null,
    val text: String,
    val workSummary: String? = null,
    val executionRef: SummonReference? = null,
    val startedAt: String? = null,
    val updatedAt: String? = null,
) {
    companion object {
        fun list(json: SummonJson): List<SummonRoomActivity> = json.array.orEmpty().mapNotNull {
            val id = it["bot_id"].string ?: return@mapNotNull null
            val text = it["text"].string?.takeIf { value -> value.isNotBlank() } ?: return@mapNotNull null
            SummonRoomActivity(
                botId = id,
                phase = it["phase"].string,
                text = text,
                workSummary = it["work_summary"].string,
                executionRef = SummonReference.parse(it["execution_ref"]),
                startedAt = it["started_at"].string,
                updatedAt = it["updated_at"].string,
            )
        }
    }
}

data class SummonReceipt(val message: SummonMessage, val deliveries: List<SummonDelivery>) {
    companion object {
        fun parse(json: SummonJson): SummonReceipt = SummonReceipt(SummonMessage.parse(json["message"]), SummonDelivery.list(json["deliveries"]))
    }
}


data class SummonBootstrap(val protocolVersion: Int, val updating: Boolean, val version: String?, val releasesUrl: String?) {
    val ready: Boolean get() = protocolVersion == SummonApiClient.PROTOCOL_VERSION
    val notice: String?
        get() = when {
            updating -> "服务正在更新。草稿和待确认的发送已保留。"
            protocolVersion > SummonApiClient.PROTOCOL_VERSION -> "当前客户端需要更新。"
            protocolVersion < SummonApiClient.PROTOCOL_VERSION -> "正在等待服务更新。草稿和待确认的发送已保留。"
            else -> null
        }

    companion object {
        fun parse(json: SummonJson): SummonBootstrap = SummonBootstrap(
            json["protocolVersion"].int ?: throw SummonApiException.invalidResponse,
            json["updating"].bool ?: throw SummonApiException.invalidResponse,
            json["version"].string, json["releasesUrl"].string,
        )
    }
}

data class SummonInputOption(val kind: String, val requestId: String? = null, val question: String? = null, val choices: List<SummonJson> = emptyList()) {
    val label: String get() = when (kind) {
        "reply" -> "回答"
        "steer" -> "运行中补充"
        else -> "发送下一轮输入"
    }

    companion object {
        fun options(detail: SummonJson): List<SummonInputOption> = buildList {
            val pending = detail["pending_requests"].array ?: detail["pending_input"].array.orEmpty()
            pending.forEach { req ->
                val rid = req["request_id"].string ?: req["id"].string
                val question = req["question"].string ?: req["text"].string ?: req["prompt"].string
                add(SummonInputOption("reply", rid, question, req["choices"].array.orEmpty()))
            }
            if (detail["can_steer"].bool == true) add(SummonInputOption("steer"))
            if (detail["can_continue"].bool == true) add(SummonInputOption("next"))
        }
    }
}

internal fun String?.strOrNull(): SummonJson = this?.let(SummonJson::Str) ?: SummonJson.Null
internal fun Int?.numOrNull(): SummonJson = this?.let { SummonJson.Num(it.toDouble()) } ?: SummonJson.Null
internal fun List<String>.toJsonStrings(): SummonJson = SummonJson.Arr(map(SummonJson::Str))

data class SummonPendingMessage(
    val clientID: String,
    val message: SummonMessage,
    val status: String,
    val error: String? = null,
) {
    val roomID: String get() = message.roomId

    fun toJson(): SummonJson = SummonJson.obj(
        "clientID" to SummonJson.Str(clientID),
        "message" to message.toJson(),
        "status" to SummonJson.Str(status),
        "error" to (error?.let(SummonJson::Str) ?: SummonJson.Null),
    )

    companion object {
        fun parse(json: SummonJson): SummonPendingMessage = SummonPendingMessage(
            clientID = json["clientID"].string ?: json["clientId"].string ?: "",
            message = SummonMessage.parse(json["message"], stored = true),
            status = json["status"].string ?: "failed",
            error = json["error"].string,
        )
    }
}

data class SummonHubNode(
    val id: String,
    val name: String,
    val platform: String? = null,
    val hostname: String? = null,
    val online: Boolean = false,
) {
    companion object {
        fun parse(json: SummonJson): SummonHubNode = SummonHubNode(
            id = json["id"].string.orEmpty(),
            name = json["name"].string?.ifBlank { "PC" } ?: "PC",
            platform = json["platform"].string,
            hostname = json["hostname"].string,
            online = json["online"].bool == true,
        )
    }
}

data class SummonHubAuthResult(
    val username: String,
    val displayName: String,
    val token: String,
)

data class SummonConnectionSettings(
    val baseURL: String = "",
    val userName: String = "本地账户",
    val hubUsername: String? = null,
    val activeNodeID: String? = null,
) {
    fun toJson(): SummonJson = SummonJson.obj(
        "baseURL" to SummonJson.Str(baseURL),
        "userName" to SummonJson.Str(userName),
        "hubUsername" to (hubUsername?.let { SummonJson.Str(it) } ?: SummonJson.Null),
        "activeNodeID" to (activeNodeID?.let { SummonJson.Str(it) } ?: SummonJson.Null),
    )

    companion object {
        fun parse(json: SummonJson): SummonConnectionSettings = SummonConnectionSettings(
            baseURL = json["baseURL"].string ?: "",
            userName = json["userName"].string?.ifBlank { "本地账户" } ?: "本地账户",
            hubUsername = json["hubUsername"].string,
            activeNodeID = json["activeNodeID"].string,
        )
    }
}
