import Foundation

struct RelayAvatar: Codable, Equatable, Sendable {
    var shape: String = "cercle"
    var color: String = "#7D824B"
    var image: String?
    var secondary: String?
    var ink: String?
    var paper: String?
    init(shape: String = "cercle", color: String = "#7D824B", image: String? = nil, secondary: String? = nil, ink: String? = nil, paper: String? = nil) {
        self.shape = shape; self.color = color; self.image = image
        self.secondary = secondary; self.ink = ink; self.paper = paper
    }
}

struct RelayBot: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var role: String
    var expertise: String
    var prompt: String
    var status: String
    var presetId: String?
    var roleId: String?
    var avatar: RelayAvatar?
    var createdAt: String?

    var isSystem: Bool { presetId != nil }
    var isPaused: Bool { status == "paused" }
    var resolvedAvatar: RelayAvatar { avatar ?? RelayAvatar.defaultAvatar(for: id) }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? ""
        let value = try c.decodeIfPresent(RelayJSONValue.self, forKey: .expertise)
        expertise = value?.stringValue ?? ""
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "active"
        presetId = try c.decodeIfPresent(String.self, forKey: .presetId)
        roleId = try c.decodeIfPresent(String.self, forKey: .roleId)
        avatar = try c.decodeIfPresent(RelayAvatar.self, forKey: .avatar)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct RelayAttachment: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var mimeType: String
    var size: Int
    var url: String?
    var previewUrl: String?
    var createdAt: String?

    var isImage: Bool { previewUrl != nil }
    var formattedSize: String { ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file) }
}

struct RelayMessage: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var roomId: String
    var senderId: String
    var content: String
    var attachments: [RelayAttachment]
    var kind: String
    var replyTo: String?
    var toBotId: String?
    var clientId: String?
    var jobId: String?
    var createdAt: String?

    var isOwn: Bool { senderId == "user" }

    init(id: String, roomId: String, senderId: String, content: String,
         attachments: [RelayAttachment] = [], kind: String = "message", replyTo: String? = nil,
         toBotId: String? = nil, clientId: String? = nil, jobId: String? = nil, createdAt: String? = nil) {
        self.id = id
        self.roomId = roomId
        self.senderId = senderId
        self.content = content
        self.attachments = attachments
        self.kind = kind
        self.replyTo = replyTo
        self.toBotId = toBotId
        self.clientId = clientId
        self.jobId = jobId
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        roomId = try c.decode(String.self, forKey: .roomId)
        senderId = try c.decodeIfPresent(String.self, forKey: .senderId) ?? "system"
        content = try c.decodeIfPresent(String.self, forKey: .content) ?? ""
        attachments = try c.decodeIfPresent([RelayAttachment].self, forKey: .attachments) ?? []
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "message"
        replyTo = try c.decodeIfPresent(String.self, forKey: .replyTo)
        toBotId = try c.decodeIfPresent(String.self, forKey: .toBotId)
        clientId = try c.decodeIfPresent(String.self, forKey: .clientId)
        jobId = try c.decodeIfPresent(String.self, forKey: .jobId)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct RelayRoom: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var kind: String
    var members: [String]
    var status: String
    var goal: String
    var summary: String
    var lastMessage: RelayMessage?
    var createdAt: String?

    var isGroup: Bool { kind != "dm" }
    var isConcluded: Bool { status == "concluded" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "会话"
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "group"
        members = try c.decodeIfPresent([String].self, forKey: .members) ?? []
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "active"
        goal = try c.decodeIfPresent(String.self, forKey: .goal) ?? ""
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        lastMessage = try c.decodeIfPresent(RelayMessage.self, forKey: .lastMessage)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct RelayJob: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var botId: String
    var roomId: String
    var messageId: String?
    var status: String
    var taskId: String?
    var agentRunId: String?
    var error: RelayJSONValue?
    var createdAt: String?

    var isActive: Bool { ["queued", "accepted", "running", "waiting"].contains(status) }
    var errorText: String? { error?.stringValue }
}

struct RelayAgentRun: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var botId: String?
    var roomId: String?
    var status: String?
    var summary: String?
    var content: RelayJSONValue?
    var result: RelayJSONValue?
    var error: RelayJSONValue?
    var toolCount: Int?
    var tools: [RelayToolRun]?
    var createdAt: String?
    var startedAt: String?
    var finishedAt: String?

    var isActive: Bool { ["queued", "accepted", "running", "waiting"].contains(status ?? "") }
    var outputText: String { summary?.isEmpty == false ? summary! : result?.stringValue ?? content?.stringValue ?? "" }
}

struct RelayToolRun: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String?
    var toolName: String?
    var status: String?
    var arguments: RelayJSONValue?
    var input: RelayJSONValue?
    var output: RelayJSONValue?
    var result: RelayJSONValue?
    var error: RelayJSONValue?
    var artifacts: [RelayArtifact]?
    var createdAt: String?

    var displayName: String { name ?? toolName ?? "工具调用" }
    var outputText: String { output?.stringValue ?? result?.stringValue ?? error?.stringValue ?? "" }
}

struct RelayArtifact: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String?
    var mimeType: String?
    var size: Int?
    var path: String?
}

struct RelayWorkspace: Codable, Sendable {
    var historyEpoch: String?
    var bots: [RelayBot]
    var rooms: [RelayRoom]
    var agentRuns: [RelayAgentRun]?
    var defaultCwd: String?
}

struct RelayRoomSnapshot: Codable, Sendable {
    var historyEpoch: String?
    var room: RelayRoom
    var messages: [RelayMessage]
    var jobs: [RelayJob]
}

struct RelayPendingMessage: Codable, Identifiable, Equatable, Sendable {
    var clientID: String
    var message: RelayMessage
    var status: String
    var error: String?

    var id: String { clientID }
    var roomID: String { message.roomId }
    var content: String { message.content }
    var attachments: [RelayAttachment] { message.attachments }
}

struct RelayConnectionSettings: Codable, Equatable, Sendable {
    var baseURL: String = ""
    var userName: String = "你"
}

enum RelayJSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: RelayJSONValue]), array([RelayJSONValue]), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let value = try? c.decode(String.self) { self = .string(value) }
        else if let value = try? c.decode(Bool.self) { self = .bool(value) }
        else if let value = try? c.decode(Double.self) { self = .number(value) }
        else if let value = try? c.decode([String: RelayJSONValue].self) { self = .object(value) }
        else { self = .array(try c.decode([RelayJSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let value): try c.encode(value)
        case .number(let value): try c.encode(value)
        case .bool(let value): try c.encode(value)
        case .object(let value): try c.encode(value)
        case .array(let value): try c.encode(value)
        case .null: try c.encodeNil()
        }
    }

    var stringValue: String {
        switch self {
        case .string(let value): return value
        case .number(let value): return String(value)
        case .bool(let value): return String(value)
        case .null: return ""
        case .array(let value): return value.map(\.stringValue).joined(separator: "、")
        case .object(let value):
            for key in ["content", "text", "message", "summary"] {
                if let result = value[key], case .string = result { return result.stringValue }
            }
            guard let data = try? JSONEncoder().encode(self) else { return "" }
            return String(data: data, encoding: .utf8) ?? ""
        }
    }

    subscript(_ key: String) -> RelayJSONValue {
        guard case .object(let value) = self else { return .null }
        return value[key] ?? .null
    }

    var string: String? { if case .string(let value) = self { return value }; return nil }
    var array: [RelayJSONValue]? { if case .array(let value) = self { return value }; return nil }
    var object: [String: RelayJSONValue]? { if case .object(let value) = self { return value }; return nil }
    var bool: Bool? { if case .bool(let value) = self { return value }; return nil }
    var int: Int? {
        guard case .number(let value) = self, value.isFinite,
              value >= Double(Int.min), value < Double(Int.max) else { return nil }
        return Int(value)
    }

    var prettyPrinted: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self) else { return stringValue }
        return String(data: data, encoding: .utf8) ?? stringValue
    }
}

extension RelayAvatar {
    static func defaultAvatar(for id: String) -> RelayAvatar {
        let shapes = ["cercle","galet","squircle","capsule","triangle","hexagone","nuage","goutte"]
        let colors = ["#7D824B","#B2634F","#597C91","#A87932","#B2634F","#4D5C69","#867399","#648468"]
        var value: UInt32 = 5381
        for character in id.unicodeScalars { value = (value &* 33) ^ character.value }
        let seeded = ["bot-engineer":"squircle", "bot-components":"hexagone", "bot-qa":"nuage"]
        let role = seeded[id] ?? shapes[Int(value % UInt32(shapes.count))]
        return RelayAvatar(shape: role, color: colors[shapes.firstIndex(of: role) ?? 0])
    }
}

enum RelayDate {
    static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
