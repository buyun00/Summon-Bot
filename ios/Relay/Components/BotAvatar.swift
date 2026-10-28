import SwiftUI
import UIKit

@MainActor
enum AvatarPalette {
    static var shapes: [(id: String, label: String)] { CrewLibrary.ids.map { ($0,CrewLibrary.models[$0]?["name"] as? String ?? $0) } }
    static var colors: [String] { CrewLibrary.templates.compactMap { $0["color"] } }
}

struct BotAvatar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var driver = CrewMotion()
    let shape: String
    let color: String
    var image: String? = nil
    var size: CGFloat = 48
    var secondary: String? = nil
    var ink: String? = nil
    var paper: String? = nil
    var motion: String = "idle"
    var animated: Bool = true
    private var role: String { CrewLibrary.role(shape) }
    private var decodedImage: UIImage? {
        guard let image, let comma = image.firstIndex(of: ","), ["data:image/png;base64","data:image/jpeg;base64","data:image/webp;base64"].contains(String(image[..<comma])), let bytes = Data(base64Encoded: String(image[image.index(after:comma)...])) else { return nil }
        return UIImage(data:bytes)
    }
    var body: some View {
        Group {
            if let uiImage = decodedImage {
                Image(uiImage:uiImage).resizable().scaledToFill().frame(width:size,height:size).clipShape(RoundedRectangle(cornerRadius:size*0.22))
            } else {
                Canvas { context, bounds in draw(context, bounds) }
            }
        }
        .frame(width:size,height:size)
        .accessibilityHidden(true)
        .onChange(of: motion, initial: true) { _, value in driver.requested = value }
        .task(id: "\(role)-\(scenePhase)-\(reduceMotion)-\(animated)-\(image == nil)") {
            guard scenePhase == .active, !reduceMotion, animated, decodedImage == nil else { return }
            var last = Date.timeIntervalSinceReferenceDate
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(33)) } catch { break }
                let now = Date.timeIntervalSinceReferenceDate
                driver.step(role:role,state:driver.requested,dt:min(now-last,0.05)); last=now
            }
        }
    }
    private func draw(_ input: GraphicsContext, _ bounds: CGSize) {
        let q = animated && !reduceMotion ? driver.values : CrewLibrary.rest
        var context = input
        context.scaleBy(x:bounds.width/158,y:bounds.height/158); context.translateBy(x:15,y:19)
        context.translateBy(x:q[0]+64,y:q[1]+75);context.rotate(by:.degrees(q[2]));context.scaleBy(x:q[3],y:q[4]);context.translateBy(x:-64,y:-75)
        let line = Color(relayHex:ink ?? "#142443"), base = Color(relayHex:paper ?? "#FFFAF1")
        let extra = Color(relayHex:secondary ?? (CrewLibrary.models[role]?["secondary"] as? String ?? "#FFE1BA"))
        for (i, part) in (CrewLibrary.parts[role] ?? []).enumerated() {
            var c=context
            let angle=q[10+min(i,2)], dy=role == "data" ? angle*1.4 : 0
            c.translateBy(x:(i == 0 ? -1 : 1)*q[13],y:dy)
            c.translateBy(x:part.pivot[0],y:part.pivot[1]);c.rotate(by:.degrees(angle));c.translateBy(x:-part.pivot[0],y:-part.pivot[1])
            c.fill(part.body,with:.color(base))
            var patch=c;patch.clip(to:part.body);patch.fill(part.patch,with:.color(part.tone == "secondary" ? extra : Color(relayHex:color)))
            c.stroke(part.body,with:.color(line),style:StrokeStyle(lineWidth:5.4,lineCap:.round,lineJoin:.round))
        }
        context.stroke(CrewLibrary.details[role] ?? Path(),with:.color(line),style:StrokeStyle(lineWidth:4.5,lineCap:.round,lineJoin:.round))
        var marks = context
        marks.opacity = min(1,max(0,q[14]))
        var rays = Path(); rays.move(to:CGPoint(x:103,y:16)); rays.addLine(to:CGPoint(x:106,y:8)); rays.move(to:CGPoint(x:113,y:24)); rays.addLine(to:CGPoint(x:120,y:19)); rays.move(to:CGPoint(x:16,y:19)); rays.addLine(to:CGPoint(x:11,y:13))
        marks.stroke(rays,with:.color(line),style:StrokeStyle(lineWidth:3.7,lineCap:.round))
        let eye= CrewLibrary.models[role]?["eyes"] as? [Double] ?? [64,64]
        context.translateBy(x:eye[0]+q[5],y:eye[1]+q[6])
        let smile=min(1,max(0,q[8]));var eyes=context;eyes.opacity=1-smile
        for i in 0..<2 { let ry=max(0.5,6*max(0.06,min(1,q[7]))*(i == 1 ? 1-q[9]*0.38 : 1));let y=(i == 1 ? -2 : 2)*q[9];eyes.fill(Path(ellipseIn:CGRect(x:(i == 1 ? 8.0 : -8.0)-3.3,y:y-ry,width:6.6,height:ry*2)),with:.color(line)) }
        var happy=Path();happy.move(to:CGPoint(x:-12,y:2));happy.addQuadCurve(to:CGPoint(x:-4,y:2),control:CGPoint(x:-8,y:-8));happy.move(to:CGPoint(x:4,y:2));happy.addQuadCurve(to:CGPoint(x:12,y:2),control:CGPoint(x:8,y:-8));context.opacity=smile;context.stroke(happy,with:.color(line),style:StrokeStyle(lineWidth:3.5,lineCap:.round))
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

