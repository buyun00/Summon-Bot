import SwiftUI
import UIKit

@MainActor enum AvatarPalette {
    static var shapes:[(id:String,label:String)] {Array(zip(PaperLibrary.ids,PaperLibrary.names)).map {($0.0,$0.1)}}
    static var colors:[String] {PaperLibrary.templates.compactMap {$0["color"]}}
}

struct BotAvatar:View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var driver=PaperMotion()
    @State private var look: PaperLook?
    let shape:String
    let color:String
    var image:String?=nil
    var size:CGFloat=48
    var secondary:String?=nil
    var ink:String?=nil
    var paper:String?=nil
    var motion:String="idle"
    var animated:Bool=false
    var groupOutline:Color?=nil
    private var role:String {PaperLibrary.role(shape)}
    private var shouldAnimate:Bool { !reduceMotion && decodedImage == nil && (animated || motion != "idle") }
    @MainActor private static let decodedImageCache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 128
        return cache
    }()
    private var decodedImage:UIImage? {
        guard let image else { return nil }
        let key = image as NSString
        if let cached = Self.decodedImageCache.object(forKey: key) { return cached }
        guard let comma=image.firstIndex(of:","),["data:image/png;base64","data:image/jpeg;base64","data:image/webp;base64"].contains(String(image[..<comma])),let bytes=Data(base64Encoded:String(image[image.index(after:comma)...])), let decoded = UIImage(data:bytes) else {return nil}
        Self.decodedImageCache.setObject(decoded, forKey: key)
        return decoded
    }
    var body:some View {
        let inset = groupOutline == nil ? 0 : min(4, size * 0.08)
        let imageSize = size - inset * 2
        Group {
            if let bitmap=decodedImage {
                Image(uiImage:bitmap).resizable().scaledToFill().frame(width:imageSize,height:imageSize)
                    .clipShape(RoundedRectangle(cornerRadius:imageSize*0.22))
                    .overlay { if let groupOutline { RoundedRectangle(cornerRadius:imageSize*0.22).stroke(groupOutline,lineWidth:inset) } }
                    .padding(inset)
            }
            else {Canvas {context,bounds in draw(context,bounds)}}
        }.frame(width:size,height:size).accessibilityHidden(true)
        .task(id: "\(shape)-\(color)-\(secondary ?? "")-\(ink ?? "")-\(paper ?? "")-\(shouldAnimate)") {
            let target = PaperLook.make(shape: shape, color: color, secondary: secondary, ink: ink, paper: paper)
            guard let start = look, shouldAnimate else { look = target; return }
            let began = Date.timeIntervalSinceReferenceDate
            while !Task.isCancelled {
                let t = min(1, (Date.timeIntervalSinceReferenceDate - began)/0.42)
                look = target.blended(from: start, amount: 1-pow(1-t,3))
                if t >= 1 { break }
                do { try await Task.sleep(for: .milliseconds(16)) } catch { break }
            }
        }
        .onChange(of:motion,initial:true) {_,value in driver.requested=value}
        .task(id:"\(role)-\(scenePhase)-\(shouldAnimate)") {
            guard scenePhase == .active, shouldAnimate else {return}
            var last=Date.timeIntervalSinceReferenceDate
            while !Task.isCancelled {
                do {try await Task.sleep(for:.milliseconds(33))} catch {break}
                let now=Date.timeIntervalSinceReferenceDate
                driver.step(role:role,state:driver.requested,dt:min(now-last,0.064));last=now
            }
        }
    }
    private func draw(_ input:GraphicsContext,_ bounds:CGSize) {
        let frame=shouldAnimate ? driver.frame ?? PaperLibrary.frame(role:role,state:motion,time:0) : PaperLibrary.frame(role:role,state:motion,time:0)
        let appearance = look ?? PaperLook.make(shape: shape, color: color, secondary: secondary, ink: ink, paper: paper)
        let body=frame.outlinePath ?? appearance.body,paint=appearance.color(0),backing=appearance.color(1),edge=appearance.color(2),eyes=appearance.color(3)
        // Keep the silhouette, paper backing and separator inside this member's canvas.
        let inset = groupOutline == nil ? 0 : min(4, size * 0.08)
        let scale = (bounds.width - inset * 2)/316*1.5
        var context=input;context.translateBy(x:bounds.width/2,y:bounds.height/2);context.scaleBy(x:scale,y:scale)
        let arcs=motion == "work" ? PaperLibrary.arcs(time:driver.age) : (frame.effects["arcs"] as? [[String:Any]] ?? []).map { PaperLibrary.Arc(back:CrewLibrary.path($0["back"] as? [[Any]] ?? []),front:CrewLibrary.path($0["front"] as? [[Any]] ?? []),width:$0["width"] as? Double ?? 1,opacity:$0["opacity"] as? Double ?? 1) }
        func drawDots(_ input:GraphicsContext, color dotColor: Color) {
            for dot in frame.effects["dots"] as? [[String:Any]] ?? [] {
                var c=input;c.opacity=dot["alpha"] as? Double ?? 1
                let x=dot["x"] as? Double ?? 0,y=dot["y"] as? Double ?? 0,r=dot["r"] as? Double ?? 0
                if let commands=dot["path"] as? [[Any]] { c.translateBy(x:x,y:y);c.rotate(by:.degrees(dot["rotation"] as? Double ?? 0));c.fill(CrewLibrary.path(commands),with:.color(dotColor)) }
                else { c.fill(Path(ellipseIn:CGRect(x:x-r,y:y-r,width:r*2,height:r*2)),with:.color(dotColor)) }
            }
        }
        let isDarkGlass = colorScheme == .dark
        let pigmentHex = PaperLibrary.paperColor(color, shape: shape)
        let glass = Self.glassStyle(for: pigmentHex, fallback: paint)
        let decoColor = isDarkGlass ? glass.edge : paint
        for arc in arcs {var c=context;c.opacity=arc.opacity;c.stroke(arc.back,with:.color(decoColor),style:StrokeStyle(lineWidth:arc.width,lineCap:.round))}
        if frame.effects["dotsBehind"] as? Bool == true { drawDots(context, color: decoColor) }
        let decorationContext=context
        context.opacity=frame.alpha
        if let groupOutline {
            let stroke=StrokeStyle(lineWidth:inset/scale,lineJoin:.round)
            if !isDarkGlass {
                var backOutline=context;backOutline.translateBy(x:4.5,y:5.5);backOutline.rotate(by:.degrees(-3));backOutline.concatenate(frame.transform)
                backOutline.fill(body,with:.color(groupOutline));backOutline.stroke(body,with:.color(groupOutline),style:stroke)
            }
            var outline=context;outline.concatenate(frame.transform);outline.fill(body,with:.color(groupOutline));outline.stroke(body,with:.color(groupOutline),style:stroke)
        }
        if isDarkGlass {
            var material=context;material.concatenate(frame.transform);material.opacity=frame.alpha
            let gradient = Gradient(stops: [
                .init(color: glass.top, location: 0.0),
                .init(color: glass.mid, location: 0.48),
                .init(color: glass.bottom, location: 1.0)
            ])
            material.fill(body, with: .linearGradient(gradient, startPoint: CGPoint(x: 0, y: -115), endPoint: CGPoint(x: 0, y: 115)))
            material.stroke(body, with: .color(glass.edge), style: StrokeStyle(lineWidth: max(2.2, 2.0 / max(scale, 0.2)), lineJoin: .round))
        } else {
            var back=context;back.translateBy(x:4.5,y:5.5);back.rotate(by:.degrees(-3));back.concatenate(frame.transform);back.fill(body,with:.color(backing));back.stroke(body,with:.color(Color(summonHex:"#CFC4AB")),lineWidth:0.65)
            var material=context;material.concatenate(frame.transform);material.opacity=frame.alpha;material.fill(body,with:.color(paint));material.stroke(body,with:.color(edge.opacity(0.16)),lineWidth:0.75)
            var grain=material;grain.clip(to:body)
            grain.stroke(PaperLibrary.fibersPath,with:.color(.white.opacity(0.10)),lineWidth:0.45)
        }
        let eyeFill = isDarkGlass ? Color.white.opacity(0.96) : eyes
        var face=context;face.clip(to:body.applying(frame.transform))
        for eye in frame.eyes where eye.count>=11 {
            var c=face;c.opacity=eye[10];c.concatenate(CGAffineTransform(a:eye[4],b:eye[5],c:eye[6],d:eye[7],tx:eye[8],ty:eye[9]))
            c.fill(Path(roundedRect:CGRect(x:eye[0],y:eye[1],width:eye[2],height:eye[3]),cornerRadius:min(eye[2],eye[3])/2),with:.color(eyeFill))
        }
        context=decorationContext
        if frame.effects["dotsBehind"] as? Bool != true { drawDots(context, color: decoColor) }
        if let n=frame.effects["notification"] as? [Double],n.count==3 { context.fill(Path(ellipseIn:CGRect(x:n[0]-n[2],y:n[1]-n[2],width:n[2]*2,height:n[2]*2)),with:.color(Color(summonHex:"#6A92BA"))) }
        for arc in arcs {var c=context;c.opacity=arc.opacity;c.stroke(arc.front,with:.color(decoColor),style:StrokeStyle(lineWidth:arc.width,lineCap:.round))}
    }

    private struct GlassPalette {
        let top: Color
        let mid: Color
        let bottom: Color
        let edge: Color
    }

    private static let glassPresets: [String: (String, String, String, String)] = [
        "#867399": ("#C6AEE3", "#9C84BA", "#745D91", "#DEC9F7"),
        "#597C91": ("#8FC1DC", "#6594B0", "#466E87", "#B5DEF3"),
        "#7D824B": ("#BFC680", "#949C5C", "#6A703B", "#DCE3A2"),
        "#B2634F": ("#EC9982", "#C9735B", "#994D39", "#FFBDA9"),
        "#648468": ("#98C49E", "#709D76", "#4E7453", "#BEE4C3"),
        "#4D5C69": ("#8DA3B5", "#637788", "#445463", "#B5C9D9"),
        "#898B80": ("#C2C5B8", "#9A9D90", "#717468", "#DEE1D4"),
        "#BC8053": ("#F2B484", "#CE8E5E", "#9D663D", "#FFD2AE"),
        "#A87932": ("#E4B465", "#BE8C3E", "#8E6322", "#F8D390"),
        "#AF7286": ("#E9A8BE", "#C47E96", "#94566B", "#FFCADE"),
        "#927057": ("#CCA68A", "#A68064", "#7C5B44", "#E7C6AE"),
        "#DED1B2": ("#F7EDD4", "#DCD0B3", "#B0A282", "#FFF8E6")
    ]

    private static func glassStyle(for hex: String, fallback: Color) -> GlassPalette {
        let key = hex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if let preset = glassPresets[key] {
            return GlassPalette(
                top: Color(summonHex: preset.0).opacity(0.86),
                mid: Color(summonHex: preset.1).opacity(0.76),
                bottom: Color(summonHex: preset.2).opacity(0.88),
                edge: Color(summonHex: preset.3).opacity(0.76)
            )
        }
        let digits = key.replacingOccurrences(of: "#", with: "")
        guard digits.count == 6, let rgb = UInt32(digits, radix: 16) else {
            return GlassPalette(top: fallback.opacity(0.86), mid: fallback.opacity(0.74), bottom: fallback.opacity(0.88), edge: Color.white.opacity(0.62))
        }
        let r = Double((rgb >> 16) & 255) / 255
        let g = Double((rgb >> 8) & 255) / 255
        let b = Double(rgb & 255) / 255
        func mix(_ c: Double, to target: Double, _ t: Double) -> Double { min(1, max(0, c + (target - c) * t)) }
        return GlassPalette(
            top: Color(.sRGB, red: mix(r, to: 1, 0.36), green: mix(g, to: 1, 0.36), blue: mix(b, to: 1, 0.36), opacity: 0.86),
            mid: Color(.sRGB, red: mix(r, to: 1, 0.14), green: mix(g, to: 1, 0.14), blue: mix(b, to: 1, 0.14), opacity: 0.76),
            bottom: Color(.sRGB, red: mix(r, to: 0, 0.16), green: mix(g, to: 0, 0.16), blue: mix(b, to: 0, 0.16), opacity: 0.88),
            edge: Color(.sRGB, red: mix(r, to: 1, 0.54), green: mix(g, to: 1, 0.54), blue: mix(b, to: 1, 0.54), opacity: 0.76)
        )
    }
}

extension Color {
    init(summonHex:String) {
        let digits=summonHex.trimmingCharacters(in:.whitespacesAndNewlines).replacingOccurrences(of:"#",with:"")
        let rgb=digits.count == 6 ? UInt32(digits,radix:16) ?? 0x7D824B : 0x7D824B
        self.init(.sRGB,red:Double((rgb>>16)&255)/255,green:Double((rgb>>8)&255)/255,blue:Double(rgb&255)/255,opacity:1)
    }
}
