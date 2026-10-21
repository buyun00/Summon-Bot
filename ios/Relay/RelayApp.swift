import SwiftUI

@main
struct RelayApp: App {
    @State private var store = RelayStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ConversationListView()
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
