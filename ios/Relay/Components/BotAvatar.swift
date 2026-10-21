import SwiftUI
import UIKit

/// IDs and colors are shared with web/frontend/avatars.js and the Relay API.
enum AvatarPalette {
    static let shapes: [(id: String, label: String)] = [
        ("circle", "圆形"), ("cloud", "云朵"), ("square", "方块"),
        ("star4", "四角星"), ("clover", "四叶草"), ("heart", "爱心"),
        ("flower", "花朵"), ("drop", "水滴"), ("pill", "胶囊"),
        ("triangle", "三角形"), ("pentagon", "小屋"),
        ("star6", "六角星"), ("hexagon", "六边形")
    ]

    static let colors = [
        "#000000", "#A06B39", "#FB2B3E", "#FD690F", "#F59312", "#14C16F",
        "#13B7A2", "#1E86FC", "#8F59F9", "#F93498", "#959595"
    ]
}

struct BotAvatar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let shape: String
    private let color: String
    private let image: String?
    private let size: CGFloat
    private let decodedImage: UIImage?

    init(
        shape: String = "circle",
        color: String = "#8F59F9",
        image: String? = nil,
        size: CGFloat = 48
    ) {
        self.shape = AvatarPalette.shapes.contains { $0.id == shape } ? shape : "circle"
        self.color = color
        self.image = image
        self.size = size.isFinite ? max(8, min(512, size)) : 48
        self.decodedImage = Self.decodeImage(image)
    }

    var body: some View {
        ZStack {
            if let decodedImage {
                Image(uiImage: decodedImage)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: size * 14 / 64))
                    .transition(.opacity)
            } else {
                ZStack {
                    AvatarSilhouette(id: shape)
                        .fill(Color(relayHex: color))
                    AvatarEyes(shifted: Self.shiftedEyes.contains(shape))
                        .fill(.white)
                        .clipShape(AvatarSilhouette(id: shape))
                }
                .id(shape)
                .transition(.opacity.combined(with: .scale(scale: 0.88)))
            }
        }
        .frame(width: size, height: size)
        .animation(transitionAnimation, value: shape)
        .animation(transitionAnimation, value: color)
        .animation(transitionAnimation, value: image)
        .accessibilityHidden(true)
    }

    private var transitionAnimation: Animation? {
        reduceMotion ? nil : .spring(response: 0.36, dampingFraction: 0.76)
    }

    private static let shiftedEyes: Set<String> = [
        "star4", "flower", "drop", "triangle", "pentagon", "star6"
    ]

    /// The API stores inline images; arbitrary remote URLs are not avatar data.
    private static func decodeImage(_ value: String?) -> UIImage? {
        guard let value,
              let separator = value.firstIndex(of: ","),
              ["data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"]
                .contains(String(value[..<separator])) else {
            return nil
        }
        let payload = value[value.index(after: separator)...]
        guard !payload.isEmpty,
              payload.utf8.count.isMultiple(of: 4),
              let data = Data(base64Encoded: String(payload)) else {
            return nil
        }
        return UIImage(data: data)
    }
}

extension Color {
    init(relayHex: String) {
        let value = relayHex.trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = value.hasPrefix("#") ? String(value.dropFirst()) : value
        let rgb = digits.count == 6 ? UInt32(digits, radix: 16) ?? 0x8F59F9 : 0x8F59F9
        self.init(
            .sRGB,
            red: Double((rgb >> 16) & 0xff) / 255,
            green: Double((rgb >> 8) & 0xff) / 255,
            blue: Double(rgb & 0xff) / 255,
            opacity: 1
        )
    }
}

/// Native paths preserve the PWA silhouettes without an SVG or web runtime.
private struct AvatarSilhouette: Shape {
    let id: String

    func path(in rect: CGRect) -> Path {
        var path = Path()
        var rotation: CGFloat = 0

        switch id {
        case "cloud":
            path.move(to: point(9, 31))
            path.addCurve(to: point(17, 12), control1: point(5, 24), control2: point(8, 15))
            path.addCurve(to: point(37, 10), control1: point(22, 6), control2: point(31, 6))
            path.addCurve(to: point(55, 18), control1: point(44, 5), control2: point(54, 10))
            path.addCurve(to: point(57, 39), control1: point(63, 23), control2: point(62, 33))
            path.addCurve(to: point(38, 52), control1: point(58, 49), control2: point(47, 55))
            path.addCurve(to: point(16, 52), control1: point(30, 59), control2: point(20, 56))
            path.addCurve(to: point(9, 31), control1: point(5, 55), control2: point(2, 42))
            path.closeSubpath()

        case "square":
            path.addRoundedRect(in: CGRect(x: 7, y: 7, width: 50, height: 50), cornerSize: CGSize(width: 7, height: 7))
            rotation = -18

        case "star4":
            path.move(to: point(32, 2))
            path.addCurve(to: point(44, 20), control1: point(39, 2), control2: point(41, 17))
            path.addCurve(to: point(62, 32), control1: point(48, 23), control2: point(62, 25))
            path.addCurve(to: point(44, 44), control1: point(62, 39), control2: point(48, 41))
            path.addCurve(to: point(32, 62), control1: point(41, 48), control2: point(39, 62))
            path.addCurve(to: point(20, 44), control1: point(25, 62), control2: point(23, 48))
            path.addCurve(to: point(2, 32), control1: point(16, 41), control2: point(2, 39))
            path.addCurve(to: point(20, 20), control1: point(2, 25), control2: point(16, 23))
            path.addCurve(to: point(32, 2), control1: point(23, 16), control2: point(25, 2))
            path.closeSubpath()
            rotation = -12

        case "clover":
            path.move(to: point(32, 11))
            path.addCurve(to: point(55, 27), control1: point(43, 1), control2: point(60, 10))
            path.addCurve(to: point(37, 55), control1: point(67, 40), control2: point(54, 61))
            path.addCurve(to: point(9, 38), control1: point(23, 67), control2: point(4, 55))
            path.addCurve(to: point(26, 10), control1: point(-2, 24), control2: point(10, 5))
            path.addCurve(to: point(32, 11), control1: point(28, 10), control2: point(30, 10))
            path.closeSubpath()
            rotation = -12

        case "heart":
            path.move(to: point(32, 13))
            path.addCurve(to: point(4, 22), control1: point(21, 1), control2: point(4, 7))
            path.addCurve(to: point(28, 55), control1: point(4, 33), control2: point(18, 44))
            path.addQuadCurve(to: point(37, 55), control: point(32, 60))
            path.addCurve(to: point(60, 22), control1: point(48, 44), control2: point(60, 33))
            path.addCurve(to: point(32, 13), control1: point(60, 7), control2: point(44, 1))
            path.closeSubpath()
            rotation = -20

        case "flower":
            for center in [point(32, 15), point(46.7, 23.5), point(46.7, 40.5), point(32, 49), point(17.3, 40.5), point(17.3, 23.5)] {
                path.addEllipse(in: CGRect(x: center.x - 12, y: center.y - 12, width: 24, height: 24))
            }
            path.addEllipse(in: CGRect(x: 13, y: 13, width: 38, height: 38))
            rotation = -12

        case "drop":
            path.move(to: point(23, 4))
            path.addCurve(to: point(54, 28), control1: point(35, 6), control2: point(49, 16))
            path.addCurve(to: point(35, 60), control1: point(62, 44), control2: point(51, 59))
            path.addCurve(to: point(8, 36), control1: point(20, 61), control2: point(8, 51))
            path.addCurve(to: point(15, 8), control1: point(8, 27), control2: point(12, 14))
            path.addQuadCurve(to: point(23, 4), control: point(17, 3))
            path.closeSubpath()
            rotation = -12

        case "pill":
            path.addRoundedRect(in: CGRect(x: 3, y: 12, width: 58, height: 40), cornerSize: CGSize(width: 20, height: 20))
            rotation = -17

        case "triangle":
            path.move(to: point(11, 10))
            path.addCurve(to: point(23, 7), control1: point(12, 4), control2: point(17, 3))
            path.addLine(to: point(55, 25))
            path.addQuadCurve(to: point(55, 40), control: point(66, 32))
            path.addLine(to: point(22, 57))
            path.addQuadCurve(to: point(8, 51), control: point(9, 65))
            path.closeSubpath()
            rotation = -7

        case "pentagon":
            path.move(to: point(24, 5))
            path.addQuadCurve(to: point(34, 7), control: point(29, 2))
            path.addLine(to: point(51, 23))
            path.addQuadCurve(to: point(55, 34), control: point(56, 27))
            path.addLine(to: point(50, 53))
            path.addQuadCurve(to: point(41, 58), control: point(48, 59))
            path.addLine(to: point(13, 55))
            path.addQuadCurve(to: point(7, 47), control: point(6, 54))
            path.addLine(to: point(10, 22))
            path.addQuadCurve(to: point(16, 11), control: point(11, 15))
            path.closeSubpath()
            rotation = -17

        case "star6":
            for index in 0..<144 {
                let angle = CGFloat(index) * .pi / 72
                let radius = 23 + 5.5 * cos(6 * angle + .pi)
                let vertex = point(32 + cos(angle) * radius, 32 + sin(angle) * radius)
                if index == 0 { path.move(to: vertex) } else { path.addLine(to: vertex) }
            }
            path.closeSubpath()
            rotation = -15

        case "hexagon":
            path.move(to: point(22, 4))
            path.addQuadCurve(to: point(31, 4), control: point(26, 2))
            path.addLine(to: point(47, 10))
            path.addQuadCurve(to: point(54, 17), control: point(52, 12))
            path.addLine(to: point(60, 32))
            path.addQuadCurve(to: point(58, 42), control: point(62, 37))
            path.addLine(to: point(45, 56))
            path.addQuadCurve(to: point(36, 58), control: point(41, 60))
            path.addLine(to: point(18, 54))
            path.addQuadCurve(to: point(11, 48), control: point(13, 53))
            path.addLine(to: point(5, 33))
            path.addQuadCurve(to: point(6, 23), control: point(3, 28))
            path.addLine(to: point(17, 8))
            path.addQuadCurve(to: point(22, 4), control: point(19, 5))
            path.closeSubpath()

        default:
            path.addEllipse(in: CGRect(x: 4.5, y: 4.5, width: 55, height: 55))
        }

        if rotation != 0 {
            path = path.applying(CGAffineTransform(translationX: -32, y: -32))
                .applying(CGAffineTransform(rotationAngle: rotation * .pi / 180))
                .applying(CGAffineTransform(translationX: 32, y: 32))
        }
        return path.applying(CGAffineTransform(scaleX: rect.width / 64, y: rect.height / 64))
            .applying(CGAffineTransform(translationX: rect.minX, y: rect.minY))
    }

    private func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        CGPoint(x: x, y: y)
    }
}

private struct AvatarEyes: Shape {
    let shifted: Bool

    func path(in rect: CGRect) -> Path {
        var path = Path()
        for center in [CGPoint(x: 34.25, y: 25.5), CGPoint(x: 48.25, y: 23.5)] {
            path.addRoundedRect(
                in: CGRect(x: center.x - 3.25, y: center.y - 6.5, width: 6.5, height: 13),
                cornerSize: CGSize(width: 3.25, height: 3.25)
            )
        }
        path = path.applying(CGAffineTransform(translationX: -40, y: -25))
            .applying(CGAffineTransform(rotationAngle: -26 * .pi / 180))
            .applying(CGAffineTransform(translationX: 40, y: 25))
        if shifted {
            path = path.applying(CGAffineTransform(translationX: -4, y: 5))
        }
        return path.applying(CGAffineTransform(scaleX: rect.width / 64, y: rect.height / 64))
            .applying(CGAffineTransform(translationX: rect.minX, y: rect.minY))
    }
}
