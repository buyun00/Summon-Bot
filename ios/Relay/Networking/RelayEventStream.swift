import Foundation

enum RelayStreamEvent: Sendable {
    case connected
    case keepAlive
    case change(type: String?, roomID: String?, botID: String?)
}

/// SSE is a change notification. The server remains authoritative for the next full snapshot.
struct RelayEventStream: Sendable {
    let client: RelayAPIClient

    func consume(_ receive: @escaping @Sendable (RelayStreamEvent) async -> Void) async throws {
        var request = try client.makeRequest(path: "/api/stream")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        // The gateway sends a comment every 20 seconds. A minute without any
        // bytes should reconnect instead of leaving a silent stream for a day.
        request.timeoutInterval = 60
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 86_400
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              http.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("text/event-stream") == true else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw RelayAPIError.http(status, "实时连接失败（\(status)）")
        }
        // SSE uses blank lines as frame delimiters. Parse the bytes explicitly so
        // line adaptation cannot remove those delimiters or join separate events.
        // Receiving HTTP headers alone does not prove that the proxy is streaming.
        var parser = RelaySSEParser()
        for try await byte in bytes {
            try Task.checkCancellation()
            if let event = try parser.append(byte) { await receive(event) }
        }
        try Task.checkCancellation()
        throw URLError(.networkConnectionLost)
    }
}

private struct RelaySSEParser {
    private var line: [UInt8] = []
    private var dataLines: [String] = []
    private var dataBytes = 0
    private var eventName: String?
    private var hasComment = false
    private var previousWasCR = false
    private var firstLine = true

    mutating func append(_ byte: UInt8) throws -> RelayStreamEvent? {
        if previousWasCR {
            previousWasCR = false
            if byte == 0x0A { return nil }
        }
        if byte == 0x0D || byte == 0x0A {
            previousWasCR = byte == 0x0D
            var value = String(decoding: line, as: UTF8.self)
            line.removeAll(keepingCapacity: true)
            if firstLine { firstLine = false; if value.hasPrefix("\u{FEFF}") { value.removeFirst() } }
            return try consumeLine(value)
        }
        guard line.count < 4 * 1024 * 1024 else { throw URLError(.cannotDecodeContentData) }
        line.append(byte)
        return nil
    }

    private mutating func consumeLine(_ value: String) throws -> RelayStreamEvent? {
        if value.isEmpty {
            defer { dataLines.removeAll(keepingCapacity: true); dataBytes = 0; eventName = nil; hasComment = false }
            guard !dataLines.isEmpty else { return hasComment ? .keepAlive : nil }
            let data = Data(dataLines.joined(separator: "\n").utf8)
            let payload = try? JSONDecoder().decode(RelayJSONValue.self, from: data)
            let type = payload?["type"].string ?? eventName
            if type == "connected" { return .connected }
            let roomID = payload?["roomId"].string ?? (type == "room" ? payload?["id"].string : nil)
            return .change(type: type, roomID: roomID, botID: payload?["botId"].string)
        }
        if value.hasPrefix(":") { hasComment = true; return nil }
        let field: String
        var content: String
        if let colon = value.firstIndex(of: ":") {
            field = String(value[..<colon])
            content = String(value[value.index(after: colon)...])
            if content.hasPrefix(" ") { content.removeFirst() }
        } else { field = value; content = "" }
        if field == "data" {
            dataBytes += content.utf8.count
            guard dataBytes <= 4 * 1024 * 1024 else { throw URLError(.cannotDecodeContentData) }
            dataLines.append(content)
        } else if field == "event" { eventName = content }
        return nil
    }
}
