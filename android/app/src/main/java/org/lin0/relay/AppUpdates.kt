package org.lin0.relay

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.util.concurrent.TimeUnit

data class SummonClientRelease(val version: String, val buildNumber: Int, val downloadUrl: String, val size: Long, val local: Boolean)
data class SummonUpdateState(
    val checking: Boolean = false,
    val downloading: Boolean = false,
    val checked: Boolean = false,
    val progress: Int = 0,
    val latest: SummonClientRelease? = null,
    val downloaded: File? = null,
    val error: String? = null,
)

class SummonAppUpdater(private val app: Context, private val scope: CoroutineScope) {
    var state by mutableStateOf(SummonUpdateState())
        private set
    private val http = OkHttpClient.Builder().connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS).callTimeout(20, TimeUnit.MINUTES).build()
    private val localEndpoint = URI("http://localhost:8787/api/releases/android/universal/latest.json")
    private val githubBase = "https://github.com/${BuildConfig.SUMMON_GITHUB_REPOSITORY}/releases/download/client-android-universal/"
    private val githubEndpoint = URI("${githubBase}latest.json")
    private val localHttp = http.newBuilder().connectTimeout(1200, TimeUnit.MILLISECONDS)
        .readTimeout(1200, TimeUnit.MILLISECONDS).callTimeout(1200, TimeUnit.MILLISECONDS).build()
    private var lastCheck = 0L
    private var awaitingPermission = false

    private fun readRelease(local: Boolean): SummonClientRelease? {
        val endpoint = if (local) localEndpoint else githubEndpoint
        val client = if (local) localHttp else http
        return client.newCall(Request.Builder().url(endpoint.toString()).header("Cache-Control", "no-cache").build()).execute().use { response ->
            if (response.code == 404) return null
            if (!response.isSuccessful) error("暂时无法检查更新，请稍后重试。")
            val value = JSONObject(response.body?.string() ?: error("无法读取版本信息。"))
            require(value.getString("platform") == "android" && value.getString("arch") == "universal") { "版本信息无效。" }
            val path = value.getString("downloadUrl")
            val url = endpoint.resolve(path)
            require(if (local) url.scheme == endpoint.scheme && url.authority == endpoint.authority && url.path.startsWith("/api/releases/android/universal/")
                else url.toString().startsWith(githubBase)) { "下载地址无效。" }
            val files = value.getJSONArray("files")
            var size = 0L
            for (index in 0 until files.length()) if (files.getJSONObject(index).getString("url") == path) size = files.getJSONObject(index).getLong("size")
            SummonClientRelease(value.getString("version"), value.getInt("buildNumber"), url.toString(), size, local)
        }
    }

    fun check(manual: Boolean = false) {
        if (state.checking || state.downloading || (!manual && System.currentTimeMillis() - lastCheck < 4 * 60 * 60 * 1000L)) return
        lastCheck = System.currentTimeMillis()
        state = state.copy(checking = true, error = null)
        scope.launch {
            try {
                val latest = withContext(Dispatchers.IO) {
                    val local = try { readRelease(local = true) } catch (error: Exception) { if (error is CancellationException) throw error; null }
                    local ?: readRelease(local = false)
                }
                val available = latest?.takeIf { it.buildNumber > BuildConfig.VERSION_CODE }
                val cached = available?.let { release -> apkFile(release).takeIf { it.isFile && it.length() == release.size } }
                state = state.copy(checking = false, checked = true, latest = available, downloaded = cached)
                if (available == null) withContext(Dispatchers.IO) { updateDirectory().listFiles()?.forEach { it.delete() } }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                state = state.copy(checking = false, error = "暂时无法检查更新，请稍后重试。")
            }
        }
    }

    private fun updateDirectory() = File(app.cacheDir, "RelayDownloads/updates").apply { mkdirs() }
    private fun apkFile(release: SummonClientRelease) = File(updateDirectory(), "Summon-Bot-${release.buildNumber}.apk")

    fun download() {
        val release = state.latest ?: return
        if (state.downloading) return
        state = state.copy(downloading = true, progress = 0, error = null)
        scope.launch {
            try {
                val file = withContext(Dispatchers.IO) {
                    try { saveApk(release) }
                    catch (error: Exception) {
                        if (error is CancellationException || !release.local) throw error
                        val remote = readRelease(local = false)?.takeIf { it.buildNumber > BuildConfig.VERSION_CODE } ?: throw error
                        withContext(Dispatchers.Main) { state = state.copy(latest = remote, progress = 0) }
                        saveApk(remote)
                    }
                }
                state = state.copy(downloading = false, downloaded = file, progress = 100)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                state = state.copy(downloading = false, error = error.message ?: "下载失败，请重试。")
            }
        }
    }

    private suspend fun saveApk(release: SummonClientRelease): File {
        val destination = apkFile(release)
        val partial = File(destination.path + ".part")
        updateDirectory().listFiles()?.filter { it != destination }?.forEach { it.delete() }
        try {
            http.newCall(Request.Builder().url(release.downloadUrl).build()).execute().use { response ->
                if (!response.isSuccessful) error("下载未完成，请重新检查更新。")
                val body = response.body ?: error("无法读取更新包。")
                body.byteStream().use { input ->
                    partial.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var downloaded = 0L
                        var previousPercent = -1
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count); downloaded += count
                            val percent = if (release.size > 0) (downloaded * 100 / release.size).toInt().coerceIn(0, 100) else 0
                            if (percent != previousPercent) {
                                previousPercent = percent
                                withContext(Dispatchers.Main) { state = state.copy(progress = percent) }
                            }
                        }
                        if (release.size > 0 && downloaded != release.size) error("下载未完成，请重试。")
                    }
                }
            }
            if (destination.exists()) destination.delete()
            check(partial.renameTo(destination)) { "无法保存更新包，请重试。" }
            return destination
        } finally { partial.delete() }
    }

    fun install(context: Context) {
        val file = state.downloaded?.takeIf { it.isFile } ?: return
        try {
            if (!context.packageManager.canRequestPackageInstalls()) {
                awaitingPermission = true
                context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return
            }
            awaitingPermission = false
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
            context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) { state = state.copy(error = "无法打开安装程序，请稍后重试。") }
    }

    fun resumeInstall() {
        if (awaitingPermission && app.packageManager.canRequestPackageInstalls()) install(app)
    }
}

@Composable
fun ClientUpdateSettings(updater: SummonAppUpdater) {
    val context = LocalContext.current
    val state = updater.state
    Column(Modifier.fillMaxWidth().padding(vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("客户端更新", style = MaterialTheme.typography.titleMedium)
        Text("当前版本 ${BuildConfig.VERSION_NAME}", color = Color(0xFF8E8E93))
        val status = when {
            state.checking -> "正在检查更新…"
            state.downloading -> "正在下载 ${state.latest?.version} · ${state.progress}%"
            state.downloaded != null -> "${state.latest?.version} 已下载，可覆盖更新。"
            state.latest != null -> "发现新版本 ${state.latest.version}"
            state.checked -> "已是最新版本。"
            else -> "检查并下载最新 Android 客户端。"
        }
        Text(status, style = MaterialTheme.typography.bodySmall)
        state.error?.let { Text(it, color = Color(0xFFFF9F0A), style = MaterialTheme.typography.bodySmall) }
        if (state.downloading) LinearProgressIndicator(progress = { state.progress / 100f }, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { updater.check(manual = true) }, enabled = !state.checking && !state.downloading) { Text("检查更新") }
            if (state.latest != null && !state.downloading) Button(onClick = {
                if (state.downloaded != null) updater.install(context) else updater.download()
            }) { Text(if (state.downloaded != null) "安装更新" else "下载更新") }
        }
    }
}
