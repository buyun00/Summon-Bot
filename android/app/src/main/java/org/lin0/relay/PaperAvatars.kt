package org.lin0.relay

import android.content.Context
import android.graphics.Path
import org.json.JSONObject
import org.json.JSONArray
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import kotlinx.coroutines.isActive
import kotlin.math.*

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
    data class Frame(val body:FloatArray,val eyes:List<FloatArray>,val alpha:Float) {
        fun blend(from:Frame,k:Float):Frame {
            fun mix(a:FloatArray,b:FloatArray)=if(a.size!=b.size)b else FloatArray(b.size){a[it]+(b[it]-a[it])*k}
            return Frame(mix(from.body,body),eyes.mapIndexed{i,e->if(i<from.eyes.size)mix(from.eyes[i],e) else e},from.alpha+(alpha-from.alpha)*k)
        }
    }
    data class Clip(val duration:Float,val once:Boolean,val pingpong:Boolean,val frames:List<Frame>)
    data class Model(val body:Path,val clips:Map<String,Clip>)
    data class Arc(val back:Path,val front:Path,val width:Float,val alpha:Float)
    private val models=mutableMapOf<String,Model>()
    private var rings:List<List<Arc>>?=null
    fun model(context:Context,role:String):Model=models.getOrPut(role){
        val model=data(context).getJSONObject("characters").getJSONObject(role);val clips=model.getJSONObject("frames")
        Model(CrewLibrary.path(model.getJSONArray("body")),clips.keys().asSequence().associateWith{key->
            val clip=clips.getJSONObject(key);val rows=clip.getJSONArray("rows")
            Clip(clip.getDouble("duration").toFloat(),clip.getBoolean("once"),clip.getBoolean("pingpong"),(0 until rows.length()).map{i->val row=rows.getJSONObject(i);val eyes=row.getJSONArray("eyes");Frame(floats(row.getJSONArray("body")),(0 until eyes.length()).map{floats(eyes.getJSONArray(it))},row.getDouble("alpha").toFloat())})
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
fun BotAvatar(shape:String,color:String,image:String?=null,size:Dp=48.dp,modifier:Modifier=Modifier,secondary:String?=null,ink:String?=null,paper:String?=null,motion:String="idle",animated:Boolean=true){
    val bitmap=remember(image){decodeDataImage(image)}
    if(bitmap!=null){Image(bitmap.asImageBitmap(),null,modifier.size(size).clip(RoundedCornerShape(size*.22f)),contentScale=ContentScale.Crop);return}
    val context=LocalContext.current;val role=PaperLibrary.role(shape)
    val model=remember(role){PaperLibrary.model(context,role)}
    var frame by remember(role){mutableStateOf(PaperLibrary.frame(model,motion,0f))}
    var age by remember(role){mutableFloatStateOf(0f)}
    val requested by rememberUpdatedState(motion)
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val enabled=animated&&android.animation.ValueAnimator.areAnimatorsEnabled()
    LaunchedEffect(role,enabled,lifecycle){
        if(!enabled||!lifecycle.isAtLeast(Lifecycle.State.STARTED)){frame=PaperLibrary.frame(model,requested,0f);return@LaunchedEffect}
        var last=0L;var current=requested;var previous:PaperLibrary.Frame?=null
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
    val pigment=PaperLibrary.paperColor(context,color,shape);val legacy=shape !in PaperLibrary.ids
    val displayed=if(enabled)frame else PaperLibrary.frame(model,motion,0f)
    val fibers=remember{val rows=PaperLibrary.data(context).getJSONArray("fibers");(0 until rows.length()).map{PaperLibrary.floats(rows.getJSONArray(it))}}
    Canvas(modifier.size(size)){
        drawIntoCanvas{wrapper->
            val c=wrapper.nativeCanvas;val save=c.save();c.scale(this.size.width/316,this.size.height/316);c.translate(158f,158f)
            val paint=android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply{strokeCap=android.graphics.Paint.Cap.ROUND;strokeJoin=android.graphics.Paint.Join.ROUND}
            fun rgb(hex:String)=runCatching{android.graphics.Color.parseColor(hex)}.getOrDefault(android.graphics.Color.DKGRAY)
            fun fill(path:Path,hex:String){paint.style=android.graphics.Paint.Style.FILL;paint.color=rgb(hex);c.drawPath(path,paint)}
            fun matrix(a:FloatArray)=android.graphics.Matrix().apply{setValues(floatArrayOf(a[0],a[2],a[4],a[1],a[3],a[5],0f,0f,1f))}
            val arcs=if(motion=="work")PaperLibrary.arcs(context,age) else emptyList()
            fun drawArcs(front:Boolean){for(a in arcs){paint.style=android.graphics.Paint.Style.STROKE;paint.color=rgb(pigment);paint.alpha=(a.alpha*255).toInt();paint.strokeWidth=a.width;c.drawPath(if(front)a.front else a.back,paint)};paint.alpha=255}
            drawArcs(false)
            val back=c.save();c.translate(4.5f,5.5f);c.rotate(-3f);c.concat(matrix(displayed.body));fill(model.body,if(legacy)"#E6DDC8" else secondary ?: "#E6DDC8");c.restoreToCount(back)
            val body=Path(model.body).apply{transform(matrix(displayed.body))}
            fill(body,pigment);paint.style=android.graphics.Paint.Style.STROKE;paint.color=rgb(if(legacy)"#414A3C" else ink ?: "#414A3C");paint.alpha=40;paint.strokeWidth=.75f;c.drawPath(body,paint);paint.alpha=255
            val face=c.save();c.clipPath(body)
            paint.color=android.graphics.Color.WHITE;paint.alpha=25;paint.style=android.graphics.Paint.Style.STROKE;paint.strokeWidth=.45f
            for(f in fibers){c.drawLine(f[0],f[1],f[0]+f[2],f[1]+f[3],paint)}
            val rgbValue=rgb(pigment);val light=(android.graphics.Color.red(rgbValue)*.2126+android.graphics.Color.green(rgbValue)*.7152+android.graphics.Color.blue(rgbValue)*.0722)/255
            val eyeColor=if(light>.69)"#485346" else if(legacy)"#FFFBF0" else paper ?: "#FFFBF0"
            for(e in displayed.eyes){if(e.size<11)continue;val eye=c.save();c.concat(matrix(e.copyOfRange(4,10)));paint.style=android.graphics.Paint.Style.FILL;paint.color=rgb(eyeColor);paint.alpha=(e[10]*255).toInt();val r=min(e[2],e[3])/2;c.drawRoundRect(e[0],e[1],e[0]+e[2],e[1]+e[3],r,r,paint);c.restoreToCount(eye)}
            paint.alpha=255;c.restoreToCount(face);drawArcs(true);c.restoreToCount(save)
        }
    }
}
