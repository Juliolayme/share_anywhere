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
import androidx.compose.runtime.LaunchedEffect
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
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.shareanywhere.config.Flags
import app.shareanywhere.ui.dashboard.DashboardScreen
import app.shareanywhere.ui.devices.DevicesScreen
import app.shareanywhere.ui.history.HistoryScreen
import app.shareanywhere.ui.home.HomeScreen
import app.shareanywhere.ui.receive.JoinLinkScreen
import app.shareanywhere.ui.receive.JoinPreviewScreen
import app.shareanywhere.ui.receive.ReceiveNav
import app.shareanywhere.ui.receive.ReceiveScreen
import app.shareanywhere.ui.receive.ReceiveSessionScreen
import app.shareanywhere.ui.send.SendScreen
import app.shareanywhere.ui.session.SessionScreen
import app.shareanywhere.ui.settings.SettingsScreen
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.welcome.WelcomeScreen

/** Snackbar host shared by every screen (toasts and snackbars, PRD §3). */
val LocalSnackbar = staticCompositionLocalOf<SnackbarHostState> { error("LocalSnackbar not provided") }

/**
 * The app's navigation (docs/UX_SCREEN_MAP.md §2, §11): Welcome once before the start destination, then bottom
 * navigation between the tabs, and the Send and Receive flows above Transfer home. There is no sign-in destination in
 * this graph; account screens arrive as a nested graph reached only from account CTAs (milestone 6.4).
 */
@Composable
fun AppNav(
    welcomed: Boolean,
    flags: Flags,
    onWelcomed: () -> Unit,
    onTurnKeepScreenOn: () -> Unit,
    pendingRoute: String? = null,
    onPendingRouteHandled: () -> Unit = {},
    navController: NavHostController = rememberNavController()
) {
    // Fixed for the life of the graph: finishing Welcome navigates instead of changing the start destination.
    val start = rememberSaveable { if (welcomed) Routes.HOME else Routes.WELCOME }
    val snackbar = remember { SnackbarHostState() }
    val entry by navController.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val tabs = remember(flags) { Tabs.visible(flags) }
    // App Links and notification taps open a flow screen above Transfer home, never in front of Welcome's choice
    // for a first launch unless it is a share link (RX-3 opens without Welcome, as on the Web).
    LaunchedEffect(pendingRoute) {
        val target = pendingRoute ?: return@LaunchedEffect
        if (flags.sharing) {
            if (navController.currentDestination?.route == Routes.WELCOME) {
                onWelcomed()
                navController.navigate(Routes.HOME) { popUpTo(Routes.WELCOME) { inclusive = true } }
            }
            navController.navigate(target) {
                popUpTo(Routes.HOME) { inclusive = false }
                launchSingleTop = true
            }
        }
        onPendingRouteHandled()
    }

    CompositionLocalProvider(LocalSnackbar provides snackbar) {
        Scaffold(
            modifier = Modifier.semantics { testTagsAsResourceId = true },
            snackbarHost = { SnackbarHost(snackbar) },
            bottomBar = {
                // Bottom navigation only on the top-level tabs (design `showNav`); flow screens are full screen.
                if (route != null && tabs.any { it.route == route.substringBefore('?') }) {
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
                    HomeScreen(
                        onOpenHistory = { id -> navController.navigateTab(Routes.history(id)) },
                        onSend = if (flags.sharing) ({ navController.navigate(Routes.SEND) }) else null,
                        onReceive = if (flags.sharing) ({ navController.navigate(Routes.RECEIVE) }) else null
                    )
                }
                if (flags.sharing) sharingGraph(navController, onTurnKeepScreenOn)
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

/** Send (TR-2…TR-5) and Receive (RX-1…RX-7) destinations, milestone 6.2. */
private fun NavGraphBuilder.sharingGraph(nav: NavHostController, onTurnKeepScreenOn: () -> Unit) {
    val idArg = listOf(navArgument(Routes.ID_ARG) { type = NavType.StringType })
    val toHome: () -> Unit = { nav.popBackStack(Routes.HOME, inclusive = false) }
    val receiveNav: (ReceiveNav) -> Unit = { n ->
        when (n) {
            is ReceiveNav.Preview -> nav.navigate(Routes.rxPreview(n.sessionId))
            is ReceiveNav.Session ->
                nav.navigate(Routes.rxSession(n.sessionId)) { popUpTo(Routes.RECEIVE) { inclusive = false } }
        }
    }
    composable(Routes.SEND) {
        SendScreen(
            onBack = { nav.popBackStack() },
            onCreated = { id -> nav.navigate(Routes.session(id)) { popUpTo(Routes.HOME) { inclusive = false } } },
            onOpenSession = { id -> nav.navigate(Routes.session(id)) { popUpTo(Routes.HOME) { inclusive = false } } }
        )
    }
    composable(Routes.SESSION_PATTERN, arguments = idArg) { entry ->
        val id = entry.arguments?.getString(Routes.ID_ARG).orEmpty()
        SessionScreen(
            onExit = toHome,
            onNewSession = { nav.navigate(Routes.SEND) { popUpTo(Routes.HOME) { inclusive = false } } },
            onTurnKeepScreenOn = onTurnKeepScreenOn,
            onOpenDashboard = { nav.navigate(Routes.dashboard(id)) }
        )
    }
    composable(Routes.DASHBOARD_PATTERN, arguments = idArg) {
        DashboardScreen(onBack = { nav.popBackStack() }, onDone = toHome, onTurnKeepScreenOn = onTurnKeepScreenOn)
    }
    composable(Routes.RECEIVE) { ReceiveScreen(onBack = { nav.popBackStack() }, onNav = receiveNav) }
    composable(Routes.JOIN_LINK_PATTERN, arguments = listOf(navArgument(Routes.TOKEN_ARG) { type = NavType.StringType })) { entry ->
        val token = entry.arguments?.getString(Routes.TOKEN_ARG).orEmpty()
        JoinLinkScreen(
            token,
            onBack = { nav.navigate(Routes.RECEIVE) { popUpTo(Routes.HOME) { inclusive = false } } },
            onNav = { n ->
                when (n) {
                    is ReceiveNav.Preview -> nav.navigate(Routes.rxPreview(n.sessionId)) { popUpTo(Routes.HOME) { inclusive = false } }
                    is ReceiveNav.Session -> nav.navigate(Routes.rxSession(n.sessionId)) { popUpTo(Routes.HOME) { inclusive = false } }
                }
            }
        )
    }
    composable(Routes.RX_PREVIEW_PATTERN, arguments = idArg) {
        JoinPreviewScreen(
            onBack = {
                if (!nav.popBackStack(Routes.RECEIVE, inclusive = false)) {
                    nav.navigate(Routes.RECEIVE) { popUpTo(Routes.HOME) { inclusive = false } }
                }
            },
            onJoined = { id -> nav.navigate(Routes.rxSession(id)) { popUpTo(Routes.HOME) { inclusive = false } } }
        )
    }
    composable(Routes.RX_SESSION_PATTERN, arguments = idArg) {
        ReceiveSessionScreen(
            onAnotherCode = { nav.navigate(Routes.RECEIVE) { popUpTo(Routes.HOME) { inclusive = false } } },
            onTurnKeepScreenOn = onTurnKeepScreenOn,
            onDone = toHome
        )
    }
}
