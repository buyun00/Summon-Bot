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

struct SummonReference: Codable, Hashable, Identifiable, Sendable {
    let kind: String
    let id: String
    let workspaceId: String?
    let filePath: String?

    var path: String? {
        if kind == "workspace_file", let ws = workspaceId, let fp = filePath, !ws.isEmpty, !fp.isEmpty {
            return "/api/workspaces/\(SummonAPIClient.component(ws))/file?path=\(SummonAPIClient.component(fp))"
        }
        let part = SummonAPIClient.component(id)
        switch kind {
        case "session", "conversation": return "/api/executions/\(kind)/\(part)"
        case "file": return "/api/files/\(part)"
        case "room": return "/api/rooms/\(part)"
        case "bot": return "/api/bots/\(part)"
        case "connection": return "/api/connections/\(part)"
        case "call": return "/api/calls/\(part)"
        case "workspace": return "/api/workspaces/\(part)"
        default: return nil
        }
    }

    var json: SummonJSONValue {
        if kind == "workspace_file", let ws = workspaceId, let fp = filePath {
            return .object(["kind": .string(kind), "workspace_id": .string(ws), "path": .string(fp)])
        }
        return .object(["kind": .string(kind), "id": .string(id)])
    }

    private enum CodingKeys: String, CodingKey {
        case kind, id
        case workspaceId = "workspace_id"
        case filePath = "path"
    }

    init(kind: String, id: String, workspaceId: String? = nil, filePath: String? = nil) {
        self.kind = kind
        self.id = id
        self.workspaceId = workspaceId
        self.filePath = filePath
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(String.self, forKey: .kind)
        workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
        filePath = try c.decodeIfPresent(String.self, forKey: .filePath)
        if let decodedId = try c.decodeIfPresent(String.self, forKey: .id), !decodedId.isEmpty {
            id = decodedId
        } else if kind == "workspace_file", let ws = workspaceId, let fp = filePath {
            id = "\(ws):\(fp)"
        } else {
            id = ""
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        if kind == "workspace_file", let ws = workspaceId, let fp = filePath {
            try c.encode(ws, forKey: .workspaceId)
            try c.encode(fp, forKey: .filePath)
        } else {
            try c.encode(id, forKey: .id)
        }
    }

    init?(_ json: SummonJSONValue) {
        guard let kind = json["kind"].string else { return nil }
        if kind == "workspace_file" {
            guard let ws = json["workspace_id"].string, !ws.isEmpty,
                  let fp = json["path"].string, !fp.isEmpty else { return nil }
            self.init(kind: kind, id: "\(ws):\(fp)", workspaceId: ws, filePath: fp)
            return
        }
        guard let id = json["id"].string, !id.isEmpty else { return nil }
        self.init(kind: kind, id: id)
    }
}

struct SummonBot: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var role_id: String?
    var home_room_id: String?
    var instructions: String?
    var model: SummonJSONValue?
    var revision: Int?
    var enabled: Bool?
    var control: SummonJSONValue?
    var resume_ref: SummonJSONValue?
    var material_index_ref: SummonReference?
    var memory_items: [SummonJSONValue]?
    var activity: String?
    var avatar: SummonAvatar?

    var isPaused: Bool { enabled == false || control?["state"].string == "paused" || activity == "paused" }
    var resolvedActivity: String {
        if isPaused { return "paused" }
        return activity ?? "idle"
    }
    var activityMotion: String {
        switch resolvedActivity {
        case "paused": "sleep"
        case "working": "work"
        case "error": "failed"
        default: "idle"
        }
    }
    var resolvedAvatar: SummonAvatar { avatar ?? SummonAvatar.defaultAvatar(for: id) }
}

struct SummonAttachment: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var mimeType: String?
    var size: Int?
    var revision: Int?
    var url: String?
    var previewUrl: String?
    var unavailable: Bool?
    var staged: Bool?

    var isImage: Bool { previewUrl != nil }
    var formattedSize: String { size.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) } ?? "" }
    var downloadPath: String {
        if let url, url.hasPrefix("/api/files/") { return url }
        return "/api/attachments/\(SummonAPIClient.component(id))"
    }
}

struct SummonMessage: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var roomId: String
    var senderId: String
    var content: String
    var attachments: [SummonAttachment]
    var references: [SummonReference]
    var mentions: [String]
    var replyTo: String?
    var clientId: String?
    var createdAt: String?
    var sequence: Int?
    var prompt: SummonJSONValue?
    var promptResponse: SummonJSONValue?
    var promptAnswer: SummonJSONValue?

    var isOwn: Bool { senderId == "user" }

    init(id: String, roomId: String, senderId: String, content: String, attachments: [SummonAttachment] = [],
         references: [SummonReference] = [], mentions: [String] = [], replyTo: String? = nil,
         clientId: String? = nil, createdAt: String? = nil, prompt: SummonJSONValue? = nil,
         promptResponse: SummonJSONValue? = nil, promptAnswer: SummonJSONValue? = nil) {
        self.id = id
        self.roomId = roomId
        self.senderId = senderId
        self.content = content
        self.attachments = attachments
        self.references = references
        self.mentions = mentions
        self.replyTo = replyTo
        self.clientId = clientId
        self.createdAt = createdAt
        self.prompt = prompt
        self.promptResponse = promptResponse
        self.promptAnswer = promptAnswer
    }

    // The previous on-device snapshot stored a single target. Import it as a mention.
    private enum StoredFields: String, CodingKey { case toBotId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        roomId = try c.decode(String.self, forKey: .roomId)
        senderId = try c.decodeIfPresent(String.self, forKey: .senderId) ?? "platform"
        content = try c.decodeIfPresent(String.self, forKey: .content) ?? ""
        attachments = try c.decodeIfPresent([SummonAttachment].self, forKey: .attachments) ?? []
        references = try c.decodeIfPresent([SummonReference].self, forKey: .references) ?? []
        if let values = try c.decodeIfPresent([String].self, forKey: .mentions) { mentions = values }
        else {
            let stored = try decoder.container(keyedBy: StoredFields.self)
            mentions = try stored.decodeIfPresent(String.self, forKey: .toBotId).map { [$0] } ?? []
        }
        replyTo = try c.decodeIfPresent(String.self, forKey: .replyTo)
        clientId = try c.decodeIfPresent(String.self, forKey: .clientId)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        sequence = try c.decodeIfPresent(Int.self, forKey: .sequence)
        prompt = try c.decodeIfPresent(SummonJSONValue.self, forKey: .prompt)
        promptResponse = try c.decodeIfPresent(SummonJSONValue.self, forKey: .promptResponse)
        promptAnswer = try c.decodeIfPresent(SummonJSONValue.self, forKey: .promptAnswer)
    }
}

struct SummonRoom: Codable, Identifiable, Equatable, Sendable {
    var deletable: Bool?
    var id: String
    var name: String
    var members: [String]
    var lead_bot_id: String?
    var pins: [SummonReference]?
    var revision: Int?
    var lastMessage: SummonMessage?
    var createdAt: String?
    var updatedAt: String?

    var isGroup: Bool { members.count != 2 || !members.contains("user") }
}

struct SummonDelivery: Codable, Sendable {
    var bot_id: String
    var status: String
    var fast_read_diagnostic: FastReadDiagnostic?

    struct FastReadDiagnostic: Codable, Sendable {
        var message: String
    }
}

struct SummonMessageSummary: Codable, Equatable, Sendable {
    var bot_id: String
    var summary: String
    var updated_at: String?
}

struct SummonRoomActivity: Codable, Equatable, Sendable, Identifiable {
    var bot_id: String
    var phase: String?
    var text: String
    var work_summary: String?
    var execution_ref: SummonReference?
    var started_at: String?
    var updated_at: String?
    var id: String { bot_id }
}

struct SummonReceipt: Decodable, Sendable {
    var message: SummonMessage
    var deliveries: [SummonDelivery]
}

struct SummonState: Decodable, Sendable {
    var historyEpoch: String?
    var bots: [SummonBot]
    var rooms: [SummonRoom]
    var modelSettings: SummonJSONValue?
}

struct SummonRoomSnapshot: Decodable, Sendable {
    var historyEpoch: String?
    var room: SummonRoom
    var messages: [SummonMessage]
    var deliveries: [String: [SummonDelivery]]?
    var summaries: [String: [SummonMessageSummary]]?
    var activities: [SummonRoomActivity]?
    var suspendedRuns: [SummonJSONValue]?
    var messageStates: [String: SummonJSONValue]?
    var cursor: String?
}

struct SummonBootstrap: Decodable, Equatable, Sendable {
    let protocolVersion: Int
    let updating: Bool
    let version: String?
    let releasesUrl: String?

    var ready: Bool { protocolVersion == SummonAPIClient.protocolVersion }

    var notice: String? {
        if updating { return "服务正在更新。草稿和待确认的发送已保留。" }
        if protocolVersion > SummonAPIClient.protocolVersion { return "请在 TestFlight 更新 Summon Bot。" }
        if protocolVersion < SummonAPIClient.protocolVersion { return "正在等待服务更新。草稿和待确认的发送已保留。" }
        return nil
    }
}

struct SummonInputOption: Identifiable {
    let kind: String
    let target: SummonJSONValue
    let question: String?
    let choices: [SummonJSONValue]

    var id: String { kind + target.prettyPrinted }
    var label: String {
        switch kind {
        case "reply": return "回答"
        case "steer": return "运行中补充"
        default: return "发送下一轮输入"
        }
    }

    static func options(_ detail: SummonJSONValue) -> [Self] {
        (detail["input_targets"].array ?? []).flatMap { option -> [Self] in
            let target = option["input_target"]
            guard target.object != nil else { return [] }
            let request = target["request_id"].string.flatMap { id in
                detail["pending_input"].array?.first { $0["id"].string == id }
            }
            return (option["kinds"].array ?? []).compactMap { value in
                guard let kind = value.string, ["reply", "steer", "next"].contains(kind) else { return nil }
                return Self(kind: kind, target: target, question: option["question"].string ?? request?["question"].string ?? request?["prompt"].string,
                    choices: option["choices"].array ?? request?["choices"].array ?? [])
            }
        }
    }
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
