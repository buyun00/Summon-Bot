import Foundation
import Security

enum SummonKeychain {
    private static let service = "app.summon.native.connection"

    static func migrateStorage() throws {
        let previous: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "app.relay.native.connection"
        ]
        let query = previous.merging([
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]) { _, new in new }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        guard let items = result as? [[String: Any]] else { throw KeychainError(status: errSecDecode) }
        for item in items {
            guard let endpoint = item[kSecAttrAccount as String] as? String,
                  let data = item[kSecValueData as String] as? Data else { throw KeychainError(status: errSecDecode) }
            let insert: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: endpoint,
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            ]
            let added = SecItemAdd(insert as CFDictionary, nil)
            guard added == errSecSuccess || added == errSecDuplicateItem else { throw KeychainError(status: added) }
            let remove = previous.merging([kSecAttrAccount as String: endpoint]) { _, new in new }
            let deleted = SecItemDelete(remove as CFDictionary)
            guard deleted == errSecSuccess || deleted == errSecItemNotFound else { throw KeychainError(status: deleted) }
        }
    }

    static func token(for endpoint: String) -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: endpoint,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    static func save(token: String, for endpoint: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: endpoint
        ]
        if token.isEmpty {
            let status = SecItemDelete(query as CFDictionary)
            if status != errSecSuccess && status != errSecItemNotFound { throw KeychainError(status: status) }
            return
        }
        let attributes: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let result = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            if result != errSecSuccess { throw KeychainError(status: result) }
        } else if status != errSecSuccess { throw KeychainError(status: status) }
    }

    private struct KeychainError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "无法保存连接凭据（\(status)），请在设备解锁后重试。" }
    }
}
