package org.lin0.relay

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.RectF
import android.util.Base64
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.RoundedCornerShape
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

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

private val shiftedEyes = setOf("star4", "flower", "drop", "triangle", "pentagon", "star6")
private val knownShapes = RelayAvatar.shapes.map { it.first }.toSet()

private fun shapePath(id: String): android.graphics.Path {
    val path = android.graphics.Path()
    var rotation = 0f
    fun point(x: Float, y: Float) = floatArrayOf(x, y)
    when (id) {
        "cloud" -> {
            path.moveTo(9f, 31f)
            path.cubicTo(5f, 24f, 8f, 15f, 17f, 12f)
            path.cubicTo(22f, 6f, 31f, 6f, 37f, 10f)
            path.cubicTo(44f, 5f, 54f, 10f, 55f, 18f)
            path.cubicTo(63f, 23f, 62f, 33f, 57f, 39f)
            path.cubicTo(58f, 49f, 47f, 55f, 38f, 52f)
            path.cubicTo(30f, 59f, 20f, 56f, 16f, 52f)
            path.cubicTo(5f, 55f, 2f, 42f, 9f, 31f)
            path.close()
        }
        "square" -> {
            path.addRoundRect(RectF(7f, 7f, 57f, 57f), 7f, 7f, android.graphics.Path.Direction.CW)
            rotation = -18f
        }
        "star4" -> {
            path.moveTo(32f, 2f)
            path.cubicTo(39f, 2f, 41f, 17f, 44f, 20f)
            path.cubicTo(48f, 23f, 62f, 25f, 62f, 32f)
            path.cubicTo(62f, 39f, 48f, 41f, 44f, 44f)
            path.cubicTo(41f, 48f, 39f, 62f, 32f, 62f)
            path.cubicTo(25f, 62f, 23f, 48f, 20f, 44f)
            path.cubicTo(16f, 41f, 2f, 39f, 2f, 32f)
            path.cubicTo(2f, 25f, 16f, 23f, 20f, 20f)
            path.cubicTo(23f, 16f, 25f, 2f, 32f, 2f)
            path.close()
            rotation = -12f
        }
        "clover" -> {
            path.moveTo(32f, 11f)
            path.cubicTo(43f, 1f, 60f, 10f, 55f, 27f)
            path.cubicTo(67f, 40f, 54f, 61f, 37f, 55f)
            path.cubicTo(23f, 67f, 4f, 55f, 9f, 38f)
            path.cubicTo(-2f, 24f, 10f, 5f, 26f, 10f)
            path.cubicTo(28f, 10f, 30f, 10f, 32f, 11f)
            path.close()
            rotation = -12f
        }
        "heart" -> {
            path.moveTo(32f, 13f)
            path.cubicTo(21f, 1f, 4f, 7f, 4f, 22f)
            path.cubicTo(4f, 33f, 18f, 44f, 28f, 55f)
            path.quadTo(32f, 60f, 37f, 55f)
            path.cubicTo(48f, 44f, 60f, 33f, 60f, 22f)
            path.cubicTo(60f, 7f, 44f, 1f, 32f, 13f)
            path.close()
            rotation = -20f
        }
        "flower" -> {
            listOf(32f to 15f, 46.7f to 23.5f, 46.7f to 40.5f, 32f to 49f, 17.3f to 40.5f, 17.3f to 23.5f).forEach { (x, y) ->
                path.addOval(RectF(x - 12f, y - 12f, x + 12f, y + 12f), android.graphics.Path.Direction.CW)
            }
            path.addOval(RectF(13f, 13f, 51f, 51f), android.graphics.Path.Direction.CW)
            rotation = -12f
        }
        "drop" -> {
            path.moveTo(23f, 4f)
            path.cubicTo(35f, 6f, 49f, 16f, 54f, 28f)
            path.cubicTo(62f, 44f, 51f, 59f, 35f, 60f)
            path.cubicTo(20f, 61f, 8f, 51f, 8f, 36f)
            path.cubicTo(8f, 27f, 12f, 14f, 15f, 8f)
            path.quadTo(17f, 3f, 23f, 4f)
            path.close()
            rotation = -12f
        }
        "pill" -> {
            path.addRoundRect(RectF(3f, 12f, 61f, 52f), 20f, 20f, android.graphics.Path.Direction.CW)
            rotation = -17f
        }
        "triangle" -> {
            path.moveTo(11f, 10f)
            path.cubicTo(12f, 4f, 17f, 3f, 23f, 7f)
            path.lineTo(55f, 25f)
            path.quadTo(66f, 32f, 55f, 40f)
            path.lineTo(22f, 57f)
            path.quadTo(9f, 65f, 8f, 51f)
            path.close()
            rotation = -7f
        }
        "pentagon" -> {
            path.moveTo(24f, 5f)
            path.quadTo(29f, 2f, 34f, 7f)
            path.lineTo(51f, 23f)
            path.quadTo(56f, 27f, 55f, 34f)
            path.lineTo(50f, 53f)
            path.quadTo(48f, 59f, 41f, 58f)
            path.lineTo(13f, 55f)
            path.quadTo(6f, 54f, 7f, 47f)
            path.lineTo(10f, 22f)
            path.quadTo(11f, 15f, 16f, 11f)
            path.close()
            rotation = -17f
        }
        "star6" -> {
            for (index in 0 until 144) {
                val angle = index * Math.PI.toFloat() / 72f
                val radius = 23f + 5.5f * cos(6 * angle + Math.PI.toFloat())
                val x = 32f + cos(angle) * radius
                val y = 32f + sin(angle) * radius
                if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            path.close()
            rotation = -15f
        }
        "hexagon" -> {
            path.moveTo(22f, 4f)
            path.quadTo(26f, 2f, 31f, 4f)
            path.lineTo(47f, 10f)
            path.quadTo(52f, 12f, 54f, 17f)
            path.lineTo(60f, 32f)
            path.quadTo(62f, 37f, 58f, 42f)
            path.lineTo(45f, 56f)
            path.quadTo(41f, 60f, 36f, 58f)
            path.lineTo(18f, 54f)
            path.quadTo(13f, 53f, 11f, 48f)
            path.lineTo(5f, 33f)
            path.quadTo(3f, 28f, 6f, 23f)
            path.lineTo(17f, 8f)
            path.quadTo(19f, 5f, 22f, 4f)
            path.close()
        }
        else -> path.addOval(RectF(4.5f, 4.5f, 59.5f, 59.5f), android.graphics.Path.Direction.CW)
    }
    if (rotation != 0f) {
        val matrix = Matrix()
        matrix.setRotate(rotation, 32f, 32f)
        path.transform(matrix)
    }
    point(0f, 0f)
    return path
}

private fun eyesPath(shifted: Boolean): android.graphics.Path {
    val path = android.graphics.Path()
    listOf(34.25f to 25.5f, 48.25f to 23.5f).forEach { (x, y) ->
        path.addRoundRect(RectF(x - 3.25f, y - 6.5f, x + 3.25f, y + 6.5f), 3.25f, 3.25f, android.graphics.Path.Direction.CW)
    }
    val spin = Matrix()
    spin.setRotate(-26f, 40f, 25f)
    path.transform(spin)
    if (shifted) path.offset(-4f, 5f)
    return path
}

private fun scaled(path: android.graphics.Path, width: Float, height: Float): Path {
    val copy = android.graphics.Path(path)
    val matrix = Matrix()
    matrix.setScale(width / 64f, height / 64f)
    copy.transform(matrix)
    return copy.asComposePath()
}

@Composable
fun BotAvatar(shape: String, color: String, image: String? = null, size: Dp = 48.dp, modifier: Modifier = Modifier) {
    val resolved = if (shape in knownShapes) shape else "circle"
    val bitmap = remember(image) { decodeDataImage(image) }
    if (bitmap != null) {
        Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = null,
            modifier = modifier.size(size).clip(RoundedCornerShape(size * 14f / 64f)),
            contentScale = ContentScale.Crop,
        )
    } else {
        Canvas(modifier.size(size)) {
            val body = scaled(shapePath(resolved), this.size.width, this.size.height)
            val eyes = scaled(eyesPath(resolved in shiftedEyes), this.size.width, this.size.height)
            clipPath(body) {
                drawPath(body, relayColor(color))
                drawPath(eyes, Color.White)
            }
        }
    }
}

@Composable
fun MemberAvatar(bot: RelayBot?, size: Dp = 48.dp, modifier: Modifier = Modifier) {
    val avatar = bot?.resolvedAvatar ?: RelayAvatar()
    BotAvatar(avatar.shape, avatar.color, avatar.image, size, modifier)
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
    val reduceMotion = androidx.compose.ui.platform.LocalAccessibilityManager.current != null && false
    val transition = rememberInfiniteTransition(label = "bot")
    val breath = transition.animateFloat(0f, 1f, infiniteRepeatable(tween(2800, easing = LinearEasing), RepeatMode.Restart), label = "breath")
    val phase = if (reduceMotion) 0f else breath.value
    val wave = kotlin.math.sin(phase * 2 * Math.PI).toFloat()
    val sway = kotlin.math.sin(phase * 2 * Math.PI * 2800f / 4100f).toFloat()
    val display = (name ?: bot?.name).orEmpty().trim().ifBlank { null }
    androidx.compose.foundation.layout.Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        MemberAvatar(bot, 28.dp, Modifier
            .offset(y = (wave * 0.5f).dp)
            .then(Modifier.graphicsLayer {
                scaleX = 1f + wave * 0.035f
                scaleY = 1f + wave * 0.035f
                rotationZ = sway * 4f
            }))
        androidx.compose.foundation.layout.Spacer(Modifier.size(9.dp))
        androidx.compose.foundation.layout.Column {
            if (display != null) {
                androidx.compose.material3.Text(display, style = androidx.compose.material3.MaterialTheme.typography.labelMedium, color = Color(0xFF8E8E93), maxLines = 1)
            }
            androidx.compose.material3.Text(status, color = Color(0xFFAEAEB2), maxLines = 2)
        }
    }
}

