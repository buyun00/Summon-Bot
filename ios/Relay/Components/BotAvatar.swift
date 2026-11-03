import SwiftUI
import UIKit

@MainActor enum AvatarPalette {
    static var shapes:[(id:String,label:String)] {Array(zip(PaperLibrary.ids,PaperLibrary.names)).map {($0.0,$0.1)}}
    static var colors:[String] {PaperLibrary.templates.compactMap {$0["color"]}}
}

struct BotAvatar:View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
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
    var animated:Bool=true
    var groupOutline:Bool=false
    private var role:String {PaperLibrary.role(shape)}
    private var decodedImage:UIImage? {
        guard let image,let comma=image.firstIndex(of:","),["data:image/png;base64","data:image/jpeg;base64","data:image/webp;base64"].contains(String(image[..<comma])),let bytes=Data(base64Encoded:String(image[image.index(after:comma)...])) else {return nil}
        return UIImage(data:bytes)
    }
    var body:some View {
        Group {
            if let bitmap=decodedImage {Image(uiImage:bitmap).resizable().scaledToFill().frame(width:size,height:size).clipShape(RoundedRectangle(cornerRadius:size*0.22)).overlay { if groupOutline { RoundedRectangle(cornerRadius:size*0.22).stroke(.white,lineWidth:8) } }}
            else {Canvas {context,bounds in draw(context,bounds)}}
        }.frame(width:size,height:size).accessibilityHidden(true)
        .task(id: "\(shape)-\(color)-\(secondary ?? "")-\(ink ?? "")-\(paper ?? "")-\(reduceMotion)-\(animated)") {
            let target = PaperLook.make(shape: shape, color: color, secondary: secondary, ink: ink, paper: paper)
            guard let start = look, !reduceMotion else { look = target; return }
            let began = Date.timeIntervalSinceReferenceDate
            while !Task.isCancelled {
                let t = min(1, (Date.timeIntervalSinceReferenceDate - began)/0.42)
                look = target.blended(from: start, amount: 1-pow(1-t,3))
                if t >= 1 { break }
                do { try await Task.sleep(for: .milliseconds(16)) } catch { break }
            }
        }
        .onChange(of:motion,initial:true) {_,value in driver.requested=value}
        .task(id:"\(role)-\(scenePhase)-\(reduceMotion)-\(animated)-\(image == nil)") {
            guard scenePhase == .active,!reduceMotion,animated,decodedImage == nil else {return}
            var last=Date.timeIntervalSinceReferenceDate
            while !Task.isCancelled {
                do {try await Task.sleep(for:.milliseconds(33))} catch {break}
                let now=Date.timeIntervalSinceReferenceDate
                driver.step(role:role,state:driver.requested,dt:min(now-last,0.064));last=now
            }
        }
    }
    private func draw(_ input:GraphicsContext,_ bounds:CGSize) {
        let frame=animated && !reduceMotion ? driver.frame ?? PaperLibrary.frame(role:role,state:motion,time:0) : PaperLibrary.frame(role:role,state:motion,time:0)
        let appearance = look ?? PaperLook.make(shape: shape, color: color, secondary: secondary, ink: ink, paper: paper)
        let body=appearance.body,paint=appearance.color(0),backing=appearance.color(1),edge=appearance.color(2),eyes=appearance.color(3)
        var context=input;context.translateBy(x:bounds.width/2,y:bounds.height/2);context.scaleBy(x:bounds.width/316*1.5,y:bounds.height/316*1.5)
        let arcs=motion == "work" ? PaperLibrary.arcs(time:driver.age) : []
        for arc in arcs {var c=context;c.opacity=arc.opacity;c.stroke(arc.back,with:.color(paint),style:StrokeStyle(lineWidth:arc.width,lineCap:.round))}
        if groupOutline {
            let stroke=StrokeStyle(lineWidth:8*316/(bounds.width*1.5),lineJoin:.round)
            var backOutline=context;backOutline.translateBy(x:4.5,y:5.5);backOutline.rotate(by:.degrees(-3));backOutline.concatenate(frame.transform)
            backOutline.fill(body,with:.color(.white));backOutline.stroke(body,with:.color(.white),style:stroke)
            var outline=context;outline.concatenate(frame.transform);outline.fill(body,with:.color(.white));outline.stroke(body,with:.color(.white),style:stroke)
        }
        var back=context;back.translateBy(x:4.5,y:5.5);back.rotate(by:.degrees(-3));back.concatenate(frame.transform);back.fill(body,with:.color(backing));back.stroke(body,with:.color(Color(relayHex:"#CFC4AB")),lineWidth:0.65)
        var material=context;material.concatenate(frame.transform);material.opacity=frame.alpha;material.fill(body,with:.color(paint));material.stroke(body,with:.color(edge.opacity(0.16)),lineWidth:0.75)
        var grain=material;grain.clip(to:body)
        for fiber in PaperLibrary.fibers {var p=Path();p.move(to:CGPoint(x:fiber[0],y:fiber[1]));p.addLine(to:CGPoint(x:fiber[0]+fiber[2],y:fiber[1]+fiber[3]));grain.stroke(p,with:.color(.white.opacity(0.10)),lineWidth:0.45)}
        var face=context;face.clip(to:body.applying(frame.transform))
        for eye in frame.eyes where eye.count>=11 {
            var c=face;c.opacity=eye[10];c.concatenate(CGAffineTransform(a:eye[4],b:eye[5],c:eye[6],d:eye[7],tx:eye[8],ty:eye[9]))
            c.fill(Path(roundedRect:CGRect(x:eye[0],y:eye[1],width:eye[2],height:eye[3]),cornerRadius:min(eye[2],eye[3])/2),with:.color(eyes))
        }
        for arc in arcs {var c=context;c.opacity=arc.opacity;c.stroke(arc.front,with:.color(paint),style:StrokeStyle(lineWidth:arc.width,lineCap:.round))}
    }
}

extension Color {
    init(relayHex:String) {
        let digits=relayHex.trimmingCharacters(in:.whitespacesAndNewlines).replacingOccurrences(of:"#",with:"")
        let rgb=digits.count == 6 ? UInt32(digits,radix:16) ?? 0x7D824B : 0x7D824B
        self.init(.sRGB,red:Double((rgb>>16)&255)/255,green:Double((rgb>>8)&255)/255,blue:Double(rgb&255)/255,opacity:1)
    }
}
