import SwiftUI

@main
struct SummonApp: App {
    @UIApplicationDelegateAdaptor(SummonAppDelegate.self) private var appDelegate
    @State private var store = SummonStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            SummonDisplayContainer {
                if store.settings.baseURL.isEmpty { SummonConnectionGuideView() }
                else { ConversationListView() }
            }
                .environment(store)
                .preferredColorScheme(.dark)
                .tint(.white)
                .task { await store.start() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await store.reconnect() } }
                    if phase == .background { store.disconnect() }
                }
        }
    }
}
