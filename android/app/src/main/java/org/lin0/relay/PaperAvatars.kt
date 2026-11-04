package org.lin0.relay

import android.content.Context
import android.graphics.Path
import org.json.JSONObject
import org.json.JSONArray
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import kotlinx.coroutines.isActive
import kotlin.math.*

private data class PaperLook(val points: FloatArray, val colors: List<Color>) {
    fun blend(from: PaperLook, amount: Float) = PaperLook(
        FloatArray(points.size) { from.points[it] + (points[it]-from.points[it])*amount },
        colors.mapIndexed { index, color -> lerp(from.colors[index], color, amount) })
    fun path() = Path().apply {
        moveTo(points[0],points[1])
        var i=2
        while(i+5<points.size){cubicTo(points[i],points[i+1],points[i+2],points[i+3],points[i+4],points[i+5]);i+=6}
        close()
    }
    companion object {
        fun make(context: Context, shape: String, color: String, secondary: String?, ink: String?, paper: String?): PaperLook {
            val commands=PaperLibrary.data(context).getJSONObject("characters").getJSONObject(PaperLibrary.role(shape)).getJSONArray("body")
            val values=mutableListOf<Float>()
            for(i in 0 until commands.length()){val row=commands.getJSONArray(i);for(j in 1 until row.length())values.add(row.getDouble(j).toFloat())}
            val pigment=summonColor(PaperLibrary.paperColor(context,color,shape));val legacy=shape !in PaperLibrary.ids
            val light=pigment.red*.2126f+pigment.green*.7152f+pigment.blue*.0722f
            return PaperLook(values.toFloatArray(),listOf(pigment,summonColor(if(legacy)"#E6DDC8" else secondary ?: "#E6DDC8"),summonColor(if(legacy)"#414A3C" else ink ?: "#414A3C"),summonColor(if(light>.69f)"#485346" else if(legacy)"#FFFBF0" else paper ?: "#FFFBF0")))
        }
    }
}

object PaperLibrary {
    val ids=listOf("cercle","galet","squircle","capsule","triangle","hexagone","nuage","goutte")
    val names=listOf("圆形","卵石","圆角方形","胶囊","三角形","六边形","云朵","水滴")
    val defaultColors=listOf("#7D824B","#B2634F","#597C91","#A87932","#B2634F","#4D5C69","#867399","#648468")
    private var loaded:JSONObject?=null
    fun data(context:Context):JSONObject=loaded ?: JSONObject(context.assets.open("paper-avatars.json").bufferedReader().use{it.readText()}).also{loaded=it}
    fun role(shape:String):String=if(shape in ids)shape else when(shape){
        "dev","square"->"squircle";"art","knowledge","clover","pentagon"->"galet";"music","research","drop"->"goutte"
        "plan","ops","star4","hexagon"->"hexagone";"qa","cloud","flower"->"nuage";"write"->"triangle"
        "data","translate","pill","star6"->"capsule";else->"cercle"
    }
    fun paperColor(context:Context,color:String,shape:String):String=if(shape in ids)color else data(context).getJSONObject("legacyColors").optString(color.uppercase(),color)
    fun floats(a:JSONArray)=FloatArray(a.length()){a.getDouble(it).toFloat()}
    data class Dot(val x:Float,val y:Float,val radius:Float,val alpha:Float,val path:Path?,val rotation:Float)
    data class Frame(val body:FloatArray,val eyes:List<FloatArray>,val alpha:Float,val outline:FloatArray?=null,val dots:List<Dot> = emptyList(),val dotsBehind:Boolean=false,val arcs:List<Arc> = emptyList(),val notification:FloatArray?=null) {
        fun blend(from:Frame,k:Float):Frame {
            fun mix(a:FloatArray,b:FloatArray)=if(a.size!=b.size)b else FloatArray(b.size){a[it]+(b[it]-a[it])*k}
            return copy(body=mix(from.body,body),eyes=eyes.mapIndexed{i,e->if(i<from.eyes.size)mix(from.eyes[i],e) else e},alpha=from.alpha+(alpha-from.alpha)*k,outline=outline?.let{to->from.outline?.let{mix(it,to)} ?: to})
        }
    }
    data class Clip(val duration:Float,val once:Boolean,val pingpong:Boolean,val frames:List<Frame>)
    data class Model(val body:Path,val clips:Map<String,Clip>)
    data class Arc(val back:Path,val front:Path,val width:Float,val alpha:Float)
    private val models=mutableMapOf<String,Model>()
    private var rings:List<List<Arc>>?=null
    private fun arc(a:JSONObject)=Arc(CrewLibrary.path(a.getJSONArray("back")),CrewLibrary.path(a.getJSONArray("front")),a.getDouble("width").toFloat(),a.getDouble("opacity").toFloat())
    private fun parseFrame(row:JSONObject):Frame {
        val eyes=row.getJSONArray("eyes");val dots=row.optJSONArray("dots");val arcs=row.optJSONArray("arcs")
        return Frame(floats(row.getJSONArray("body")),(0 until eyes.length()).map{floats(eyes.getJSONArray(it))},row.getDouble("alpha").toFloat(),
            row.optJSONArray("outline")?.let{floats(it)},
            if(dots==null)emptyList() else (0 until dots.length()).map{i->val d=dots.getJSONObject(i);Dot(d.getDouble("x").toFloat(),d.getDouble("y").toFloat(),d.getDouble("r").toFloat(),d.getDouble("alpha").toFloat(),d.optJSONArray("path")?.let{CrewLibrary.path(it)},d.optDouble("rotation",0.0).toFloat())},
            row.optBoolean("dotsBehind"),if(arcs==null)emptyList() else (0 until arcs.length()).map{arc(arcs.getJSONObject(it))},row.optJSONArray("notification")?.let{floats(it)})
    }
    fun model(context:Context,role:String):Model=models.getOrPut(role){
        val model=data(context).getJSONObject("characters").getJSONObject(role);val clips=model.getJSONObject("frames");val shared=data(context).getJSONObject("sharedClips")
        Model(CrewLibrary.path(model.getJSONArray("body")),(clips.keys().asSequence().toList()+shared.keys().asSequence().toList()).associateWith{key->
            val clip=shared.optJSONObject(key) ?: clips.getJSONObject(key);val rows=clip.getJSONArray("rows")
            Clip(clip.getDouble("duration").toFloat(),clip.getBoolean("once"),clip.getBoolean("pingpong"),(0 until rows.length()).map{i->parseFrame(rows.getJSONObject(i))})
        })
    }
    fun frame(model:Model,state:String,time:Float):Frame {
        val clip=model.clips[state] ?: model.clips.getValue("idle")
        val age=if(clip.once)min(time,clip.duration) else if(clip.pingpong){val t=time%(clip.duration*2);if(t<=clip.duration)t else clip.duration*2-t} else time%clip.duration
        val x=min(max(0f,age)*20,clip.frames.lastIndex.toFloat());val lo=x.toInt();val hi=min(lo+1,clip.frames.lastIndex)
        return clip.frames[hi].blend(clip.frames[lo],x-lo)
    }
    fun arcs(context:Context,time:Float):List<Arc>{
        val clips=rings ?: data(context).getJSONObject("rings").getJSONArray("rows").let{rows->(0 until rows.length()).map{i->val list=rows.getJSONArray(i);(0 until list.length()).map{j->val a=list.getJSONObject(j);Arc(CrewLibrary.path(a.getJSONArray("back")),CrewLibrary.path(a.getJSONArray("front")),a.getDouble("width").toFloat(),a.getDouble("opacity").toFloat())}}}.also{rings=it}
        return clips[min(((time%4.3f)*20).toInt(),clips.lastIndex)]
    }
}

@Composable
fun BotAvatar(shape:String,color:String,image:String?=null,size:Dp=48.dp,modifier:Modifier=Modifier,secondary:String?=null,ink:String?=null,paper:String?=null,motion:String="idle",animated:Boolean=true,groupOutline:Color?=null){
    val bitmap=remember(image){decodeDataImage(image)}
    val inset=if(groupOutline==null) 0.dp else minOf(4.dp,size*.08f)
    if(bitmap!=null){
        val imageSize=size-inset*2
        Box(modifier.size(size).padding(inset)) {
            Image(bitmap.asImageBitmap(),null,Modifier.size(imageSize).clip(RoundedCornerShape(imageSize*.22f))
                .then(if(groupOutline!=null) Modifier.border(inset,groupOutline,RoundedCornerShape(imageSize*.22f)) else Modifier),contentScale=ContentScale.Crop)
        }
        return
    }
    val context=LocalContext.current;val role=PaperLibrary.role(shape)
    val model=remember(role){PaperLibrary.model(context,role)}
    var frame by remember{mutableStateOf(PaperLibrary.frame(model,motion,0f))}
    var age by remember{mutableFloatStateOf(0f)}
    val targetLook=remember(shape,color,secondary,ink,paper){PaperLook.make(context,shape,color,secondary,ink,paper)}
    var look by remember{mutableStateOf(targetLook)}
    val requested by rememberUpdatedState(motion)
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val enabled=animated&&android.animation.ValueAnimator.areAnimatorsEnabled()
    LaunchedEffect(targetLook){
        if(look === targetLook)return@LaunchedEffect
        if(!android.animation.ValueAnimator.areAnimatorsEnabled()){look=targetLook;return@LaunchedEffect}
        val from=look;val start=withFrameNanos{it}
        while(isActive){val t=withFrameNanos{((it-start)/420_000_000f).coerceIn(0f,1f)};look=targetLook.blend(from,1-(1-t).pow(3));if(t>=1f)break}
    }
    LaunchedEffect(role,enabled,lifecycle){
        if(!enabled||!lifecycle.isAtLeast(Lifecycle.State.STARTED)){frame=PaperLibrary.frame(model,requested,0f);return@LaunchedEffect}
        var last=0L;var current=requested;var previous:PaperLibrary.Frame?=frame;age=0f
        while(isActive){withFrameNanos{now->
            if(last==0L)last=now
            val dt=(now-last)/1_000_000_000f
            if(dt>=1f/30){
                if(current!=requested){previous=frame;current=requested;age=0f}
                age+=dt.coerceAtMost(.064f)
                val target=PaperLibrary.frame(model,current,age)
                frame=if(previous!=null&&age<.4f)target.blend(previous!!,1-(1-age/.4f).pow(5)) else target.also{previous=null}
                last=now
            }
        }}
    }
    val displayed=if(enabled)frame else PaperLibrary.frame(model,motion,0f)
    val outline=displayed.outline?.let{points->Path().apply{moveTo(points[0],points[1]);var i=2;while(i+5<points.size){cubicTo(points[i],points[i+1],points[i+2],points[i+3],points[i+4],points[i+5]);i+=6};close()}} ?: remember(look){look.path()}
    val fibers=remember{val rows=PaperLibrary.data(context).getJSONArray("fibers");(0 until rows.length()).map{PaperLibrary.floats(rows.getJSONArray(it))}}
    Canvas(modifier.size(size)){
        drawIntoCanvas{wrapper->
            // Reserve room for the paper backing and separator within this canvas.
            val scale=(this.size.width-inset.toPx()*2)/316*1.5f
            val c=wrapper.nativeCanvas;val save=c.save();c.translate(this.size.width/2,this.size.height/2);c.scale(scale,scale)
            val paint=android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply{strokeCap=android.graphics.Paint.Cap.ROUND;strokeJoin=android.graphics.Paint.Join.ROUND}
            fun fill(path:Path,slot:Int){paint.style=android.graphics.Paint.Style.FILL;paint.color=look.colors[slot].toArgb();c.drawPath(path,paint)}
            fun matrix(a:FloatArray)=android.graphics.Matrix().apply{setValues(floatArrayOf(a[0],a[2],a[4],a[1],a[3],a[5],0f,0f,1f))}
            val arcs=if(motion=="work")PaperLibrary.arcs(context,age) else displayed.arcs
            fun drawDots(){for(dot in displayed.dots){paint.style=android.graphics.Paint.Style.FILL;paint.color=look.colors[0].toArgb();paint.alpha=(dot.alpha*255).toInt();if(dot.path!=null){val state=c.save();c.translate(dot.x,dot.y);c.rotate(dot.rotation);c.drawPath(dot.path,paint);c.restoreToCount(state)}else c.drawCircle(dot.x,dot.y,dot.radius,paint)};paint.alpha=255}
            fun drawArcs(front:Boolean){for(a in arcs){paint.style=android.graphics.Paint.Style.STROKE;paint.color=look.colors[0].toArgb();paint.alpha=(a.alpha*255).toInt();paint.strokeWidth=a.width;c.drawPath(if(front)a.front else a.back,paint)};paint.alpha=255}
            drawArcs(false)
            if(displayed.dotsBehind)drawDots()
            val material=c.saveLayerAlpha(null,(displayed.alpha*255).toInt())
            if(groupOutline!=null){
                paint.style=android.graphics.Paint.Style.FILL_AND_STROKE;paint.color=groupOutline.toArgb();paint.strokeWidth=inset.toPx()/scale
                val backOutline=c.save();c.translate(4.5f,5.5f);c.rotate(-3f);c.concat(matrix(displayed.body));c.drawPath(outline,paint);c.restoreToCount(backOutline)
                c.drawPath(Path(outline).apply{transform(matrix(displayed.body))},paint)
            }
            val back=c.save();c.translate(4.5f,5.5f);c.rotate(-3f);c.concat(matrix(displayed.body));fill(outline,1);c.restoreToCount(back)
            val body=Path(outline).apply{transform(matrix(displayed.body))}
            fill(body,0);paint.style=android.graphics.Paint.Style.STROKE;paint.color=look.colors[2].toArgb();paint.alpha=40;paint.strokeWidth=.75f;c.drawPath(body,paint);paint.alpha=255
            val face=c.save();c.clipPath(body)
            paint.color=android.graphics.Color.WHITE;paint.alpha=25;paint.style=android.graphics.Paint.Style.STROKE;paint.strokeWidth=.45f
            for(f in fibers){c.drawLine(f[0],f[1],f[0]+f[2],f[1]+f[3],paint)}
            for(e in displayed.eyes){if(e.size<11)continue;val eye=c.save();c.concat(matrix(e.copyOfRange(4,10)));paint.style=android.graphics.Paint.Style.FILL;paint.color=look.colors[3].toArgb();paint.alpha=(e[10]*255).toInt();val r=min(e[2],e[3])/2;c.drawRoundRect(e[0],e[1],e[0]+e[2],e[1]+e[3],r,r,paint);c.restoreToCount(eye)}
            paint.alpha=255;c.restoreToCount(face);c.restoreToCount(material)
            if(!displayed.dotsBehind)drawDots()
            displayed.notification?.let{n->paint.style=android.graphics.Paint.Style.FILL;paint.color=android.graphics.Color.rgb(106,146,186);c.drawCircle(n[0],n[1],n[2],paint)}
            drawArcs(true);c.restoreToCount(save)
        }
    }
}
