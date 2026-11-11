package app.shareanywhere.ui.nav

import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.shareanywhere.config.Flags
import app.shareanywhere.ui.devices.DevicesScreen
import app.shareanywhere.ui.history.HistoryScreen
import app.shareanywhere.ui.home.HomeScreen
import app.shareanywhere.ui.settings.SettingsScreen
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.welcome.WelcomeScreen

/** Snackbar host shared by every screen (toasts and snackbars, PRD §3). */
val LocalSnackbar = staticCompositionLocalOf<SnackbarHostState> { error("LocalSnackbar not provided") }

/**
 * The app's navigation (docs/UX_SCREEN_MAP.md §2, §11): Welcome once before the start destination, then bottom
 * navigation between the tabs. There is no sign-in destination in this graph; account screens arrive as a nested
 * graph reached only from account CTAs (milestone 6.4).
 */
@Composable
fun AppNav(welcomed: Boolean, flags: Flags, onWelcomed: () -> Unit, navController: NavHostController = rememberNavController()) {
    // Fixed for the life of the graph: finishing Welcome navigates instead of changing the start destination.
    val start = rememberSaveable { if (welcomed) Routes.HOME else Routes.WELCOME }
    val snackbar = remember { SnackbarHostState() }
    val entry by navController.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val tabs = remember(flags) { Tabs.visible(flags) }

    CompositionLocalProvider(LocalSnackbar provides snackbar) {
        Scaffold(
            modifier = Modifier.semantics { testTagsAsResourceId = true },
            snackbarHost = { SnackbarHost(snackbar) },
            bottomBar = {
                if (route != null && route != Routes.WELCOME) {
                    BottomBar(tabs, entry?.destination, navController)
                }
            }
        ) { padding ->
            NavHost(
                navController = navController,
                startDestination = start,
                modifier = Modifier.padding(padding).consumeWindowInsets(padding)
            ) {
                composable(Routes.WELCOME) {
                    WelcomeScreen(onStart = {
                        onWelcomed()
                        navController.navigate(Routes.HOME) { popUpTo(Routes.WELCOME) { inclusive = true } }
                    })
                }
                composable(Routes.HOME) {
                    HomeScreen(onOpenHistory = { id -> navController.navigateTab(Routes.history(id)) })
                }
                composable(
                    Routes.HISTORY_PATTERN,
                    arguments = listOf(
                        navArgument(Routes.HISTORY_ARG) {
                            type = NavType.StringType
                            nullable = true
                            defaultValue = null
                        }
                    )
                ) { HistoryScreen() }
                composable(Routes.DEVICES) { DevicesScreen() }
                composable(Routes.SETTINGS) { SettingsScreen() }
            }
        }
    }
}

@Composable
private fun BottomBar(tabs: List<Tab>, destination: androidx.navigation.NavDestination?, navController: NavHostController) {
    val p = LocalSaPalette.current
    NavigationBar(containerColor = MaterialTheme.colorScheme.surface, modifier = Modifier.testTag("nav")) {
        for (tab in tabs) {
            val selected = destination?.hierarchy?.any { it.route?.substringBefore('?') == tab.route } == true
            NavigationBarItem(
                selected = selected,
                onClick = { navController.navigateTab(tab.route) },
                icon = { Icon(painterResource(tab.icon), contentDescription = null) },
                label = { Text(stringResource(tab.label)) },
                colors =
                NavigationBarItemDefaults.colors(
                    indicatorColor = p.sendSoft,
                    selectedIconColor = p.fg,
                    selectedTextColor = p.fg,
                    unselectedIconColor = p.fg2,
                    unselectedTextColor = p.fg2
                ),
                modifier = Modifier.testTag("nav.${tab.route}")
            )
        }
    }
}

/**
 * Switches tabs keeping one copy of each on the back stack (Material bottom-navigation behaviour). Transfer home
 * is always the bottom of the stack (Welcome, when shown, was popped), so Back from any tab returns there and Back
 * from Transfer home leaves the app.
 */
fun NavHostController.navigateTab(route: String) {
    navigate(route) {
        popUpTo(Routes.HOME) { saveState = true }
        launchSingleTop = true
        restoreState = !route.contains('?')
    }
}
