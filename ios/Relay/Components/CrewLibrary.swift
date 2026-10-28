import SwiftUI
import Combine

@MainActor
enum CrewLibrary {
    static let ids = ["dev","art","music","plan","qa","write","ops","research","data","lead","translate","knowledge"]
    static let data: [String: Any] = {
        guard let url = Bundle.main.url(forResource: "little-crew", withExtension: "json"),
              let bytes = try? Data(contentsOf: url), let object = try? JSONSerialization.jsonObject(with: bytes),
              let result = object as? [String: Any] else { return [:] }
        return result
    }()
    static let models = data["characters"] as? [String: [String: Any]] ?? [:]
    static let templates = data["templates"] as? [[String: String]] ?? []
    static func role(_ shape: String) -> String { models[shape] != nil ? shape : (data["legacyRoles"] as? [String: String])?[shape] ?? "dev" }
    static func path(_ ops: [[Any]]) -> Path {
        var path = Path()
        for op in ops {
            func n(_ i: Int) -> CGFloat { (op[i] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 0 }
            switch op.first as? String {
            case "M": path.move(to: CGPoint(x:n(1), y:n(2)))
            case "L": path.addLine(to: CGPoint(x:n(1), y:n(2)))
            case "Q": path.addQuadCurve(to: CGPoint(x:n(3), y:n(4)), control: CGPoint(x:n(1), y:n(2)))
            case "C": path.addCurve(to: CGPoint(x:n(5), y:n(6)), control1: CGPoint(x:n(1), y:n(2)), control2: CGPoint(x:n(3), y:n(4)))
            case "Z": path.closeSubpath()
            default: break
            }
        }
        return path
    }
    struct Part { let body: Path; let patch: Path; let pivot: [Double]; let tone: String }
    static let parts: [String: [Part]] = models.mapValues { model in
        (model["parts"] as? [[String: Any]] ?? []).map { p in
            Part(body:path(p["ops"] as? [[Any]] ?? []), patch:path(p["patchOps"] as? [[Any]] ?? []), pivot:p["pivot"] as? [Double] ?? [64,64], tone:p["tone"] as? String ?? "accent")
        }
    }
    static let details: [String: Path] = models.mapValues { path($0["detailsOps"] as? [[Any]] ?? []) }
    static let clips = models.mapValues { $0["frames"] as? [String: [[Double]]] ?? [:] }
    static func target(role: String, state: String, time: Double) -> [Double] {
        guard let roleClips = clips[role], let frames = roleClips[state] ?? roleClips["idle"], !frames.isEmpty else { return rest }
        let specs = data["states"] as? [String: [String: Any]] ?? [:]
        let duration = specs[state]?["duration"] as? Double ?? 4.8
        let age = state == "done" ? min(time,duration) : time.truncatingRemainder(dividingBy: duration)
        let position = min(age * 24, Double(frames.count-1)), lo = Int(position), hi = min(lo+1,frames.count-1), fraction = position-Double(lo)
        return zip(frames[lo],frames[hi]).map { pair in pair.0 + (pair.1-pair.0)*fraction }
    }
    static let rest: [Double] = [0,0,0,1,1,0,0,1,0,0,0,0,0,0,0]
}

@MainActor
final class CrewMotion: ObservableObject {
    var requested = "idle"
    @Published var values = CrewLibrary.rest
    private var velocity = Array(repeating: 0.0, count: 15)
    private var age = 0.0
    private var state = "idle"
    func step(role: String, state next: String, dt: Double) {
        if next != state { state = next; age = 0 }
        age += dt
        let target = CrewLibrary.target(role:role,state:state,time:age)
        var v = values, remaining = dt
        while remaining > 0 {
            let h = min(remaining,1.0/120)
            for k in v.indices {
                let stiffness = k == 7 ? 1800.0 : 260.0
                velocity[k] += (stiffness*(target[k]-v[k])-2*sqrt(stiffness)*velocity[k])*h
                v[k] += velocity[k]*h
            }
            remaining -= h
        }
        values = v
    }
}
