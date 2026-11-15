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
        Text("连接 Summon Bot", style = MaterialTheme.typography.headlineMedium)
        Text("输入部署者提供的工作区地址和访问令牌。")
        if (awaitingToken) {
            Text(address, color = Color.Gray)
            Text("接下来输入部署者给你的访问令牌。")
            OutlinedTextField(token, { token = it }, label = { Text("访问令牌") }, modifier = Modifier.fillMaxWidth(), singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), visualTransformation = PasswordVisualTransformation(), enabled = !saving)
            Button(enabled = !saving && token.isNotBlank(), onClick = {
                val credential = token.trim()
                saving = true; error = null
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
