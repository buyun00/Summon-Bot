import Foundation
import Observation
import UIKit
import UserNotifications

@MainActor
@Observable
final class SummonPush {
    static let shared = SummonPush()
    private(set) var status = "尚未启用"
    var destinationRoomID: String?
    private var client: SummonAPIClient?
    private var endpoint: String?
    private var revision = 0
    private var syncingRevision: Int?
    private var deviceToken: String?
    private var pendingRoomID: String?
    private var pendingDeviceID: String?
    private let defaults = UserDefaults.standard
    private var deviceID: String {
        if let value = defaults.string(forKey: "Summon.push.deviceID") { return value }
        let value = UUID().uuidString
        defaults.set(value, forKey: "Summon.push.deviceID")
        return value
    }

    func connect(_ client: SummonAPIClient) async {
        if endpoint != client.baseURL.absoluteString { revision += 1 }
        self.client = client
        endpoint = client.baseURL.absoluteString
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            await enable()
        } else if [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) {
            UIApplication.shared.registerForRemoteNotifications()
            await synchronize()
        } else {
            status = "系统通知已关闭，可在 iPhone 设置中开启"
            try? await unregister()
        }
        if pendingDeviceID == deviceID, let room = pendingRoomID {
            destinationRoomID = room
            pendingRoomID = nil
        }
    }

    func enable() async {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            if granted {
                status = "正在注册推送…"
                UIApplication.shared.registerForRemoteNotifications()
            } else { status = "系统通知已关闭，可在 iPhone 设置中开启" }
        } catch { status = "无法申请通知权限，请稍后重试" }
    }

    func registered(_ data: Data) {
        deviceToken = data.map { String(format: "%02x", $0) }.joined()
        Task { await synchronize() }
    }

    func failed() { status = "推送注册失败，请检查网络后重新打开 App" }

    private func synchronize() async {
        guard syncingRevision != revision, let client, let deviceToken else { return }
        let generation = revision
        let registration = deviceID
        syncingRevision = generation
        defer { if syncingRevision == generation { syncingRevision = nil } }
        do {
            let result = try await client.request(SummonJSONValue.self, path: "/api/push/devices", method: "POST", body: .object([
                "deviceId": .string(registration), "token": .string(deviceToken),
                "bundleId": .string("org.lin0.summon"), "environment": .string("production")
            ]))
            guard generation == revision else {
                try? await unregister(from: client, id: registration)
                return
            }
            status = result["configured"].bool == true ? "已启用新消息推送" : "设备已登记，服务端推送待配置"
        } catch {
            guard generation == revision else { return }
            status = "设备推送登记失败，下次连接时重试"
        }
    }

    private func unregister() async throws {
        guard let client else { return }
        try await unregister(from: client, id: deviceID)
    }

    private func unregister(from client: SummonAPIClient, id: String) async throws {
        _ = try await client.request(SummonJSONValue.self, path: "/api/push/devices", method: "DELETE",
            body: .object(["deviceId": .string(id)]))
    }

    func changeServer() {
        let oldClient = client
        let oldDeviceID = deviceID
        revision += 1
        client = nil; endpoint = nil
        pendingRoomID = nil; pendingDeviceID = nil; destinationRoomID = nil
        defaults.set(UUID().uuidString, forKey: "Summon.push.deviceID")
        if let oldClient { Task { try? await unregister(from: oldClient, id: oldDeviceID) } }
    }

    func open(roomID: String?, deviceID: String?) {
        guard let roomID, !roomID.isEmpty, roomID.count <= 200, let deviceID else { return }
        pendingRoomID = roomID; pendingDeviceID = deviceID
        if client != nil, deviceID == self.deviceID {
            destinationRoomID = roomID; pendingRoomID = nil
        }
    }
}

@MainActor
final class SummonAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        SummonPush.shared.registered(deviceToken)
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        SummonPush.shared.failed()
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        return [.banner, .sound, .list]
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let roomID = response.notification.request.content.userInfo["roomId"] as? String
        let deviceID = response.notification.request.content.userInfo["deviceId"] as? String
        await MainActor.run { SummonPush.shared.open(roomID: roomID, deviceID: deviceID) }
    }
}
