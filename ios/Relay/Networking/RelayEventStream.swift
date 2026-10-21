import Foundation

enum RelayStreamEvent: Sendable {
    case connected
    case change
}

/// SSE is a change notification. The server remains authoritative for the next full snapshot.
struct RelayEventStream: Sendable {
    let client: RelayAPIClient

    func consume(_ receive: @escaping @Sendable (RelayStreamEvent) async -> Void) async throws {
        var request = try client.makeRequest(path: "/api/stream")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 86_400
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 86_400
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
        await receive(.connected)
        var hasData = false
        for try await line in bytes.lines {
            try Task.checkCancellation()
            if line.isEmpty {
                if hasData { await receive(.change) }
                hasData = false
            } else if line.hasPrefix("data:") {
                hasData = true
            }
        }
        try Task.checkCancellation()
        throw URLError(.networkConnectionLost)
    }
}
