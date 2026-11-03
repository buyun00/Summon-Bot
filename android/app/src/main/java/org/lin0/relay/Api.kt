package org.lin0.relay

import android.content.Context
import android.net.Uri
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.net.URI
import java.util.UUID
import java.util.concurrent.TimeUnit

class SummonApiException(message: String) : Exception(message) {
    companion object {
        val invalidURL = SummonApiException("请输入完整的 Summon Bot 服务地址，例如 https://summon.example.com。")
        val noConnection = SummonApiException("请先在设置中连接 Summon Bot 服务。")
        val invalidResponse = SummonApiException("服务返回了无法读取的内容，请确认地址指向 Summon Bot 服务。")
        val invalidReceipt = SummonApiException("消息尚未确认送达，请手动重试确认。")
        val attachmentTooLarge = SummonApiException("附件不能超过 20 MB。")
        val tooManyAttachments = SummonApiException("每条消息最多附加 8 个文件。")
        val emptyMessage = SummonApiException("请输入消息或添加附件。")

        fun http(status: Int, message: String): SummonApiException =
            SummonApiException(if (message.isEmpty()) "请求失败（$status）" else message)
    }
}

class SummonApiClient(val baseURL: URI, private val token: String) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .callTimeout(180, TimeUnit.SECONDS)
        .build()

    fun requestJson(path: String, method: String = "GET", body: SummonJson? = null): SummonJson {
        val (responseBody, code) = execute(path, method, body, "application/json")
        if (code !in 200..299) {
            val error = runCatching { SummonJson.parse(responseBody) }.getOrNull()
            throw SummonApiException.http(code, error?.get("error")?.stringValue.orEmpty())
        }
        return try {
            SummonJson.parse(responseBody)
        } catch (_: Exception) {
            throw SummonApiException.invalidResponse
        }
    }

    fun upload(data: ByteArray, name: String, mimeType: String): SummonAttachment {
        if (data.size > 20 * 1024 * 1024) throw SummonApiException.attachmentTooLarge
        val body = SummonJson.obj(
            "name" to SummonJson.Str(name),
            "mimeType" to SummonJson.Str(mimeType),
            "data" to SummonJson.Str(android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP)),
        )
        return SummonAttachment.parse(requestJson("/api/attachments", "POST", body))
    }

    fun bytes(path: String): ByteArray {
        val request = build(path, "GET", null, "application/octet-stream")
        http.newCall(request).execute().use { response ->
            val payload = response.body?.bytes() ?: ByteArray(0)
            if (!response.isSuccessful) {
                val error = runCatching { SummonJson.parse(payload.toString(Charsets.UTF_8)) }.getOrNull()
                throw SummonApiException.http(response.code, error?.get("error")?.stringValue.orEmpty())
            }
            return payload
        }
    }

    fun download(context: Context, path: String, name: String): File {
        val request = build(path, "GET", null, "*/*")
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val payload = response.body?.string().orEmpty()
                val error = runCatching { SummonJson.parse(payload) }.getOrNull()
                throw SummonApiException.http(response.code, error?.get("error")?.stringValue.orEmpty())
            }
            val root = File(context.cacheDir, "SummonDownloads/${UUID.randomUUID()}").apply { mkdirs() }
            val safe = name.replace(Regex("""[/\\]"""), "_").replace(Regex("""[\u0000-\u001F]"""), "")
            val fileName = if (safe.isEmpty() || safe == "." || safe == "..") "附件" else safe
            val file = File(root, fileName)
            response.body?.byteStream()?.use { input -> file.outputStream().use { input.copyTo(it) } }
                ?: throw SummonApiException.invalidResponse
            return file
        }
    }

    fun streamCall(): okhttp3.Call {
        val request = build("/api/stream", "GET", null, "text/event-stream").newBuilder()
            .header("Cache-Control", "no-cache")
            .build()
        val client = http.newBuilder()
            .readTimeout(60, TimeUnit.SECONDS)
            .callTimeout(24, TimeUnit.HOURS)
            .build()
        return client.newCall(request)
    }

    private fun execute(path: String, method: String, body: SummonJson?, accept: String): Pair<String, Int> {
        val request = build(path, method, body, accept)
        http.newCall(request).execute().use { response ->
            return (response.body?.string().orEmpty()) to response.code
        }
    }

    private fun build(path: String, method: String, body: SummonJson?, accept: String): Request {
        if (!path.startsWith("/api/") || path.contains("\\")) throw SummonApiException.invalidURL
        val url = baseURL.toString().trimEnd('/') + path
        val builder = Request.Builder().url(url).header("Accept", accept)
        if (token.isNotEmpty()) builder.header("Authorization", "Bearer $token")
        val payload = body?.encode()?.toString()?.toRequestBody("application/json; charset=utf-8".toMediaType())
        builder.method(method, if (method == "GET" || method == "HEAD") null else payload ?: ByteArray(0).toRequestBody(null))
        return builder.build()
    }

    companion object {
        fun normalized(value: String): URI {
            val cleaned = value.trim()
            val uri = try {
                URI(cleaned)
            } catch (_: Exception) {
                throw SummonApiException.invalidURL
            }
            val scheme = uri.scheme?.lowercase()
            if (scheme != "https" && scheme != "http") throw SummonApiException.invalidURL
            if (uri.host.isNullOrEmpty() || uri.userInfo != null || uri.rawQuery != null || uri.rawFragment != null) {
                throw SummonApiException.invalidURL
            }
            if (scheme == "http" && !allowsLocalHttp(uri.host)) throw SummonApiException.invalidURL
            var path = uri.rawPath ?: ""
            while (path.endsWith("/")) path = path.dropLast(1)
            return URI(scheme, uri.userInfo, uri.host, uri.port, path, null, null)
        }

        private fun allowsLocalHttp(host: String): Boolean {
            val name = host.trim().lowercase().trimEnd('.')
            return name == "localhost" || name.endsWith(".local") || !name.contains('.')
        }

        fun component(value: String): String = buildString {
            val allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
            for (character in value) {
                if (character in allowed) append(character)
                else {
                    for (byte in character.toString().toByteArray(Charsets.UTF_8)) {
                        append("%")
                        append("%02X".format(byte.toInt() and 0xFF))
                    }
                }
            }
        }
    }
}

class SummonEventStream(private val client: SummonApiClient) {
    suspend fun consume(receive: suspend (SummonStreamEvent) -> Unit) {
        val call = client.streamCall()
        try {
            val response = call.execute()
            response.use {
                val type = it.header("Content-Type")?.lowercase().orEmpty()
                if (!it.isSuccessful || !type.startsWith("text/event-stream")) {
                    throw SummonApiException.http(it.code, "实时连接失败（${it.code}）")
                }
                val parser = SummonSseParser()
                val stream = it.body?.byteStream() ?: throw SummonApiException.invalidResponse
                val buffer = ByteArray(8192)
                while (true) {
                    kotlinx.coroutines.yield()
                    val count = stream.read(buffer)
                    if (count < 0) break
                    for (index in 0 until count) {
                        parser.append(buffer[index].toInt() and 0xFF)?.let { event -> receive(event) }
                    }
                }
                throw java.io.IOException("network connection lost")
            }
        } finally {
            call.cancel()
        }
    }
}

sealed class SummonStreamEvent {
    data object Connected : SummonStreamEvent()
    data object KeepAlive : SummonStreamEvent()
    data class Change(val type: String?, val roomID: String?, val botID: String?) : SummonStreamEvent()
}

private class SummonSseParser {
    private val line = ArrayList<Byte>(256)
    private val dataLines = ArrayList<String>()
    private var dataBytes = 0
    private var eventName: String? = null
    private var hasComment = false
    private var previousWasCR = false
    private var firstLine = true

    fun append(byte: Int): SummonStreamEvent? {
        val value = byte and 0xFF
        if (previousWasCR) {
            previousWasCR = false
            if (value == 0x0A) return null
        }
        if (value == 0x0D || value == 0x0A) {
            previousWasCR = value == 0x0D
            var text = line.toByteArray().toString(Charsets.UTF_8)
            line.clear()
            if (firstLine) {
                firstLine = false
                if (text.startsWith("\uFEFF")) text = text.drop(1)
            }
            return consumeLine(text)
        }
        if (line.size >= 4 * 1024 * 1024) throw java.io.IOException("cannot decode content data")
        line.add(value.toByte())
        return null
    }

    private fun consumeLine(value: String): SummonStreamEvent? {
        if (value.isEmpty()) {
            val lines = dataLines.toList()
            val comment = hasComment
            val name = eventName
            dataLines.clear()
            dataBytes = 0
            eventName = null
            hasComment = false
            if (lines.isEmpty()) return if (comment) SummonStreamEvent.KeepAlive else null
            val payload = runCatching { SummonJson.parse(lines.joinToString("\n")) }.getOrNull()
            val type = payload?.get("type")?.string ?: name
            if (type == "connected") return SummonStreamEvent.Connected
            val roomID = payload?.get("roomId")?.string ?: if (type == "room") payload?.get("id")?.string else null
            return SummonStreamEvent.Change(type, roomID, payload?.get("botId")?.string)
        }
        if (value.startsWith(":")) {
            hasComment = true
            return null
        }
        val colon = value.indexOf(':')
        val field: String
        var content: String
        if (colon >= 0) {
            field = value.substring(0, colon)
            content = value.substring(colon + 1)
            if (content.startsWith(" ")) content = content.drop(1)
        } else {
            field = value
            content = ""
        }
        if (field == "data") {
            dataBytes += content.toByteArray(Charsets.UTF_8).size
            if (dataBytes > 4 * 1024 * 1024) throw java.io.IOException("cannot decode content data")
            dataLines.add(content)
        } else if (field == "event") {
            eventName = content
        }
        return null
    }
}

object SummonKeystore {
    private const val fileName = "summon_connection_tokens"

    fun token(context: Context, endpoint: String): String =
        runCatching { prefs(context).getString(endpoint, "").orEmpty() }.getOrDefault("")

    fun save(context: Context, token: String, endpoint: String) {
        val editor = prefs(context).edit()
        if (token.isEmpty()) editor.remove(endpoint) else editor.putString(endpoint, token)
        if (!editor.commit()) throw SummonApiException("无法保存连接凭据，请在设备解锁后重试。")
    }

    private fun prefs(context: Context) = EncryptedSharedPreferences.create(
        context,
        fileName,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
}

fun mimeFor(context: Context, uri: Uri): String =
    context.contentResolver.getType(uri) ?: "application/octet-stream"

fun displayName(context: Context, uri: Uri): String {
    context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            val index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            if (index >= 0) cursor.getString(index)?.takeIf { it.isNotBlank() }?.let { return it }
        }
    }
    return uri.lastPathSegment?.substringAfterLast('/')?.ifBlank { null } ?: "附件"
}
