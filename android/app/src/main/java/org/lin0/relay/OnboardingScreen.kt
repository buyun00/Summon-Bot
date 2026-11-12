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
import kotlinx.coroutines.CoroutineScope
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
    val botName = store.onboarding["bot"]["name"].string ?: "主 Bot"

    suspend fun send(action: String, value: String = "", label: String? = null) {
        if (busy) return
        busy = true; error = null
        val hidden = reply["input"].string == "password"
        try {
            val next = store.request("/api/model-settings/onboarding/reply", "POST", SummonJson.obj(
                "action" to SummonJson.Str(action), "value" to SummonJson.Str(value)
            ))
            if (action !in listOf("hello", "poll", "progress")) messages = messages + (true to (if (hidden && action == "key") "已提交 API Key（内容已隐藏）" else label ?: value))
            next["text"].string?.takeIf { it.isNotBlank() && (action != "progress" || next["phase"].string != reply["phase"].string) }?.let { messages = messages + (false to it) }
            reply = next
            next["roomId"].string?.let { id -> store.refresh(); onRoom(id) }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            error = if (action == "key") "API Key 未保存，请检查输入和模型配置后重试。" else (failure.message ?: "暂时没有完成，请重试。")
                .replace(Regex("(?:sk-|xai-)[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"), "[密钥已隐藏]")
            if (action == "poll") reply = SummonJson.Obj(reply.obj.orEmpty() + mapOf("phase" to SummonJson.Str("login-error"), "login" to SummonJson.Null))
        }
        finally { busy = false }
    }
    LaunchedEffect(Unit) { send("hello") }
    LaunchedEffect(reply["phase"].string) {
        while (reply["phase"].string in listOf("login", "waiting")) {
            delay(2000)
            send(if (reply["phase"].string == "login") "poll" else "progress")
        }
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
            Column { Text(botName, style = MaterialTheme.typography.titleMedium); Text("新手引导", style = MaterialTheme.typography.labelSmall, color = Color.Gray) }
        }
        Column(Modifier.weight(1f).verticalScroll(scroll).padding(18.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            messages.forEach { (user, text) ->
                Column(Modifier.fillMaxWidth(), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
                    Text(if (user) "你" else botName, style = MaterialTheme.typography.labelSmall, color = Color.Gray)
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

@Composable
fun WorkspaceConnectionGuide(store: SummonStore, scope: CoroutineScope) {
    var address by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var awaitingToken by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Column(
        Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()
            .verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Summon Bot", style = MaterialTheme.typography.labelLarge)
        Text("你好，我是主 Bot。", style = MaterialTheme.typography.headlineMedium)
        Text("欢迎来到 Summon Bot。告诉我你的工作区地址，我们就可以接着聊。")
        if (awaitingToken) {
            Text(address, color = Color.Gray)
            Text("接下来输入部署者给你的访问令牌。")
            OutlinedTextField(token, { token = it }, label = { Text("访问令牌") }, modifier = Modifier.fillMaxWidth(), singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), visualTransformation = PasswordVisualTransformation(), enabled = !saving)
            Button(enabled = !saving && token.isNotBlank(), onClick = {
                val credential = token.trim()
                token = ""; saving = true; error = null
                scope.launch {
                    try { store.saveConnection(address, credential) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (failure: Exception) { error = failure.localizedMessage }
                    finally { saving = false }
                }
            }) { Text(if (saving) "正在连接…" else "连接工作区") }
            TextButton(enabled = !saving, onClick = { awaitingToken = false; token = ""; error = null }) { Text("更改地址") }
        } else {
            OutlinedTextField(address, { address = it }, label = { Text("https://你的工作区地址") }, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), singleLine = true)
            Button(enabled = address.isNotBlank(), onClick = {
                try { address = SummonApiClient.normalized(address).toString(); awaitingToken = true; error = null }
                catch (failure: Exception) { error = failure.localizedMessage }
            }) { Text("继续") }
        }
        error?.let { Text(it, color = Color(0xFFFF9F0A)) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun OnboardingStep(store: SummonStore, roomID: String) {
    val guide = store.onboarding["guide"]
    val text = guide["text"].string ?: return
    if (store.onboarding["roomId"].string != roomID) return
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)
        .background(Color(0xFF202522), RoundedCornerShape(12.dp)).padding(12.dp)) {
        Text(text, style = MaterialTheme.typography.bodyMedium)
        guide["setup"]["progress"].string?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Color.Gray) }
        (error ?: guide["error"].string)?.let { Text(it, color = Color(0xFFFF9F0A)) }
        val local = guide["localControl"]
        val address = local["origin"].string?.takeIf { it.startsWith("https://") }
        if (address != null) TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(address))) }) { Text(address) }
        else if (local.obj != null) Text("请在部署机的桌面应用或安装 CLI 中完成设置。", color = Color.Gray, style = MaterialTheme.typography.bodySmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            guide["options"].array.orEmpty().forEach { option ->
                OutlinedButton(enabled = !busy, onClick = {
                    busy = true; error = null
                    scope.launch {
                        try {
                            store.request("/api/model-settings/onboarding/advance", "POST", SummonJson.obj(
                                "step" to guide["step"], "action" to option["action"], "messageId" to guide["messageId"]))
                            store.refresh()
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (failure: Exception) { error = failure.localizedMessage }
                        finally { busy = false }
                    }
                }) { Text(option["label"].stringValue) }
            }
        }
    }
}
