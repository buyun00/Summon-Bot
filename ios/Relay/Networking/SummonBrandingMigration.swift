import Foundation

enum SummonBrandingMigration {
    static func run() throws {
        let defaults = UserDefaults.standard
        for (previous, current) in [
            ("RelayNative.connection.v1", "SummonNative.connection.v1"),
            ("RelayNative.display.zoom", "SummonNative.display.zoom"),
            ("RelayNative.display.font", "SummonNative.display.font")
        ] {
            guard let value = defaults.object(forKey: previous) else { continue }
            if defaults.object(forKey: current) == nil { defaults.set(value, forKey: current) }
            defaults.removeObject(forKey: previous)
        }
        try SummonKeychain.migrateStorage()
    }
}
