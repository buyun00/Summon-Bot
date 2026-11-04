package org.lin0.relay

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun OnboardingScreen(store: SummonStore, onBack: () -> Unit, onRoom: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val scroll = rememberScrollState()
    // Bootstrap messages and the password input are deliberately never saved to the chat store.
    var messages by remember { mutableStateOf(listOf(false to "你好，我是主 Bot，欢迎来到 Summon Bot。我们先把聊天模型接上，再边聊边熟悉这里。")) }
    var reply by remember { mutableStateOf<SummonJson>(SummonJson.Null) }
    var input by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun send(action: String, value: String = "", label: String? = null) {
        if (busy) return
        busy = true; error = null
        val hidden = reply["input"].string == "password"
        try {
            val next = store.request("/api/model-settings/onboarding/reply", "POST", SummonJson.obj(
                "action" to SummonJson.Str(action), "value" to SummonJson.Str(value), "draft" to reply["draft"]
            ))
            if (action !in listOf("hello", "poll")) messages = messages + (true to (if (hidden && action == "key") "已提交 API Key（内容已隐藏）" else label ?: value))
            next["text"].string?.takeIf { it.isNotBlank() }?.let { messages = messages + (false to it) }
            reply = next
            next["roomId"].string?.let { id -> store.refresh(); onRoom(id) }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            error = (failure.message ?: "暂时没有完成，请重试。")
                .replace(Regex("(?:sk-|xai-)[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"), "[密钥已隐藏]")
            if (action == "poll") reply = SummonJson.Obj(reply.obj.orEmpty() + mapOf("phase" to SummonJson.Str("login-error"), "login" to SummonJson.Null))
        }
        finally { busy = false }
    }
    LaunchedEffect(Unit) { send("hello") }
    LaunchedEffect(reply["phase"].string, reply["draft"]["id"].string) {
        while (reply["phase"].string == "login") { delay(2000); send("poll") }
    }
    LaunchedEffect(messages.size, error) { scroll.animateScrollTo(scroll.maxValue) }
    val phase = reply["phase"].string ?: ""
    val secure = reply["input"].string == "password"
    val editable = reply["input"].string != "none" && reply.obj != null
    fun submit() {
        val text = input.trim(); if (text.isEmpty() || busy) return
        input = ""
        val action = if (phase == "ready") "handoff" else phase
        scope.launch { send(action, text) }
    }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "稍后继续") }
            Column { Text("主 Bot", style = MaterialTheme.typography.titleMedium); Text("初次见面", style = MaterialTheme.typography.labelSmall, color = Color.Gray) }
        }
        Column(Modifier.weight(1f).verticalScroll(scroll).padding(18.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            messages.forEach { (user, text) ->
                Column(Modifier.fillMaxWidth(), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
                    Text(if (user) "你" else "主 Bot", style = MaterialTheme.typography.labelSmall, color = Color.Gray)
                    Text(text, Modifier.widthIn(max = 520.dp).background(if (user) Color(0xFF30332E) else Color(0xFF202022), RoundedCornerShape(16.dp)).padding(16.dp), style = MaterialTheme.typography.bodyMedium)
                }
            }
            if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            error?.let { Text(it, color = Color(0xFFFF9F0A)) }
            val login = reply["login"]
            login["userCode"].string?.let { Text(it, style = MaterialTheme.typography.headlineMedium) }
            login["verificationUri"].string?.takeIf { it.startsWith("https://") }?.let { url ->
                Button(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }) { Text("打开授权页面") }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                reply["options"].array.orEmpty().forEach { option ->
                    OutlinedButton(enabled = !busy, onClick = {
                        input = ""; scope.launch { send(option["action"].stringValue, option["value"].stringValue, option["label"].stringValue) }
                    }) { Text(option["label"].stringValue) }
                }
                if (reply.obj == null && !busy) OutlinedButton(onClick = { scope.launch { send("hello") } }) { Text("重新连接") }
            }
        }
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(value = input, onValueChange = { if (it.length <= if (secure) 16000 else 4000) input = it },
                modifier = Modifier.weight(1f), singleLine = true, enabled = editable && !busy,
                placeholder = { Text(reply["placeholder"].string ?: if (secure) "粘贴 API Key…" else "输入消息…") },
                visualTransformation = if (secure) PasswordVisualTransformation() else VisualTransformation.None,
                keyboardOptions = KeyboardOptions(keyboardType = if (secure) KeyboardType.Password else KeyboardType.Text))
            TextButton(onClick = { submit() }, enabled = editable && !busy && input.isNotBlank()) { Text("发送") }
        }
        Text(if (secure) "密钥只用于模型连接，不进入聊天或草稿" else if (phase == "ready") "下一条对话由你选择的模型回复" else "模型接通前，由本地引导陪你完成连接", Modifier.padding(horizontal = 18.dp, vertical = 4.dp), style = MaterialTheme.typography.labelSmall, color = Color.Gray)
    }
}
