package org.lin0.relay

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

@Composable
fun SummonConnectionGuide(store: SummonStore, scope: CoroutineScope) {
    val palette = LocalSummonPalette.current
    var isRegister by remember { mutableStateOf(false) }
    var hubURL by remember { mutableStateOf(SummonApiClient.DEFAULT_HUB_URL) }
    var showAdvanced by remember { mutableStateOf(false) }
    var inviteCode by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()
            .verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Summon Bot", style = MaterialTheme.typography.labelLarge)
        Text("连接你的电脑中枢", style = MaterialTheme.typography.headlineMedium)
        Text("登录账号后，手机会自动聚合你名下所有在线电脑的群聊。", color = palette.textSecondary)

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!isRegister) {
                Button(onClick = { isRegister = false }, modifier = Modifier.weight(1f)) { Text("账号登录") }
                OutlinedButton(onClick = { isRegister = true }, modifier = Modifier.weight(1f)) { Text("邀请码注册") }
            } else {
                OutlinedButton(onClick = { isRegister = false }, modifier = Modifier.weight(1f)) { Text("账号登录") }
                Button(onClick = { isRegister = true }, modifier = Modifier.weight(1f)) { Text("邀请码注册") }
            }
        }

        if (isRegister) {
            OutlinedTextField(
                inviteCode, { inviteCode = it },
                label = { Text("邀请码") },
                placeholder = { Text("例如 SUMMON-XXXX-XXXX-XXXX") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                enabled = !saving,
            )
        }
        OutlinedTextField(
            username, { username = it },
            label = { Text("用户名") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            enabled = !saving,
        )
        if (isRegister) {
            OutlinedTextField(
                displayName, { displayName = it },
                label = { Text("显示名称（可选）") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                enabled = !saving,
            )
        }
        OutlinedTextField(
            password, { password = it },
            label = { Text(if (isRegister) "密码（至少 8 位）" else "密码") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            visualTransformation = PasswordVisualTransformation(),
            enabled = !saving,
        )

        TextButton(onClick = { showAdvanced = !showAdvanced }, enabled = !saving) {
            Text(if (showAdvanced) "收起自定义中枢地址" else "自定义自部署中枢地址")
        }
        if (showAdvanced) {
            OutlinedTextField(
                hubURL, { hubURL = it },
                label = { Text("中枢地址") },
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                singleLine = true,
                enabled = !saving,
            )
        }

        val canSubmit = !saving && username.isNotBlank() && password.isNotEmpty() && (!isRegister || inviteCode.isNotBlank())
        Button(
            enabled = canSubmit,
            modifier = Modifier.fillMaxWidth(),
            onClick = {
                saving = true; error = null
                scope.launch {
                    try {
                        if (isRegister) {
                            store.registerHub(hubURL, inviteCode, username, password, displayName)
                        } else {
                            store.loginHub(hubURL, username, password)
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (failure: Exception) {
                        error = failure.localizedMessage ?: "连接失败"
                    } finally {
                        saving = false
                    }
                }
            },
        ) {
            Text(if (saving) "正在连接中枢…" else if (isRegister) "注册并连接" else "登录")
        }
        error?.let { Text(it, color = palette.warn) }
    }
}
