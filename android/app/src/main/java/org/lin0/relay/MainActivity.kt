package org.lin0.relay

import android.app.Activity
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
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
    val systemDark = isSystemInDarkTheme()
    val isDark = when (model.display.appearance) {
        SummonAppearance.System -> systemDark
        SummonAppearance.Light -> false
        SummonAppearance.Dark -> true
    }
    val palette = if (isDark) DarkSummonPalette else LightSummonPalette
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            val insets = WindowCompat.getInsetsController(window, view)
            insets.isAppearanceLightStatusBars = !isDark
            insets.isAppearanceLightNavigationBars = !isDark
        }
    }
    val colorScheme = if (isDark) {
        darkColorScheme(
            background = palette.background,
            surface = palette.surface,
            surfaceVariant = palette.surfaceElevated,
            surfaceContainer = palette.surface,
            surfaceContainerHigh = palette.surfaceElevated,
            primary = Color(0xFFEDF0F7),
            onPrimary = Color(0xFF14161D),
            secondary = palette.ok,
            onSecondary = Color(0xFF0B0C10),
            onBackground = Color(0xFFEDF0F7),
            onSurface = Color(0xFFEDF0F7),
            onSurfaceVariant = palette.textSecondary,
            outline = palette.bubbleStroke,
            outlineVariant = palette.hairline,
        )
    } else {
        lightColorScheme(
            background = palette.background,
            surface = palette.surface,
            surfaceVariant = palette.surfaceElevated,
            surfaceContainer = palette.surface,
            surfaceContainerHigh = palette.surfaceElevated,
            primary = Color(0xFF252320),
            onPrimary = Color(0xFFFAF8F4),
            secondary = palette.ok,
            onSecondary = Color(0xFFFAF8F4),
            onBackground = Color(0xFF1F1D1A),
            onSurface = Color(0xFF1F1D1A),
            onSurfaceVariant = palette.textSecondary,
            outline = palette.bubbleStroke,
            outlineVariant = palette.hairline,
        )
    }
    SummonDisplay(model.display) {
        CompositionLocalProvider(
            LocalSummonIsDark provides isDark,
            LocalSummonPalette provides palette,
        ) {
            MaterialTheme(typography = summonTypography, colorScheme = colorScheme) {
                Surface(Modifier.fillMaxSize(), color = palette.background) {
                    if (store.settings.baseURL.isBlank()) {
                        SummonConnectionGuide(store, model.viewModelScope)
                        return@Surface
                    }
                    val nav = rememberNavController()
                    NavHost(nav, startDestination = "list",
                        enterTransition = { slideInHorizontally(tween(340)) { it } },
                        exitTransition = { slideOutHorizontally(tween(340)) { -it / 4 } },
                        popEnterTransition = { slideInHorizontally(tween(340)) { -it / 4 } },
                        popExitTransition = { slideOutHorizontally(tween(340)) { it } }) {
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
}
