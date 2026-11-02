import SwiftUI
import Combine

struct PaperFrame {
    var body: [Double]
    var eyes: [[Double]]
    var alpha: Double
    init(_ value: [String: Any]) {
        body=value["body"] as? [Double] ?? [1,0,0,1,0,0]
        eyes=value["eyes"] as? [[Double]] ?? []
        alpha=value["alpha"] as? Double ?? 1
    }
    func blended(from: PaperFrame, amount: Double) -> PaperFrame {
        var result=self
        func mix(_ a:[Double],_ b:[Double])->[Double] { guard a.count == b.count else { return b }; return zip(a,b).map { pair in pair.0+(pair.1-pair.0)*amount } }
        result.body=mix(from.body,body)
        result.eyes=eyes.enumerated().map { i,eye in i < from.eyes.count ? mix(from.eyes[i],eye) : eye }
        result.alpha=from.alpha+(alpha-from.alpha)*amount
        return result
    }
    var transform: CGAffineTransform { CGAffineTransform(a:body[0],b:body[1],c:body[2],d:body[3],tx:body[4],ty:body[5]) }
}

@MainActor enum PaperLibrary {
    static let ids=["cercle","galet","squircle","capsule","triangle","hexagone","nuage","goutte"]
    static let names=["圆形","卵石","圆角方形","胶囊","三角形","六边形","云朵","水滴"]
    static let data:[String:Any] = {
        guard let url=Bundle.main.url(forResource:"paper-avatars",withExtension:"json"),let bytes=try? Data(contentsOf:url),let value=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any] else { return [:] }
        return value
    }()
    static let models=data["characters"] as? [String:[String:Any]] ?? [:]
    static let templates=data["templates"] as? [[String:String]] ?? []
    static let bodies=models.mapValues { CrewLibrary.path($0["body"] as? [[Any]] ?? []) }
    static let fibers=data["fibers"] as? [[Double]] ?? []
    struct Clip { var duration:Double;var once:Bool;var pingpong:Bool;var rows:[PaperFrame] }
    static let clips:[String:[String:Clip]]=models.mapValues { model in
        (model["frames"] as? [String:[String:Any]] ?? [:]).mapValues { value in
            Clip(duration:value["duration"] as? Double ?? 6.4,once:value["once"] as? Bool ?? false,pingpong:value["pingpong"] as? Bool ?? false,rows:(value["rows"] as? [[String:Any]] ?? []).map(PaperFrame.init))
        }
    }
    static func role(_ shape:String)->String { ids.contains(shape) ? shape : (data["legacyRoles"] as? [String:String])?[shape] ?? "cercle" }
    static func paperColor(_ color:String,shape:String)->String { let raw=color.uppercased();return ids.contains(shape) ? raw : (data["legacyColors"] as? [String:String])?[raw] ?? raw }
    static func frame(role:String,state:String,time:Double)->PaperFrame {
        guard let clip=clips[role]?[state] ?? clips[role]?["idle"],!clip.rows.isEmpty else { return PaperFrame([:]) }
        let position:Double
        if clip.once { position=min(time,clip.duration) }
        else if clip.pingpong { let phase=time.truncatingRemainder(dividingBy:clip.duration*2);position=phase<=clip.duration ? phase : clip.duration*2-phase }
        else { position=time.truncatingRemainder(dividingBy:clip.duration) }
        let x=min(max(0,position)*20,Double(clip.rows.count-1)),lo=Int(x),hi=min(lo+1,clip.rows.count-1)
        return clip.rows[hi].blended(from:clip.rows[lo],amount:x-Double(lo))
    }
    struct Arc {var back:Path;var front:Path;var width:Double;var opacity:Double}
    static let rings:[[Arc]] = {
        let value=data["rings"] as? [String:Any] ?? [:]
        return (value["rows"] as? [[[String:Any]]] ?? []).map { row in row.map { Arc(back:CrewLibrary.path($0["back"] as? [[Any]] ?? []),front:CrewLibrary.path($0["front"] as? [[Any]] ?? []),width:$0["width"] as? Double ?? 1,opacity:$0["opacity"] as? Double ?? 1) } }
    }()
    static func arcs(time:Double)->[Arc] { guard !rings.isEmpty else {return []};return rings[min(Int(time.truncatingRemainder(dividingBy:4.3)*20),rings.count-1)] }
    static func eyeColor(_ color:String,paper:String)->Color {
        let value=UInt32(color.dropFirst(),radix:16) ?? 0
        let light=(Double((value>>16)&255)*0.2126+Double((value>>8)&255)*0.7152+Double(value&255)*0.0722)/255
        return Color(relayHex:light>0.69 ? "#485346" : paper)
    }
}

@MainActor final class PaperMotion:ObservableObject {
    var requested="idle"
    @Published var frame:PaperFrame?
    private(set) var age=0.0
    private var current="idle",currentRole="",previous:PaperFrame?
    func step(role:String,state:String,dt:Double) {
        if role != currentRole {currentRole=role;previous=frame;age=0}
        if state != current {previous=frame;current=state;age=0}
        age+=dt
        let target=PaperLibrary.frame(role:role,state:current,time:age)
        if let previous,age<0.4 {frame=target.blended(from:previous,amount:1-pow(1-age/0.4,5))}
        else {previous=nil;frame=target}
    }
}
