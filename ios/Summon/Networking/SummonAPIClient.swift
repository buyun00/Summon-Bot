import Foundation

enum SummonAPIError: LocalizedError, Sendable {
    case invalidURL
    case noConnection
    case http(Int, String, code: String? = nil)
    case protocolUnavailable(String)
    case invalidResponse
    case invalidReceipt
    case attachmentTooLarge
    case tooManyAttachments
    case emptyMessage
    case missingAttachment

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "请输入完整的 Summon Bot 服务地址，例如 https://summon.example.com。"
        case .noConnection: return "请先在设置中连接 Summon Bot 服务。"
        case .http(let status, let message, _): return message.isEmpty ? "请求失败（\(status)）" : message
        case .protocolUnavailable(let message): return message
        case .invalidResponse: return "服务返回了无法读取的内容，请确认地址指向 Summon Bot 服务。"
        case .invalidReceipt: return "消息尚未确认送达，请手动重试确认。"
        case .attachmentTooLarge: return "附件不能超过 20 MB。"
        case .tooManyAttachments: return "每条消息最多附加 8 个文件。"
        case .emptyMessage: return "请输入消息或添加附件或引用。"
        case .missingAttachment: return "本机暂存的附件已不可用。"
        }
    }

    var interruptsProtocol: Bool {
        switch self {
        case .http(426, _, _), .http(503, _, "updating"): return true
        default: return false
        }
    }
}

/// Native API calls use the same JSON routes as the existing web client.
/// A Web URL uses its existing gateway proxy; a direct gateway URL requires its controller token.
final class SummonConnectionProbe: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct SummonAPIClient: Sendable {
    static let protocolVersion = 3
    static let defaultHubURL = "https://bot.lin0.org"
    let baseURL: URL
    let nodeID: String?
    private let token: String
    private let session: URLSession

    init(baseURL: URL, token: String, nodeID: String? = nil) {
        self.baseURL = baseURL
        self.token = token
        self.nodeID = nodeID
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 180
        configuration.waitsForConnectivity = true
        self.session = URLSession(configuration: configuration, delegate: SummonConnectionProbe(), delegateQueue: nil)
    }

    func forNode(_ id: String?) -> SummonAPIClient {
        SummonAPIClient(baseURL: baseURL, token: token, nodeID: id)
    }

    func hubLogin(username: String, password: String) async throws -> SummonHubAuthResponse {
        try await request(SummonHubAuthResponse.self, path: "/hub/auth/login", method: "POST", body: .object([
            "username": .string(username),
            "password": .string(password),
            "clientType": .string("ios"),
            "deviceLabel": .string("iPhone"),
        ]))
    }

    func hubRegister(inviteCode: String, username: String, password: String, displayName: String?) async throws -> SummonHubAuthResponse {
        var obj: [String: SummonJSONValue] = [
            "inviteCode": .string(inviteCode),
            "username": .string(username),
            "password": .string(password),
            "clientType": .string("ios"),
            "deviceLabel": .string("iPhone"),
        ]
        if let displayName, !displayName.isEmpty { obj["displayName"] = .string(displayName) }
        return try await request(SummonHubAuthResponse.self, path: "/hub/auth/register", method: "POST", body: .object(obj))
    }

    func hubNodes() async throws -> [SummonHubNode] {
        try await request(SummonHubNodesResponse.self, path: "/hub/nodes").nodes
    }

    func hubLogout() async {
        _ = try? await request(SummonJSONValue.self, path: "/hub/auth/logout", method: "POST", body: .object([:]))
    }

    static func normalizedURL(_ value: String) throws -> URL {
        let cleaned = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: cleaned),
              ["https", "http"].contains(components.scheme?.lowercased() ?? ""),
              components.host?.isEmpty == false,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil else { throw SummonAPIError.invalidURL }
        while components.path.hasSuffix("/") { components.path.removeLast() }
        guard let url = components.url else { throw SummonAPIError.invalidURL }
        return url
    }

    static func component(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    func bootstrap(probe: Bool = false) async throws -> SummonBootstrap {
        let request = try makeRequest(path: "/api/bootstrap")
        let requester: URLSession
        if probe {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 10
            configuration.timeoutIntervalForResource = 12
            requester = URLSession(configuration: configuration, delegate: SummonConnectionProbe(), delegateQueue: nil)
        } else {
            requester = session
        }
        defer { if probe { requester.finishTasksAndInvalidate() } }
        let (data, response) = try await requester.data(for: request)
        try validate(response: response, data: data)
        guard let result = try? JSONDecoder().decode(SummonBootstrap.self, from: data) else { throw SummonAPIError.invalidResponse }
        return result
    }

    func makeRequest(path: String, method: String = "GET", body: SummonJSONValue? = nil, clientID: String? = nil) throws -> URLRequest {
        guard (path.hasPrefix("/api/") || path.hasPrefix("/hub/") || path.hasPrefix("/nodes/")), !path.contains("\\") else {
            throw SummonAPIError.invalidURL
        }
        let resolvedPath: String
        if path.hasPrefix("/api/"), let nodeID, !nodeID.isEmpty {
            resolvedPath = "/nodes/\(Self.component(nodeID))\(path)"
        } else {
            resolvedPath = path
        }
        guard let components = URLComponents(string: baseURL.absoluteString + resolvedPath),
              let url = components.url else { throw SummonAPIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !path.hasPrefix("/hub/") && path != "/api/bootstrap" {
            request.setValue(String(Self.protocolVersion), forHTTPHeaderField: "X-Summon-Protocol")
        }
        if let clientID { request.setValue(clientID, forHTTPHeaderField: "X-Summon-Client-Id") }
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        return request
    }

    func request<T: Decodable & Sendable>(_ type: T.Type, path: String,
                                         method: String = "GET", body: SummonJSONValue? = nil, clientID: String? = nil) async throws -> T {
        let request = try makeRequest(path: path, method: method, body: body ?? (["GET", "HEAD"].contains(method) ? nil : .object([:])), clientID: clientID)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw SummonAPIError.invalidResponse }
    }

    func upload(data: Data, name: String, mimeType: String, clientID: String) async throws -> SummonAttachment {
        guard data.count <= 20 * 1024 * 1024 else { throw SummonAPIError.attachmentTooLarge }
        return try await request(SummonAttachment.self, path: "/api/attachments", method: "POST", body: .object([
            "name": .string(name), "mimeType": .string(mimeType), "data": .string(data.base64EncodedString())
        ]), clientID: clientID)
    }

    func attachmentRequest(_ attachment: SummonAttachment, preview: Bool = false) throws -> URLRequest {
        try makeRequest(path: "/api/attachments/\(Self.component(attachment.id))\(preview ? "/preview" : "")")
    }

    func download(path: String, name: String) async throws -> URL {
        let request = try makeRequest(path: path)
        let (temporaryURL, response) = try await session.download(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let data = try? Data(contentsOf: temporaryURL)
            try validate(response: response, data: data ?? Data())
            throw SummonAPIError.invalidResponse
        }
        let fm = FileManager.default
        let root = try fm.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appending(path: "SummonDownloads").appending(path: UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let safeName = name.components(separatedBy: CharacterSet(charactersIn: "/\\").union(.controlCharacters)).joined(separator: "_")
        let fileURL = root.appending(path: safeName.isEmpty || [".", ".."].contains(safeName) ? "附件" : safeName)
        try fm.moveItem(at: temporaryURL, to: fileURL)
        try? fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: fileURL.path)
        return fileURL
    }

    func attachmentData(_ attachment: SummonAttachment, preview: Bool = true) async throws -> Data {
        let request = try attachmentRequest(attachment, preview: preview)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return data
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw SummonAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw Self.responseError(http, data: data)
        }
    }

    static func responseError(_ response: HTTPURLResponse, data: Data) -> SummonAPIError {
        let status = response.statusCode
        if (300..<400).contains(status) {
            return .http(status, "服务返回重定向，请在设置中填写最终服务地址。")
        }
        let error = try? JSONDecoder().decode(SummonJSONValue.self, from: data)
        return .http(status, error?["error"].stringValue ?? "", code: error?["code"].string)
    }
}
