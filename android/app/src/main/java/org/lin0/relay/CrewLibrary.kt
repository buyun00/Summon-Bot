package org.lin0.relay

import android.content.Context
import android.graphics.Path
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.min
import kotlin.math.sqrt

object CrewLibrary {
    val ids = listOf("dev","art","music","plan","qa","write","ops","research","data","lead","translate","knowledge")
    val defaultColors = listOf("#ffc18e","#ff9c9c","#c5aff1","#ffe39a","#afdcb7","#b6c9ff","#a6b9d6","#81d4cf","#ffc395","#ffaaaa","#b9bcff","#bfdca9")
    val names = listOf("开发","美术","音乐","策划","测试","文案","运维","研究","数据","协调","翻译","知识")
    val legacy = mapOf("circle" to "dev","cloud" to "qa","square" to "dev","star4" to "plan","clover" to "art","heart" to "lead","flower" to "music","drop" to "research","pill" to "translate","triangle" to "write","pentagon" to "knowledge","star6" to "data","hexagon" to "ops")
    fun role(shape:String) = if(shape in ids) shape else legacy[shape] ?: "dev"
    private var loaded: JSONObject? = null
    fun data(context:Context):JSONObject = loaded ?: JSONObject(context.assets.open("little-crew.json").bufferedReader().use { it.readText() }).also { loaded=it }
    data class Part(val body:Path,val patch:Path,val px:Float,val py:Float,val secondary:Boolean)
    data class Model(val parts:List<Part>,val details:Path,val ex:Float,val ey:Float,val secondary:String,val clips:Map<String,List<FloatArray>>)
    private val models=mutableMapOf<String,Model>()
    fun model(context:Context,role:String):Model = models.getOrPut(role) {
        val m=data(context).getJSONObject("characters").getJSONObject(role)
        val parts=m.getJSONArray("parts")
        val frames=m.getJSONObject("frames")
        Model((0 until parts.length()).map { val p=parts.getJSONObject(it);val pivot=p.getJSONArray("pivot");Part(path(p.getJSONArray("ops")),path(p.getJSONArray("patchOps")),pivot.getDouble(0).toFloat(),pivot.getDouble(1).toFloat(),p.optString("tone")=="secondary") },
            path(m.getJSONArray("detailsOps")),m.getJSONArray("eyes").getDouble(0).toFloat(),m.getJSONArray("eyes").getDouble(1).toFloat(),m.getString("secondary"),
            frames.keys().asSequence().associateWith { key -> val rows=frames.getJSONArray(key);(0 until rows.length()).map { i -> val a=rows.getJSONArray(i);FloatArray(a.length()){ a.getDouble(it).toFloat() } } })
    }
    fun path(ops:JSONArray):Path = Path().apply {
        for(i in 0 until ops.length()){val a=ops.getJSONArray(i);fun n(k:Int)=a.getDouble(k).toFloat()
            when(a.getString(0)){"M"->moveTo(n(1),n(2));"L"->lineTo(n(1),n(2));"Q"->quadTo(n(1),n(2),n(3),n(4));"C"->cubicTo(n(1),n(2),n(3),n(4),n(5),n(6));"Z"->close()}
        }
    }
    val durations=mapOf("idle" to 4.8f,"think" to 3.6f,"work" to 2.4f,"done" to 2.2f,"wait" to 4.4f,"confused" to 3.2f)
    fun rest()=floatArrayOf(0f,0f,0f,1f,1f,0f,0f,1f,0f,0f,0f,0f,0f,0f,0f)
}

class CrewMotion {
    var value=CrewLibrary.rest()
    private val velocity=FloatArray(15)
    private var state="idle"
    private var age=0f
    fun step(model:CrewLibrary.Model,next:String,dt:Float):FloatArray {
        if(next!=state){state=next;age=0f}
        age+=dt
        val duration=CrewLibrary.durations[state] ?: 4.8f
        val frames=model.clips[state] ?: model.clips.getValue("idle")
        val t=if(state=="done") min(age,duration) else age%duration
        val position=min(t*24, (frames.size-1).toFloat());val lo=position.toInt();val hi=min(lo+1,frames.size-1);val fraction=position-lo
        val target=FloatArray(15){frames[lo][it]+(frames[hi][it]-frames[lo][it])*fraction}
        var remaining=dt
        while(remaining>0){val h=min(remaining,1f/120);for(k in value.indices){val stiffness=if(k==7)1800f else 260f;velocity[k]+=(stiffness*(target[k]-value[k])-2*sqrt(stiffness)*velocity[k])*h;value[k]+=velocity[k]*h};remaining-=h}
        return value.copyOf()
    }
}
