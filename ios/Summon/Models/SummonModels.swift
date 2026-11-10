import Foundation

struct SummonAvatar: Codable, Equatable, Sendable {
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

struct SummonActivity: Codable, Equatable, Sendable {
    var label: String
    var motion: String
    var phase: String
    var roomId: String? = nil
}

struct SummonBot: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var role: String
    var expertise: String
    var prompt: String
    var status: String
    var presetId: String?
    var roleId: String?
    var avatar: SummonAvatar?
    var activity: SummonActivity?
    var createdAt: String?

    var isSystem: Bool { presetId != nil }
    var isPaused: Bool { status == "paused" }
    var resolvedAvatar: SummonAvatar { avatar ?? SummonAvatar.defaultAvatar(for: id) }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? ""
        let value = try c.decodeIfPresent(SummonJSONValue.self, forKey: .expertise)
        expertise = value?.stringValue ?? ""
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "active"
        presetId = try c.decodeIfPresent(String.self, forKey: .presetId)
        roleId = try c.decodeIfPresent(String.self, forKey: .roleId)
        avatar = try c.decodeIfPresent(SummonAvatar.self, forKey: .avatar)
        activity = try c.decodeIfPresent(SummonActivity.self, forKey: .activity)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct SummonAttachment: Codable, Identifiable, Equatable, Sendable {
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

struct SummonMessage: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var roomId: String
    var senderId: String
    var content: String
    var attachments: [SummonAttachment]
    var kind: String
    var replyTo: String?
    var toBotId: String?
    var clientId: String?
    var jobId: String?
    var createdAt: String?

    var isOwn: Bool { senderId == "user" }

    init(id: String, roomId: String, senderId: String, content: String,
         attachments: [SummonAttachment] = [], kind: String = "message", replyTo: String? = nil,
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
        attachments = try c.decodeIfPresent([SummonAttachment].self, forKey: .attachments) ?? []
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "message"
        replyTo = try c.decodeIfPresent(String.self, forKey: .replyTo)
        toBotId = try c.decodeIfPresent(String.self, forKey: .toBotId)
        clientId = try c.decodeIfPresent(String.self, forKey: .clientId)
        jobId = try c.decodeIfPresent(String.self, forKey: .jobId)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct SummonRoom: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var kind: String
    var members: [String]
    var status: String
    var goal: String
    var projectMode: String?
    var summary: String
    var lastMessage: SummonMessage?
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
        projectMode = try c.decodeIfPresent(String.self, forKey: .projectMode)
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        lastMessage = try c.decodeIfPresent(SummonMessage.self, forKey: .lastMessage)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct SummonJob: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var botId: String
    var roomId: String
    var messageId: String?
    var status: String
    var taskId: String?
    var agentRunId: String?
    var error: SummonJSONValue?
    var createdAt: String?

    var isActive: Bool { ["queued", "accepted", "running", "waiting"].contains(status) }
    var errorText: String? { error?.stringValue }
}

struct SummonAgentRun: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var botId: String?
    var roomId: String?
    var status: String?
    var summary: String?
    var activity: SummonActivity?
    var content: SummonJSONValue?
    var result: SummonJSONValue?
    var error: SummonJSONValue?
    var toolCount: Int?
    var tools: [SummonToolRun]?
    var createdAt: String?
    var startedAt: String?
    var finishedAt: String?

    var isActive: Bool { ["queued", "accepted", "running", "waiting"].contains(status ?? "") }
    var outputText: String { summary?.isEmpty == false ? summary! : result?.stringValue ?? content?.stringValue ?? "" }
}

struct SummonToolRun: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String?
    var toolName: String?
    var status: String?
    var arguments: SummonJSONValue?
    var input: SummonJSONValue?
    var output: SummonJSONValue?
    var result: SummonJSONValue?
    var error: SummonJSONValue?
    var artifacts: [SummonArtifact]?
    var createdAt: String?

    var displayName: String { name ?? toolName ?? "工具调用" }
    var outputText: String { output?.stringValue ?? result?.stringValue ?? error?.stringValue ?? "" }
}

struct SummonArtifact: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String?
    var mimeType: String?
    var size: Int?
    var path: String?
}

struct SummonWorkspace: Codable, Sendable {
    var historyEpoch: String?
    var bots: [SummonBot]
    var rooms: [SummonRoom]
    var agentRuns: [SummonAgentRun]?
    var defaultCwd: String?
    var onboarding: SummonJSONValue?
    var modelSettings: SummonJSONValue?
}

struct SummonRoomSnapshot: Codable, Sendable {
    var historyEpoch: String?
    var room: SummonRoom
    var messages: [SummonMessage]
    var jobs: [SummonJob]
}

struct SummonPendingMessage: Codable, Identifiable, Equatable, Sendable {
    var clientID: String
    var message: SummonMessage
    var status: String
    var error: String?

    var id: String { clientID }
    var roomID: String { message.roomId }
    var content: String { message.content }
    var attachments: [SummonAttachment] { message.attachments }
}

struct SummonConnectionSettings: Codable, Equatable, Sendable {
    var baseURL: String = ""
    var userName: String = "Lin"
}

enum SummonJSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: SummonJSONValue]), array([SummonJSONValue]), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let value = try? c.decode(String.self) { self = .string(value) }
        else if let value = try? c.decode(Bool.self) { self = .bool(value) }
        else if let value = try? c.decode(Double.self) { self = .number(value) }
        else if let value = try? c.decode([String: SummonJSONValue].self) { self = .object(value) }
        else { self = .array(try c.decode([SummonJSONValue].self)) }
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

    subscript(_ key: String) -> SummonJSONValue {
        guard case .object(let value) = self else { return .null }
        return value[key] ?? .null
    }

    var string: String? { if case .string(let value) = self { return value }; return nil }
    var array: [SummonJSONValue]? { if case .array(let value) = self { return value }; return nil }
    var object: [String: SummonJSONValue]? { if case .object(let value) = self { return value }; return nil }
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

extension SummonAvatar {
    static func defaultAvatar(for id: String) -> SummonAvatar {
        let shapes = ["cercle","galet","squircle","capsule","triangle","hexagone","nuage","goutte"]
        let colors = ["#7D824B","#B2634F","#597C91","#A87932","#B2634F","#4D5C69","#867399","#648468"]
        var value: UInt32 = 5381
        for character in id.unicodeScalars { value = (value &* 33) ^ character.value }
        let seeded = ["bot-engineer":"squircle", "bot-components":"hexagone", "bot-qa":"nuage"]
        let role = seeded[id] ?? shapes[Int(value % UInt32(shapes.count))]
        return SummonAvatar(shape: role, color: colors[shapes.firstIndex(of: role) ?? 0])
    }
}

enum SummonDate {
    static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
