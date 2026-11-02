import SwiftUI

struct RelayPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var compact = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .scaleEffect(configuration.isPressed && !reduceMotion ? (compact ? 0.9 : 0.975) : 1)
            .opacity(configuration.isPressed ? 0.78 : 1)
            .animation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.66), value: configuration.isPressed)
    }
}

struct GreetingAvatar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let avatar: RelayAvatar
    @State private var appeared = false
    @State private var expression = "expression:heureux"
    @State private var greeting = 0
    var body: some View {
        Button { greeting += 1 } label: {
            BotAvatar(shape: avatar.shape, color: avatar.color, image: avatar.image, size: 148,
                      secondary: avatar.secondary, ink: avatar.ink, paper: avatar.paper, motion: expression)
                .scaleEffect(appeared || reduceMotion ? 1 : 0.08)
                .opacity(appeared || reduceMotion ? 1 : 0)
                .animation(reduceMotion ? nil : .spring(response: 0.7, dampingFraction: 0.58), value: appeared)
        }
        .buttonStyle(RelayPressStyle(compact: true))
        .accessibilityLabel("和 Bot 打招呼")
        .task(id: "\(greeting)-\(reduceMotion)") {
            guard !reduceMotion else { appeared = true; expression = "idle"; return }
            do {
                if !appeared { try await Task.sleep(for: .milliseconds(120)); appeared = true }
                expression = "expression:heureux"
                while !Task.isCancelled {
                    try await Task.sleep(for: .milliseconds(1800)); expression = "idle"
                    try await Task.sleep(for: .seconds(4))
                    expression = ["expression:curieux", "expression:heureux", "expression:attentif"].randomElement()!
                }
            } catch { }
        }
    }
}

// All paper silhouettes share the same cubic path topology, so colours and
// outlines interpolate from the currently displayed frame even after rapid taps.
@MainActor struct PaperLook {
    var commands: [[Any]]
    var channels: [Double]
    var body: Path { CrewLibrary.path(commands) }
    func color(_ slot: Int) -> Color {
        Color(.sRGB, red: channels[slot*3], green: channels[slot*3+1], blue: channels[slot*3+2], opacity: 1)
    }
    static func make(shape: String, color: String, secondary: String?, ink: String?, paper: String?) -> PaperLook {
        let legacy = !PaperLibrary.ids.contains(shape)
        let pigment = PaperLibrary.paperColor(color, shape: shape)
        func rgb(_ hex: String) -> [Double] {
            let value = UInt32(hex.dropFirst(), radix: 16) ?? 0
            return [Double((value>>16)&255)/255, Double((value>>8)&255)/255, Double(value&255)/255]
        }
        let paint = rgb(pigment), light = paint[0]*0.2126 + paint[1]*0.7152 + paint[2]*0.0722
        return PaperLook(commands: PaperLibrary.models[PaperLibrary.role(shape)]?["body"] as? [[Any]] ?? [],
                         channels: paint + rgb(legacy ? "#E6DDC8" : secondary ?? "#E6DDC8")
                            + rgb(legacy ? "#414A3C" : ink ?? "#414A3C")
                            + rgb(light > 0.69 ? "#485346" : legacy ? "#FFFBF0" : paper ?? "#FFFBF0"))
    }
    func blended(from: PaperLook, amount: Double) -> PaperLook {
        guard commands.count == from.commands.count else { return self }
        let path = zip(from.commands, commands).map { old, new -> [Any] in
            guard old.count == new.count else { return new }
            return zip(old, new).map { a, b -> Any in
                if let x = a as? Double, let y = b as? Double { return x + (y-x)*amount }
                return b
            }
        }
        return PaperLook(commands: path, channels: zip(from.channels, channels).map { pair in pair.0 + (pair.1-pair.0)*amount })
    }
}
