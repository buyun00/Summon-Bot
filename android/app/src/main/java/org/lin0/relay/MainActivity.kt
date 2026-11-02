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

class RelayViewModel(app: Application) : AndroidViewModel(app) {
    val store = RelayStore(app)
    override fun onCleared() {
        store.dispose()
    }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { RelayApp() }
    }
}

@Composable
private fun RelayApp(model: RelayViewModel = viewModel()) {
    val store = model.store
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, store) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> model.viewModelScope.launch { store.reconnect() }
                Lifecycle.Event.ON_STOP -> store.disconnect()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    MaterialTheme(colorScheme = darkColorScheme(
        background = Color.Black,
        surface = Color(0xFF1C1C1E),
        primary = Color.White,
        onPrimary = Color.Black,
        onBackground = Color.White,
        onSurface = Color.White,
    )) {
        Surface(Modifier.fillMaxSize(), color = Color.Black) {
            val nav = rememberNavController()
            NavHost(nav, startDestination = "list",
                enterTransition = { slideInHorizontally(tween(380)) { it } },
                exitTransition = { slideOutHorizontally(tween(380)) { -it / 4 } },
                popEnterTransition = { slideInHorizontally(tween(380)) { -it / 4 } },
                popExitTransition = { slideOutHorizontally(tween(380)) { it } }) {
                composable("list") {
                    ConversationListScreen(
                        store,
                        onOpenRoom = { id -> nav.navigate("chat/${URLEncoder.encode(id, "UTF-8")}") },
                        onOpenWorkspace = { section -> nav.navigate("workspace/${section.name}") },
                    )
                }
                composable("chat/{roomId}", arguments = listOf(navArgument("roomId") { type = NavType.StringType })) { entry ->
                    val id = URLDecoder.decode(entry.arguments?.getString("roomId").orEmpty(), "UTF-8")
                    ChatScreen(store, id) { nav.popBackStack() }
                }
                composable("workspace/{section}") { entry ->
                    val section = runCatching { WorkspaceSection.valueOf(entry.arguments?.getString("section").orEmpty()) }.getOrDefault(WorkspaceSection.Bots)
                    WorkspaceScreen(store, section) { nav.popBackStack() }
                }
            }
        }
    }
}
