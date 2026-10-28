package org.lin0.relay

data class RelayAvatar(
    val shape: String = "dev",
    val color: String = "#FFC18E",
    val image: String? = null,
    val secondary: String? = null,
    val ink: String? = null,
    val paper: String? = null,
) {
    fun toJson(): RelayJson = RelayJson.obj(
        "shape" to RelayJson.Str(shape),
        "color" to RelayJson.Str(color),
        "image" to (image?.let { RelayJson.Str(it) } ?: RelayJson.Null),
        "secondary" to (secondary?.let { RelayJson.Str(it) } ?: RelayJson.Null),
        "ink" to (ink?.let { RelayJson.Str(it) } ?: RelayJson.Null),
        "paper" to (paper?.let { RelayJson.Str(it) } ?: RelayJson.Null),
    )

    companion object {
        val shapes = CrewLibrary.ids.zip(CrewLibrary.names)

        fun parse(json: RelayJson): RelayAvatar = RelayAvatar(
            shape = json["shape"].string ?: "dev",
            color = json["color"].string ?: "#FFC18E",
            image = json["image"].string,
            secondary = json["secondary"].string,
            ink = json["ink"].string,
            paper = json["paper"].string,
        )

        fun defaultFor(id: String): RelayAvatar {
            var value = 5381L
            for (character in id.codePoints().toArray()) value = ((value * 33) xor character.toLong()) and 0xFFFFFFFFL
            val role = when(id) { "bot-engineer" -> "dev"; "bot-components" -> "plan"; "bot-qa" -> "qa"; else -> CrewLibrary.ids[(value % CrewLibrary.ids.size).toInt()] }
            return RelayAvatar(shape=role, color=CrewLibrary.defaultColors[CrewLibrary.ids.indexOf(role)])
        }
    }
}

data class RelayBot(
    val id: String,
    val name: String,
    val role: String,
    val expertise: String,
    val prompt: String,
    val status: String,
    val presetId: String?,
    val roleId: String?,
    val avatar: RelayAvatar?,
    val createdAt: String?,
) {
    val isSystem: Boolean get() = presetId != null
    val isPaused: Boolean get() = status == "paused"
    val resolvedAvatar: RelayAvatar get() = avatar ?: RelayAvatar.defaultFor(id)

    fun toJson(): RelayJson = RelayJson.obj(
        "id" to RelayJson.Str(id),
        "name" to RelayJson.Str(name),
        "role" to RelayJson.Str(role),
        "expertise" to RelayJson.Str(expertise),
        "prompt" to RelayJson.Str(prompt),
        "status" to RelayJson.Str(status),
        "presetId" to (presetId?.let(RelayJson::Str) ?: RelayJson.Null),
        "roleId" to (roleId?.let(RelayJson::Str) ?: RelayJson.Null),
        "avatar" to (avatar?.toJson() ?: RelayJson.Null),
        "createdAt" to (createdAt?.let(RelayJson::Str) ?: RelayJson.Null),
    )

    companion object {
        fun parse(json: RelayJson): RelayBot = RelayBot(
            id = json["id"].string ?: "",
            name = json["name"].string ?: json["id"].string ?: "",
            role = json["role"].string ?: "",
            expertise = json["expertise"].stringValue,
            prompt = json["prompt"].string ?: "",
            status = json["status"].string ?: "active",
            presetId = json["presetId"].string,
            roleId = json["roleId"].string,
            avatar = if (json["avatar"] is RelayJson.Obj) RelayAvatar.parse(json["avatar"]) else null,
            createdAt = json["createdAt"].string,
        )
    }
}

data class RelayAttachment(
    val id: String,
    val name: String,
    val mimeType: String,
    val size: Int,
    val url: String? = null,
    val previewUrl: String? = null,
    val createdAt: String? = null,
) {
    val isImage: Boolean get() = previewUrl != null

    fun toJson(): RelayJson = RelayJson.obj(
        "id" to RelayJson.Str(id),
        "name" to RelayJson.Str(name),
        "mimeType" to RelayJson.Str(mimeType),
        "size" to RelayJson.Num(size.toDouble()),
        "url" to (url?.let(RelayJson::Str) ?: RelayJson.Null),
        "previewUrl" to (previewUrl?.let(RelayJson::Str) ?: RelayJson.Null),
        "createdAt" to (createdAt?.let(RelayJson::Str) ?: RelayJson.Null),
    )

    companion object {
        fun parse(json: RelayJson): RelayAttachment = RelayAttachment(
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

data class RelayMessage(
    val id: String,
    val roomId: String,
    val senderId: String,
    val content: String,
    val attachments: List<RelayAttachment> = emptyList(),
    val kind: String = "message",
    val replyTo: String? = null,
    val toBotId: String? = null,
    val clientId: String? = null,
    val jobId: String? = null,
    val createdAt: String? = null,
) {
    val isOwn: Boolean get() = senderId == "user"

    fun toJson(): RelayJson = RelayJson.obj(
        "id" to RelayJson.Str(id),
        "roomId" to RelayJson.Str(roomId),
        "senderId" to RelayJson.Str(senderId),
        "content" to RelayJson.Str(content),
        "attachments" to RelayJson.Arr(attachments.map { it.toJson() }),
        "kind" to RelayJson.Str(kind),
        "replyTo" to (replyTo?.let(RelayJson::Str) ?: RelayJson.Null),
        "toBotId" to (toBotId?.let(RelayJson::Str) ?: RelayJson.Null),
        "clientId" to (clientId?.let(RelayJson::Str) ?: RelayJson.Null),
        "jobId" to (jobId?.let(RelayJson::Str) ?: RelayJson.Null),
        "createdAt" to (createdAt?.let(RelayJson::Str) ?: RelayJson.Null),
    )

    companion object {
        fun parse(json: RelayJson): RelayMessage = RelayMessage(
            id = json["id"].string ?: "",
            roomId = json["roomId"].string ?: "",
            senderId = json["senderId"].string ?: "system",
            content = json["content"].string ?: "",
            attachments = json["attachments"].array.orEmpty().map(RelayAttachment::parse),
            kind = json["kind"].string ?: "message",
            replyTo = json["replyTo"].string,
            toBotId = json["toBotId"].string,
            clientId = json["clientId"].string,
            jobId = json["jobId"].string,
            createdAt = json["createdAt"].string,
        )
    }
}

data class RelayRoom(
    val id: String,
    val name: String,
    val kind: String,
    val members: List<String>,
    val status: String,
    val goal: String,
    val summary: String,
    val lastMessage: RelayMessage?,
    val createdAt: String?,
) {
    val isGroup: Boolean get() = kind != "dm"
    val isConcluded: Boolean get() = status == "concluded"

    fun toJson(): RelayJson = RelayJson.obj(
        "id" to RelayJson.Str(id),
        "name" to RelayJson.Str(name),
        "kind" to RelayJson.Str(kind),
        "members" to RelayJson.Arr(members.map(RelayJson::Str)),
        "status" to RelayJson.Str(status),
        "goal" to RelayJson.Str(goal),
        "summary" to RelayJson.Str(summary),
        "lastMessage" to (lastMessage?.toJson() ?: RelayJson.Null),
        "createdAt" to (createdAt?.let(RelayJson::Str) ?: RelayJson.Null),
    )

    companion object {
        fun parse(json: RelayJson): RelayRoom = RelayRoom(
            id = json["id"].string ?: "",
            name = json["name"].string ?: "会话",
            kind = json["kind"].string ?: "group",
            members = json["members"].array.orEmpty().map { it.stringValue }.filter { it.isNotEmpty() },
            status = json["status"].string ?: "active",
            goal = json["goal"].string ?: "",
            summary = json["summary"].string ?: "",
            lastMessage = if (json["lastMessage"] is RelayJson.Obj) RelayMessage.parse(json["lastMessage"]) else null,
            createdAt = json["createdAt"].string,
        )
    }
}

data class RelayJob(
    val id: String,
    val botId: String,
    val roomId: String,
    val messageId: String?,
    val status: String,
    val taskId: String?,
    val agentRunId: String?,
    val error: RelayJson?,
    val createdAt: String?,
) {
    val isActive: Boolean get() = status in setOf("queued", "accepted", "running", "waiting")
    val errorText: String? get() = error?.stringValue?.takeIf { it.isNotEmpty() }

    companion object {
        fun parse(json: RelayJson): RelayJob = RelayJob(
            id = json["id"].string ?: "",
            botId = json["botId"].string ?: "",
            roomId = json["roomId"].string ?: "",
            messageId = json["messageId"].string,
            status = json["status"].string ?: "",
            taskId = json["taskId"].string,
            agentRunId = json["agentRunId"].string,
            error = json["error"].takeUnless { it is RelayJson.Null },
            createdAt = json["createdAt"].string,
        )
    }
}

data class RelayToolRun(
    val id: String,
    val name: String?,
    val toolName: String?,
    val status: String?,
    val output: RelayJson?,
    val result: RelayJson?,
    val error: RelayJson?,
) {
    val displayName: String get() = name ?: toolName ?: "工具调用"
    val outputText: String get() = output?.stringValue?.takeIf { it.isNotEmpty() }
        ?: result?.stringValue?.takeIf { it.isNotEmpty() }
        ?: error?.stringValue.orEmpty()

    companion object {
        fun parse(json: RelayJson): RelayToolRun = RelayToolRun(
            id = json["id"].string ?: "",
            name = json["name"].string,
            toolName = json["toolName"].string,
            status = json["status"].string,
            output = json["output"].takeUnless { it is RelayJson.Null },
            result = json["result"].takeUnless { it is RelayJson.Null },
            error = json["error"].takeUnless { it is RelayJson.Null },
        )
    }
}

data class RelayArtifact(
    val id: String,
    val name: String?,
    val mimeType: String?,
    val size: Int?,
    val path: String?,
) {
    companion object {
        fun parse(json: RelayJson): RelayArtifact = RelayArtifact(
            id = json["id"].string ?: "",
            name = json["name"].string,
            mimeType = json["mimeType"].string,
            size = json["size"].int,
            path = json["path"].string,
        )
    }
}

data class RelayAgentRun(
    val id: String,
    val botId: String?,
    val roomId: String?,
    val status: String?,
    val summary: String?,
    val content: RelayJson?,
    val result: RelayJson?,
    val error: RelayJson?,
    val toolCount: Int?,
    val tools: List<RelayToolRun>?,
    val createdAt: String?,
    val startedAt: String?,
    val finishedAt: String?,
) {
    val isActive: Boolean get() = (status ?: "") in setOf("queued", "accepted", "running", "waiting")

    fun toJson(): RelayJson = RelayJson.obj(
        "id" to RelayJson.Str(id),
        "botId" to (botId?.let(RelayJson::Str) ?: RelayJson.Null),
        "roomId" to (roomId?.let(RelayJson::Str) ?: RelayJson.Null),
        "status" to (status?.let(RelayJson::Str) ?: RelayJson.Null),
        "summary" to (summary?.let(RelayJson::Str) ?: RelayJson.Null),
        "createdAt" to (createdAt?.let(RelayJson::Str) ?: RelayJson.Null),
        "startedAt" to (startedAt?.let(RelayJson::Str) ?: RelayJson.Null),
        "finishedAt" to (finishedAt?.let(RelayJson::Str) ?: RelayJson.Null),
    )

    companion object {
        fun parse(json: RelayJson): RelayAgentRun = RelayAgentRun(
            id = json["id"].string ?: "",
            botId = json["botId"].string,
            roomId = json["roomId"].string,
            status = json["status"].string,
            summary = json["summary"].string,
            content = json["content"].takeUnless { it is RelayJson.Null },
            result = json["result"].takeUnless { it is RelayJson.Null },
            error = json["error"].takeUnless { it is RelayJson.Null },
            toolCount = json["toolCount"].int,
            tools = json["tools"].array?.map(RelayToolRun::parse),
            createdAt = json["createdAt"].string,
            startedAt = json["startedAt"].string,
            finishedAt = json["finishedAt"].string,
        )
    }
}

data class RelayWorkspace(
    val historyEpoch: String?,
    val bots: List<RelayBot>,
    val rooms: List<RelayRoom>,
    val agentRuns: List<RelayAgentRun>,
    val defaultCwd: String?,
) {
    companion object {
        fun parse(json: RelayJson): RelayWorkspace = RelayWorkspace(
            historyEpoch = json["historyEpoch"].string,
            bots = json["bots"].array.orEmpty().map(RelayBot::parse).filter { it.id.isNotEmpty() },
            rooms = json["rooms"].array.orEmpty().map(RelayRoom::parse).filter { it.id.isNotEmpty() },
            agentRuns = json["agentRuns"].array.orEmpty().map(RelayAgentRun::parse),
            defaultCwd = json["defaultCwd"].string,
        )
    }
}

data class RelayRoomSnapshot(
    val historyEpoch: String?,
    val room: RelayRoom,
    val messages: List<RelayMessage>,
    val jobs: List<RelayJob>,
) {
    companion object {
        fun parse(json: RelayJson): RelayRoomSnapshot = RelayRoomSnapshot(
            historyEpoch = json["historyEpoch"].string,
            room = RelayRoom.parse(json["room"]),
            messages = json["messages"].array.orEmpty().map(RelayMessage::parse),
            jobs = json["jobs"].array.orEmpty().map(RelayJob::parse),
        )
    }
}

data class RelayPendingMessage(
    val clientID: String,
    val message: RelayMessage,
    val status: String,
    val error: String? = null,
) {
    val roomID: String get() = message.roomId

    fun toJson(): RelayJson = RelayJson.obj(
        "clientID" to RelayJson.Str(clientID),
        "message" to message.toJson(),
        "status" to RelayJson.Str(status),
        "error" to (error?.let(RelayJson::Str) ?: RelayJson.Null),
    )

    companion object {
        fun parse(json: RelayJson): RelayPendingMessage = RelayPendingMessage(
            clientID = json["clientID"].string ?: json["clientId"].string ?: "",
            message = RelayMessage.parse(json["message"]),
            status = json["status"].string ?: "failed",
            error = json["error"].string,
        )
    }
}

data class RelayConnectionSettings(
    val baseURL: String = "",
    val userName: String = "你",
) {
    fun toJson(): RelayJson = RelayJson.obj(
        "baseURL" to RelayJson.Str(baseURL),
        "userName" to RelayJson.Str(userName),
    )

    companion object {
        fun parse(json: RelayJson): RelayConnectionSettings = RelayConnectionSettings(
            baseURL = json["baseURL"].string ?: "",
            userName = json["userName"].string?.ifBlank { "你" } ?: "你",
        )
    }
}

data class WorkspaceRecord(val id: String, val value: RelayJson)
