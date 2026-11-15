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

data class SummonReference(val kind: String, val id: String) {
    val path: String?
        get() {
            val part = SummonApiClient.component(id)
            return when (kind) {
                "session", "conversation" -> "/api/executions/$kind/$part"
                "file" -> "/api/files/$part"
                "room" -> "/api/rooms/$part"
                "bot" -> "/api/bots/$part"
                "connection" -> "/api/connections/$part"
                "call" -> "/api/calls/$part"
                "workspace" -> "/api/workspaces/$part"
                else -> null
            }
        }

    fun toJson(): SummonJson = SummonJson.obj("kind" to SummonJson.Str(kind), "id" to SummonJson.Str(id))

    companion object {
        fun parse(json: SummonJson): SummonReference? {
            val kind = json["kind"].string ?: return null
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
    val resumeRef: SummonJson,
    val materialIndex: SummonReference?,
    val avatar: SummonAvatar?,
) {
    val isPaused: Boolean get() = enabled == false || control["state"].string == "paused"
    val resolvedAvatar: SummonAvatar get() = avatar ?: SummonAvatar.defaultFor(id)

    fun toJson(): SummonJson = SummonJson.obj(
        "id" to SummonJson.Str(id), "name" to SummonJson.Str(name),
        "instructions" to instructions.strOrNull(), "model" to model,
        "revision" to revision.numOrNull(), "enabled" to (enabled?.let(SummonJson::Bool) ?: SummonJson.Null),
        "control" to control, "resume_ref" to resumeRef,
        "material_index_ref" to (materialIndex?.toJson() ?: SummonJson.Null),
        "avatar" to (avatar?.toJson() ?: SummonJson.Null),
    )

    companion object {
        fun parse(json: SummonJson): SummonBot {
            val id = json["id"].string ?: throw SummonApiException.invalidResponse
            return SummonBot(id, json["name"].string ?: id, json["instructions"].string, json["model"], json["revision"].int,
                json["enabled"].bool, json["control"], json["resume_ref"], SummonReference.parse(json["material_index_ref"]),
                json["avatar"].takeIf { it.obj != null }?.let(SummonAvatar::parse))
        }
    }
}

data class SummonAttachment(
    val id: String,
    val name: String,
    val mimeType: String,
    val size: Int,
    val url: String? = null,
    val previewUrl: String? = null,
    val unavailable: Boolean = false,
    val staged: Boolean = false,
) {
    val isImage: Boolean get() = previewUrl != null
    val downloadPath: String
        get() {
            val part = SummonApiClient.component(id)
            return if (url?.startsWith("/api/files/") == true) "/api/files/$part/download" else "/api/attachments/$part"
        }

    fun toJson(): SummonJson = SummonJson.obj(
        "id" to SummonJson.Str(id), "name" to SummonJson.Str(name),
        "mimeType" to SummonJson.Str(mimeType), "size" to size.numOrNull(),
        "url" to url.strOrNull(), "previewUrl" to previewUrl.strOrNull(),
        "unavailable" to SummonJson.Bool(unavailable), "staged" to SummonJson.Bool(staged),
    )

    companion object {
        fun parse(json: SummonJson): SummonAttachment = SummonAttachment(
            id = json["id"].string ?: throw SummonApiException.invalidResponse,
            name = json["name"].string ?: "附件",
            mimeType = json["mimeType"].string ?: "application/octet-stream",
            size = json["size"].int ?: 0,
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
) {
    val isOwn: Boolean get() = senderId == "user"

    fun toJson(): SummonJson = SummonJson.obj(
        "id" to SummonJson.Str(id), "roomId" to SummonJson.Str(roomId), "senderId" to SummonJson.Str(senderId),
        "content" to SummonJson.Str(content), "attachments" to SummonJson.Arr(attachments.map(SummonAttachment::toJson)),
        "references" to SummonJson.Arr(references.map(SummonReference::toJson)), "mentions" to mentions.toJsonStrings(),
        "replyTo" to replyTo.strOrNull(), "clientId" to clientId.strOrNull(), "createdAt" to createdAt.strOrNull(),
        "sequence" to sequence.numOrNull(),
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
) {
    val isGroup: Boolean get() = members.size != 2 || "user" !in members

    fun toJson(): SummonJson = SummonJson.obj(
        "id" to SummonJson.Str(id), "name" to SummonJson.Str(name), "members" to members.toJsonStrings(),
        "pins" to SummonJson.Arr(pins.map(SummonReference::toJson)), "revision" to revision.numOrNull(),
        "lastMessage" to (lastMessage?.toJson() ?: SummonJson.Null),
        "createdAt" to createdAt.strOrNull(), "updatedAt" to updatedAt.strOrNull(),
    )

    companion object {
        fun parse(json: SummonJson, stored: Boolean = false): SummonRoom = SummonRoom(
            id = json["id"].string ?: throw SummonApiException.invalidResponse,
            name = json["name"].string ?: "会话",
            members = json["members"].array.orEmpty().mapNotNull { it.string },
            pins = json["pins"].array.orEmpty().mapNotNull(SummonReference::parse),
            revision = json["revision"].int,
            lastMessage = json["lastMessage"].takeIf { it.obj != null }?.let { SummonMessage.parse(it, stored) },
            createdAt = json["createdAt"].string,
            updatedAt = json["updatedAt"].string,
        )
    }
}

data class SummonDelivery(val botId: String, val status: String) {
    companion object {
        fun list(json: SummonJson): List<SummonDelivery> = json.array.orEmpty().mapNotNull {
            val id = it["bot_id"].string ?: return@mapNotNull null
            val status = it["status"].string ?: return@mapNotNull null
            SummonDelivery(id, status)
        }
    }
}

data class SummonReceipt(val message: SummonMessage, val deliveries: List<SummonDelivery>) {
    companion object {
        fun parse(json: SummonJson): SummonReceipt = SummonReceipt(SummonMessage.parse(json["message"]), SummonDelivery.list(json["deliveries"]))
    }
}

data class SummonWorkspaceProfile(val id: String, val name: String)

data class SummonBootstrap(val protocolVersion: Int, val updating: Boolean, val version: String?, val releasesUrl: String?,
    val workspaceProfiles: List<SummonWorkspaceProfile>?) {
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
            json["workspaceProfiles"].array?.mapNotNull { item ->
                val id = item["id"].string ?: return@mapNotNull null
                SummonWorkspaceProfile(id, item["name"].string ?: id)
            },
        )
    }
}

data class SummonInputOption(val kind: String, val target: SummonJson, val question: String?, val choices: List<SummonJson>) {
    val label: String get() = when (kind) {
        "reply" -> "回答"
        "steer" -> "运行中补充"
        else -> "发送下一轮输入"
    }

    companion object {
        fun options(detail: SummonJson): List<SummonInputOption> = detail["input_targets"].array.orEmpty().flatMap { option ->
            val target = option["input_target"]
            if (target.obj == null) return@flatMap emptyList()
            val request = target["request_id"].string?.let { id -> detail["pending_input"].array?.firstOrNull { it["id"].string == id } }
            val question = option["question"].string ?: request?.get("question")?.string ?: request?.get("prompt")?.string
            val choices = option["choices"].array ?: request?.get("choices")?.array.orEmpty()
            option["kinds"].array.orEmpty().mapNotNull { value ->
                value.string?.takeIf { it in listOf("reply", "steer", "next") }?.let { SummonInputOption(it, target, question, choices) }
            }
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

data class SummonConnectionSettings(
    val baseURL: String = "",
    val userName: String = "Lin",
    val workspaceID: String? = null,
) {
    fun toJson(): SummonJson = SummonJson.obj(
        "baseURL" to SummonJson.Str(baseURL),
        "userName" to SummonJson.Str(userName),
        "workspaceID" to workspaceID.strOrNull(),
    )

    companion object {
        fun parse(json: SummonJson): SummonConnectionSettings = SummonConnectionSettings(
            baseURL = json["baseURL"].string ?: "",
            userName = json["userName"].string?.ifBlank { "Lin" } ?: "Lin",
            workspaceID = json["workspaceID"].string,
        )
    }
}
