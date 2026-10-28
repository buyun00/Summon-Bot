package org.lin0.relay

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
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
import androidx.compose.animation.core.*
import androidx.compose.ui.graphics.graphicsLayer

fun relayColor(hex: String): Color {
    val digits = hex.trim().removePrefix("#")
    val rgb = digits.toLongOrNull(16)?.takeIf { digits.length == 6 } ?: 0x8F59F9
    return Color(
        red = ((rgb shr 16) and 0xFF) / 255f,
        green = ((rgb shr 8) and 0xFF) / 255f,
        blue = (rgb and 0xFF) / 255f,
    )
}

fun decodeDataImage(value: String?): Bitmap? {
    if (value == null) return null
    val separator = value.indexOf(',')
    if (separator <= 0) return null
    val header = value.substring(0, separator)
    if (header !in setOf("data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64")) return null
    val payload = value.substring(separator + 1)
    if (payload.isEmpty() || payload.length % 4 != 0) return null
    val bytes = runCatching { Base64.decode(payload, Base64.DEFAULT) }.getOrNull() ?: return null
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
}


@Composable
fun BotAvatar(shape:String,color:String,image:String?=null,size:Dp=48.dp,modifier:Modifier=Modifier,secondary:String?=null,ink:String?=null,paper:String?=null,motion:String="idle",animated:Boolean=true) {
    val bitmap=remember(image){decodeDataImage(image)}
    if(bitmap!=null){Image(bitmap.asImageBitmap(),null,modifier.size(size).clip(RoundedCornerShape(size*.22f)),contentScale=ContentScale.Crop);return}
    val context=LocalContext.current
    val role=CrewLibrary.role(shape)
    val model=remember(role){CrewLibrary.model(context,role)}
    val driver=remember(role){CrewMotion()}
    var q by remember(role){mutableStateOf(CrewLibrary.rest())}
    val latestMotion by rememberUpdatedState(motion)
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val enabled=animated && android.animation.ValueAnimator.areAnimatorsEnabled()
    LaunchedEffect(role,enabled,lifecycleState){
        if(!enabled || !lifecycleState.isAtLeast(Lifecycle.State.STARTED))return@LaunchedEffect
        var last=0L
        while(isActive){withFrameNanos { now -> if(last==0L)last=now;val dt=(now-last)/1_000_000_000f;if(dt>=1f/30){q=driver.step(model,latestMotion,dt.coerceAtMost(.05f));last=now} }}
    }
    Canvas(modifier.size(size)) {
        drawIntoCanvas { wrapper ->
            val c=wrapper.nativeCanvas;val save=c.save();c.scale(this.size.width/158,this.size.height/158);c.translate(15f,19f)
            c.translate(q[0]+64,q[1]+75);c.rotate(q[2]);c.scale(q[3],q[4]);c.translate(-64f,-75f)
            val paint=android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply{strokeCap=android.graphics.Paint.Cap.ROUND;strokeJoin=android.graphics.Paint.Join.ROUND}
            fun rgb(hex:String):Int=runCatching{android.graphics.Color.parseColor(hex)}.getOrDefault(android.graphics.Color.DKGRAY)
            fun fill(path:android.graphics.Path,hex:String){paint.style=android.graphics.Paint.Style.FILL;paint.color=rgb(hex);c.drawPath(path,paint)}
            fun stroke(path:android.graphics.Path,width:Float){paint.style=android.graphics.Paint.Style.STROKE;paint.strokeWidth=width;paint.color=rgb(ink ?: "#142443");c.drawPath(path,paint)}
            model.parts.forEachIndexed { i,p -> val saved=c.save();val angle=q[10+min(i,2)];c.translate((if(i==0)-1 else 1)*q[13],if(role=="data")angle*1.4f else 0f);c.rotate(angle,p.px,p.py);fill(p.body,paper ?: "#FFFAF1");val clip=c.save();c.clipPath(p.body);fill(p.patch,if(p.secondary)secondary ?: model.secondary else color);c.restoreToCount(clip);stroke(p.body,5.4f);c.restoreToCount(saved) }
            stroke(model.details,4.5f)
            val rays=android.graphics.Path().apply { moveTo(103f,16f);lineTo(106f,8f);moveTo(113f,24f);lineTo(120f,19f);moveTo(16f,19f);lineTo(11f,13f) }
            paint.style=android.graphics.Paint.Style.STROKE;paint.strokeWidth=3.7f;paint.color=rgb(ink ?: "#142443");paint.alpha=(q[14].coerceIn(0f,1f)*255).toInt();c.drawPath(rays,paint);paint.alpha=255
            c.translate(model.ex+q[5],model.ey+q[6]);paint.style=android.graphics.Paint.Style.FILL;paint.color=rgb(ink ?: "#142443");val smile=q[8].coerceIn(0f,1f);paint.alpha=((1-smile)*255).toInt()
            for(i in 0..1){val ry=max(.5f,6*q[7].coerceIn(.06f,1f)*(if(i==1)1-q[9]*.38f else 1f));val x=if(i==1)8f else -8f;val y=(if(i==1)-2 else 2)*q[9];c.drawOval(x-3.3f,y-ry,x+3.3f,y+ry,paint)}
            val happy=android.graphics.Path().apply{moveTo(-12f,2f);quadTo(-8f,-8f,-4f,2f);moveTo(4f,2f);quadTo(8f,-8f,12f,2f)}
            paint.style=android.graphics.Paint.Style.STROKE;paint.strokeWidth=3.5f;paint.alpha=(smile*255).toInt();c.drawPath(happy,paint);c.restoreToCount(save)
        }
    }
}

@Composable
fun MemberAvatar(bot:RelayBot?,size:Dp=48.dp,modifier:Modifier=Modifier,motion:String="idle") {
    val a=bot?.resolvedAvatar ?: RelayAvatar()
    BotAvatar(a.shape,a.color,a.image,size,modifier,a.secondary,a.ink,a.paper,motion)
}



@Composable
fun RoomAvatar(room: RelayRoom, bots: List<RelayBot>, size: Dp = 86.dp) {
    val members = room.members.mapNotNull { id -> bots.firstOrNull { it.id == id } }.take(3)
    Box(Modifier.size(size)) {
        if (members.isEmpty()) {
            Box(
                Modifier
                    .size(size * 0.55f)
                    .align(androidx.compose.ui.Alignment.Center)
                    .clip(androidx.compose.foundation.shape.CircleShape)
                    .background(Color(0xFF3A3A3C)),
            )
        } else {
            members.forEachIndexed { index, bot ->
                val child = if (members.size == 1) size else size * 0.62f
                val x = if (members.size == 1) 0.dp else if (index == 0) 0.dp else if (index == 1) -size * 0.22f else size * 0.22f
                val y = if (members.size == 1) 0.dp else if (index == 0) -size * 0.21f else size * 0.23f
                MemberAvatar(bot, child, Modifier.offset(x, y))
            }
        }
    }
}

@Composable
fun BotWorkingIndicator(bot: RelayBot?, name: String?, status: String) {
    androidx.compose.foundation.layout.Row(verticalAlignment=androidx.compose.ui.Alignment.CenterVertically) {
        MemberAvatar(bot,28.dp,motion="work")
        androidx.compose.foundation.layout.Spacer(Modifier.size(9.dp))
        androidx.compose.foundation.layout.Column {
            (name ?: bot?.name)?.let { androidx.compose.material3.Text(it,style=androidx.compose.material3.MaterialTheme.typography.labelMedium) }
            androidx.compose.material3.Text(status,color=Color(0xFFAEAEB2),maxLines=2)
        }
    }
}
