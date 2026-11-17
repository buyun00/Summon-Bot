package org.lin0.relay

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.core.tween
import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import java.net.URLDecoder
import java.net.URLEncoder

class SummonViewModel(app: Application) : AndroidViewModel(app) {
    val store = SummonStore(app)
    val updater = SummonAppUpdater(app, viewModelScope)
    val display = SummonDisplayPreferences(app)
    override fun onCleared() {
        store.dispose()
    }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val migrationWarning = try { SummonBrandingMigration.run(this); null }
        catch (error: Exception) { error.localizedMessage ?: "部分本机设置等待迁移。" }
        enableEdgeToEdge()
        setContent { SummonApp() }
        if (migrationWarning != null) {
            android.widget.Toast.makeText(this, migrationWarning, android.widget.Toast.LENGTH_LONG).show()
        }
    }
}

@Composable
private fun SummonApp(model: SummonViewModel = viewModel()) {
    val store = model.store
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, store) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> {
                    model.viewModelScope.launch { store.reconnect() }
                    model.updater.resumeInstall()
                    model.updater.check()
                }
                Lifecycle.Event.ON_STOP -> store.disconnect()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    SummonDisplay(model.display) {
        MaterialTheme(typography = summonTypography, colorScheme = darkColorScheme(
            background = Color.Black,
            surface = Color(0xFF1C1C1E),
            primary = Color.White,
            onPrimary = Color.Black,
            onBackground = Color.White,
            onSurface = Color.White,
        )) {
            Surface(Modifier.fillMaxSize(), color = Color.Black) {
                if (store.settings.baseURL.isBlank()) {
                    SummonConnectionGuide(store, model.viewModelScope)
                    return@Surface
                }
                val nav = rememberNavController()
                NavHost(nav, startDestination = "list",
                    enterTransition = { slideInHorizontally(tween(380)) { it } },
                    exitTransition = { slideOutHorizontally(tween(380)) { -it / 4 } },
                    popEnterTransition = { slideInHorizontally(tween(380)) { -it / 4 } },
                    popExitTransition = { slideOutHorizontally(tween(380)) { it } }) {
                    composable("list") {
                        ConversationListScreen(
                            store,
                            updater = model.updater,
                            onOpenUsage = { nav.navigate("usage") },
                            onOpenModels = { nav.navigate("models") },
                            onOpenRoom = { id -> nav.navigate("chat/${URLEncoder.encode(id, "UTF-8")}") },
                            onOpenResource = { section -> nav.navigate("resources/${section.name}") },
                        )
                    }
                    composable("chat/{roomId}", arguments = listOf(navArgument("roomId") { type = NavType.StringType })) { entry ->
                        val id = URLDecoder.decode(entry.arguments?.getString("roomId").orEmpty(), "UTF-8")
                        ChatScreen(store, id) { nav.popBackStack() }
                    }
                    composable("usage") { TokenUsageScreen(store) { nav.popBackStack() } }
                    composable("models") { ModelSettingsScreen(store) { nav.popBackStack() } }
                    composable("resources/{section}") { entry ->
                        val section = runCatching { ResourceSection.valueOf(entry.arguments?.getString("section").orEmpty()) }.getOrDefault(ResourceSection.Bots)
                        ResourcesScreen(store, section, onBack = { nav.popBackStack() })
                    }
                }
            }
        }
    }
}
