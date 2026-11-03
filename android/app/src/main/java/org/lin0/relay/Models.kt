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

data class SummonBot(
    val id: String,
    val name: String,
    val role: String,
    val expertise: String,
    val prompt: String,
    val status: String,
    val presetId: String?,
    val roleId: String?,
    val avatar: SummonAvatar?,
    val createdAt: String?,
) {
    val isSystem: Boolean get() = presetId != null
    val isPaused: Boolean get() = status == "paused"
    val resolvedAvatar: SummonAvatar get() = avatar ?: SummonAvatar.defaultFor(id)

    fun toJson(): SummonJson = SummonJson.obj(
        "id" to SummonJson.Str(id),
        "name" to SummonJson.Str(name),
        "role" to SummonJson.Str(role),
        "expertise" to SummonJson.Str(expertise),
        "prompt" to SummonJson.Str(prompt),
        "status" to SummonJson.Str(status),
        "presetId" to (presetId?.let(SummonJson::Str) ?: SummonJson.Null),
        "roleId" to (roleId?.let(SummonJson::Str) ?: SummonJson.Null),
        "avatar" to (avatar?.toJson() ?: SummonJson.Null),
        "createdAt" to (createdAt?.let(SummonJson::Str) ?: SummonJson.Null),
    )

    companion object {
        fun parse(json: SummonJson): SummonBot = SummonBot(
            id = json["id"].string ?: "",
            name = json["name"].string ?: json["id"].string ?: "",
            role = json["role"].string ?: "",
            expertise = json["expertise"].stringValue,
            prompt = json["prompt"].string ?: "",
            status = json["status"].string ?: "active",
            presetId = json["presetId"].string,
            roleId = json["roleId"].string,
            avatar = if (json["avatar"] is SummonJson.Obj) SummonAvatar.parse(json["avatar"]) else null,
            createdAt = json["createdAt"].string,
        )
    }
}

data class SummonAttachment(
    val id: String,
    val name: String,
    val mimeType: String,
    val size: Int,
    val url: String? = null,
    val previewUrl: String? = null,
    val createdAt: String? = null,
) {
    val isImage: Boolean get() = previewUrl != null

    fun toJson(): SummonJson = SummonJson.obj(
        "id" to SummonJson.Str(id),
        "name" to SummonJson.Str(name),
        "mimeType" to SummonJson.Str(mimeType),
        "size" to SummonJson.Num(size.toDouble()),
        "url" to (url?.let(SummonJson::Str) ?: SummonJson.Null),
        "previewUrl" to (previewUrl?.let(SummonJson::Str) ?: SummonJson.Null),
        "createdAt" to (createdAt?.let(SummonJson::Str) ?: SummonJson.Null),
    )

    companion object {
        fun parse(json: SummonJson): SummonAttachment = SummonAttachment(
            id = json["id"].string ?: "",
            name = json["name"].string ?: "附件",
            mimeType = json["mimeType"].string ?: "application/octet-stream",
            size = json["size"].int ?: 0,
            url = json["url"].string,
            previewUrl = json["previewUrl"].string,
            createdAt = json["createdAt"].string,
        )
    }
}

data class SummonMessage(
    val id: String,
    val roomId: String,
    val senderId: String,
    val content: String,
    val attachments: List<SummonAttachment> = emptyList(),
    val kind: String = "message",
    val replyTo: String? = null,
    val toBotId: String? = null,
    val clientId: String? = null,
    val jobId: String? = null,
    val createdAt: String? = null,
) {
    val isOwn: Boolean get() = senderId == "user"

    fun toJson(): SummonJson = SummonJson.obj(
        "id" to SummonJson.Str(id),
        "roomId" to SummonJson.Str(roomId),
        "senderId" to SummonJson.Str(senderId),
        "content" to SummonJson.Str(content),
        "attachments" to SummonJson.Arr(attachments.map { it.toJson() }),
        "kind" to SummonJson.Str(kind),
        "replyTo" to (replyTo?.let(SummonJson::Str) ?: SummonJson.Null),
        "toBotId" to (toBotId?.let(SummonJson::Str) ?: SummonJson.Null),
        "clientId" to (clientId?.let(SummonJson::Str) ?: SummonJson.Null),
        "jobId" to (jobId?.let(SummonJson::Str) ?: SummonJson.Null),
        "createdAt" to (createdAt?.let(SummonJson::Str) ?: SummonJson.Null),
    )

    companion object {
        fun parse(json: SummonJson): SummonMessage = SummonMessage(
            id = json["id"].string ?: "",
            roomId = json["roomId"].string ?: "",
            senderId = json["senderId"].string ?: "system",
            content = json["content"].string ?: "",
            attachments = json["attachments"].array.orEmpty().map(SummonAttachment::parse),
            kind = json["kind"].string ?: "message",
            replyTo = json["replyTo"].string,
            toBotId = json["toBotId"].string,
            clientId = json["clientId"].string,
            jobId = json["jobId"].string,
            createdAt = json["createdAt"].string,
        )
    }
}

data class SummonRoom(
    val id: String,
    val name: String,
    val kind: String,
    val members: List<String>,
    val status: String,
    val goal: String,
    val summary: String,
    val lastMessage: SummonMessage?,
    val createdAt: String?,
) {
    val isGroup: Boolean get() = kind != "dm"
    val isConcluded: Boolean get() = status == "concluded"

    fun toJson(): SummonJson = SummonJson.obj(
        "id" to SummonJson.Str(id),
        "name" to SummonJson.Str(name),
        "kind" to SummonJson.Str(kind),
        "members" to SummonJson.Arr(members.map(SummonJson::Str)),
        "status" to SummonJson.Str(status),
        "goal" to SummonJson.Str(goal),
        "summary" to SummonJson.Str(summary),
        "lastMessage" to (lastMessage?.toJson() ?: SummonJson.Null),
        "createdAt" to (createdAt?.let(SummonJson::Str) ?: SummonJson.Null),
    )

    companion object {
        fun parse(json: SummonJson): SummonRoom = SummonRoom(
            id = json["id"].string ?: "",
            name = json["name"].string ?: "会话",
            kind = json["kind"].string ?: "group",
            members = json["members"].array.orEmpty().map { it.stringValue }.filter { it.isNotEmpty() },
            status = json["status"].string ?: "active",
            goal = json["goal"].string ?: "",
            summary = json["summary"].string ?: "",
            lastMessage = if (json["lastMessage"] is SummonJson.Obj) SummonMessage.parse(json["lastMessage"]) else null,
            createdAt = json["createdAt"].string,
        )
    }
}

data class SummonJob(
    val id: String,
    val botId: String,
    val roomId: String,
    val messageId: String?,
    val status: String,
    val taskId: String?,
    val agentRunId: String?,
    val error: SummonJson?,
    val createdAt: String?,
) {
    val isActive: Boolean get() = status in setOf("queued", "accepted", "running", "waiting")
    val errorText: String? get() = error?.stringValue?.takeIf { it.isNotEmpty() }

    companion object {
        fun parse(json: SummonJson): SummonJob = SummonJob(
            id = json["id"].string ?: "",
            botId = json["botId"].string ?: "",
            roomId = json["roomId"].string ?: "",
            messageId = json["messageId"].string,
            status = json["status"].string ?: "",
            taskId = json["taskId"].string,
            agentRunId = json["agentRunId"].string,
            error = json["error"].takeUnless { it is SummonJson.Null },
            createdAt = json["createdAt"].string,
        )
    }
}

data class SummonToolRun(
    val id: String,
    val name: String?,
    val toolName: String?,
    val status: String?,
    val output: SummonJson?,
    val result: SummonJson?,
    val error: SummonJson?,
) {
    val displayName: String get() = name ?: toolName ?: "工具调用"
    val outputText: String get() = output?.stringValue?.takeIf { it.isNotEmpty() }
        ?: result?.stringValue?.takeIf { it.isNotEmpty() }
        ?: error?.stringValue.orEmpty()

    companion object {
        fun parse(json: SummonJson): SummonToolRun = SummonToolRun(
            id = json["id"].string ?: "",
            name = json["name"].string,
            toolName = json["toolName"].string,
            status = json["status"].string,
            output = json["output"].takeUnless { it is SummonJson.Null },
            result = json["result"].takeUnless { it is SummonJson.Null },
            error = json["error"].takeUnless { it is SummonJson.Null },
        )
    }
}

data class SummonArtifact(
    val id: String,
    val name: String?,
    val mimeType: String?,
    val size: Int?,
    val path: String?,
) {
    companion object {
        fun parse(json: SummonJson): SummonArtifact = SummonArtifact(
            id = json["id"].string ?: "",
            name = json["name"].string,
            mimeType = json["mimeType"].string,
            size = json["size"].int,
            path = json["path"].string,
        )
    }
}

data class SummonAgentRun(
    val id: String,
    val botId: String?,
    val roomId: String?,
    val status: String?,
    val summary: String?,
    val content: SummonJson?,
    val result: SummonJson?,
    val error: SummonJson?,
    val toolCount: Int?,
    val tools: List<SummonToolRun>?,
    val createdAt: String?,
    val startedAt: String?,
    val finishedAt: String?,
) {
    val isActive: Boolean get() = (status ?: "") in setOf("queued", "accepted", "running", "waiting")

    fun toJson(): SummonJson = SummonJson.obj(
        "id" to SummonJson.Str(id),
        "botId" to (botId?.let(SummonJson::Str) ?: SummonJson.Null),
        "roomId" to (roomId?.let(SummonJson::Str) ?: SummonJson.Null),
        "status" to (status?.let(SummonJson::Str) ?: SummonJson.Null),
        "summary" to (summary?.let(SummonJson::Str) ?: SummonJson.Null),
        "createdAt" to (createdAt?.let(SummonJson::Str) ?: SummonJson.Null),
        "startedAt" to (startedAt?.let(SummonJson::Str) ?: SummonJson.Null),
        "finishedAt" to (finishedAt?.let(SummonJson::Str) ?: SummonJson.Null),
    )

    companion object {
        fun parse(json: SummonJson): SummonAgentRun = SummonAgentRun(
            id = json["id"].string ?: "",
            botId = json["botId"].string,
            roomId = json["roomId"].string,
            status = json["status"].string,
            summary = json["summary"].string,
            content = json["content"].takeUnless { it is SummonJson.Null },
            result = json["result"].takeUnless { it is SummonJson.Null },
            error = json["error"].takeUnless { it is SummonJson.Null },
            toolCount = json["toolCount"].int,
            tools = json["tools"].array?.map(SummonToolRun::parse),
            createdAt = json["createdAt"].string,
            startedAt = json["startedAt"].string,
            finishedAt = json["finishedAt"].string,
        )
    }
}

data class SummonWorkspace(
    val historyEpoch: String?,
    val bots: List<SummonBot>,
    val rooms: List<SummonRoom>,
    val agentRuns: List<SummonAgentRun>,
    val defaultCwd: String?,
) {
    companion object {
        fun parse(json: SummonJson): SummonWorkspace = SummonWorkspace(
            historyEpoch = json["historyEpoch"].string,
            bots = json["bots"].array.orEmpty().map(SummonBot::parse).filter { it.id.isNotEmpty() },
            rooms = json["rooms"].array.orEmpty().map(SummonRoom::parse).filter { it.id.isNotEmpty() },
            agentRuns = json["agentRuns"].array.orEmpty().map(SummonAgentRun::parse),
            defaultCwd = json["defaultCwd"].string,
        )
    }
}

data class SummonRoomSnapshot(
    val historyEpoch: String?,
    val room: SummonRoom,
    val messages: List<SummonMessage>,
    val jobs: List<SummonJob>,
) {
    companion object {
        fun parse(json: SummonJson): SummonRoomSnapshot = SummonRoomSnapshot(
            historyEpoch = json["historyEpoch"].string,
            room = SummonRoom.parse(json["room"]),
            messages = json["messages"].array.orEmpty().map(SummonMessage::parse),
            jobs = json["jobs"].array.orEmpty().map(SummonJob::parse),
        )
    }
}

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
            message = SummonMessage.parse(json["message"]),
            status = json["status"].string ?: "failed",
            error = json["error"].string,
        )
    }
}

data class SummonConnectionSettings(
    val baseURL: String = "",
    val userName: String = "你",
) {
    fun toJson(): SummonJson = SummonJson.obj(
        "baseURL" to SummonJson.Str(baseURL),
        "userName" to SummonJson.Str(userName),
    )

    companion object {
        fun parse(json: SummonJson): SummonConnectionSettings = SummonConnectionSettings(
            baseURL = json["baseURL"].string ?: "",
            userName = json["userName"].string?.ifBlank { "你" } ?: "你",
        )
    }
}

data class WorkspaceRecord(val id: String, val value: SummonJson)
