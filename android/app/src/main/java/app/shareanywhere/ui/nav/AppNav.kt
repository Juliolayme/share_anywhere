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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
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
import app.shareanywhere.account.keys.KeyStatus
import app.shareanywhere.config.Flags
import app.shareanywhere.ui.account.ChecklistScreen
import app.shareanywhere.ui.account.ForgotScreen
import app.shareanywhere.ui.account.KeyPairScreen
import app.shareanywhere.ui.account.KeySetupScreen
import app.shareanywhere.ui.account.SignInScreen
import app.shareanywhere.ui.account.SignUpScreen
import app.shareanywhere.ui.account.TrustScreen
import app.shareanywhere.ui.clipboard.ClipboardActions
import app.shareanywhere.ui.clipboard.ClipboardScreen
import app.shareanywhere.ui.clipboard.ClipboardSettingsScreen
import app.shareanywhere.ui.dashboard.DashboardScreen
import app.shareanywhere.ui.devices.DeviceAccountActions
import app.shareanywhere.ui.devices.DevicesScreen
import app.shareanywhere.ui.history.HistoryScreen
import app.shareanywhere.ui.history.HistorySyncActions
import app.shareanywhere.ui.home.HomeScreen
import app.shareanywhere.ui.receive.JoinLinkScreen
import app.shareanywhere.ui.receive.JoinPreviewScreen
import app.shareanywhere.ui.receive.ReceiveNav
import app.shareanywhere.ui.receive.ReceiveScreen
import app.shareanywhere.ui.receive.ReceiveSessionScreen
import app.shareanywhere.ui.send.SendScreen
import app.shareanywhere.ui.session.SessionScreen
import app.shareanywhere.ui.settings.AccountActions
import app.shareanywhere.ui.settings.SettingsScreen
import app.shareanywhere.ui.theme.LocalSaPalette
import app.shareanywhere.ui.welcome.WelcomeScreen

/** Snackbar host shared by every screen (toasts and snackbars, PRD §3). */
val LocalSnackbar = staticCompositionLocalOf<SnackbarHostState> { error("LocalSnackbar not provided") }

/**
 * The app's navigation (docs/UX_SCREEN_MAP.md §2, §11): Welcome once before the start destination, then bottom
 * navigation between the tabs, and the Send and Receive flows above Transfer home. Account screens are a nested graph
 * reached only from account CTAs (Settings, Devices, Clipboard); nothing in the Transfer flows leads there.
 */
@Composable
fun AppNav(
    welcomed: Boolean,
    flags: Flags,
    onWelcomed: () -> Unit,
    onTurnKeepScreenOn: () -> Unit,
    pendingRoute: String? = null,
    onPendingRouteHandled: () -> Unit = {},
    clipboardSync: Int = 0,
    onClipboardSyncHandled: () -> Unit = {},
    navController: NavHostController = rememberNavController()
) {
    // Fixed for the life of the graph: finishing Welcome navigates instead of changing the start destination.
    val start = rememberSaveable { if (welcomed) Routes.HOME else Routes.WELCOME }
    // Where the account flow returns (docs/UX_SCREEN_MAP.md §9: every entry point gets its screen back).
    var accountReturn by rememberSaveable { mutableStateOf(Routes.HOME) }
    val snackbar = remember { SnackbarHostState() }
    val entry by navController.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val tabs = remember(flags) { Tabs.visible(flags) }
    // App Links and notification taps open a flow screen above Transfer home, never in front of Welcome's choice
    // for a first launch unless it is a share link (RX-3 opens without Welcome, as on the Web).
    LaunchedEffect(pendingRoute) {
        val target = pendingRoute ?: return@LaunchedEffect
        if (target == ScreenIds.CLIPBOARD) {
            if (flags.clipboard && navController.currentDestination?.route != Routes.WELCOME) navController.navigateTab(target)
        } else if (flags.sharing) {
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
                        onReceive = if (flags.sharing) ({ navController.navigate(Routes.RECEIVE) }) else null,
                        onOpenLive = { id, receiving ->
                            navController.navigate(if (receiving) Routes.rxSession(id) else Routes.dashboard(id))
                        }
                    )
                }
                if (flags.sharing) sharingGraph(navController, onTurnKeepScreenOn)
                val acct = AccountNav(navController, accountReturn) { accountReturn = it }
                composable(
                    Routes.HISTORY_PATTERN,
                    arguments = listOf(
                        navArgument(Routes.HISTORY_ARG) {
                            type = NavType.StringType
                            nullable = true
                            defaultValue = null
                        }
                    )
                ) {
                    HistoryScreen(
                        sync =
                        if (flags.accounts) {
                            HistorySyncActions(
                                signIn = acct.signIn(Routes.HISTORY),
                                addDevice = acct.addDevice(Routes.HISTORY),
                                setUpKeys = { navController.navigate(Routes.keySetup(flow = false)) },
                                pair = { navController.navigate(Routes.keyPair(flow = false, phrase = false)) },
                                phrase = { navController.navigate(Routes.keyPair(flow = false, phrase = true)) }
                            )
                        } else {
                            null
                        }
                    )
                }
                composable(Routes.DEVICES) {
                    DevicesScreen(
                        account = if (flags.accounts) {
                            DeviceAccountActions(
                                acct.signIn(Routes.DEVICES),
                                acct.create(Routes.DEVICES),
                                acct.addDevice(Routes.DEVICES)
                            )
                        } else {
                            null
                        }
                    )
                }
                composable(Routes.SETTINGS) {
                    SettingsScreen(
                        account =
                        if (flags.accounts) {
                            AccountActions(
                                signIn = acct.signIn(Routes.SETTINGS),
                                create = acct.create(Routes.SETTINGS),
                                addDevice = acct.addDevice(Routes.SETTINGS),
                                setUpKeys = { navController.navigate(Routes.keySetup(flow = false)) },
                                pair = { navController.navigate(Routes.keyPair(flow = false, phrase = false)) },
                                phrase = { navController.navigate(Routes.keyPair(flow = false, phrase = true)) },
                                manageDevices = { navController.navigateTab(Routes.DEVICES) },
                                clipboardSettings = if (flags.clipboard) {
                                    (
                                        {
                                            navController.navigate(ScreenIds.CLIPBOARD_SETTINGS)
                                        }
                                        )
                                } else {
                                    null
                                }
                            )
                        } else {
                            null
                        }
                    )
                }
                if (flags.clipboard) {
                    composable(ScreenIds.CLIPBOARD) {
                        ClipboardScreen(
                            ClipboardActions(
                                signIn = acct.signIn(ScreenIds.CLIPBOARD),
                                create = acct.create(ScreenIds.CLIPBOARD),
                                addDevice = acct.addDevice(ScreenIds.CLIPBOARD),
                                setUpKeys = { navController.navigate(Routes.keySetup(flow = false)) },
                                pair = { navController.navigate(Routes.keyPair(flow = false, phrase = false)) },
                                phrase = { navController.navigate(Routes.keyPair(flow = false, phrase = true)) },
                                settings = { navController.navigate(ScreenIds.CLIPBOARD_SETTINGS) }
                            ),
                            syncRequest = clipboardSync,
                            onSyncHandled = onClipboardSyncHandled
                        )
                    }
                    composable(ScreenIds.CLIPBOARD_SETTINGS) {
                        ClipboardSettingsScreen(onBack = {
                            navController.popBackStack()
                        }, onOpenClipboard = { navController.navigateTab(ScreenIds.CLIPBOARD) })
                    }
                }
                if (flags.accounts) accountGraph(acct, flags)
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

/** Entry points into the account graph, each remembering the screen to come back to. */
class AccountNav(val nav: NavHostController, val returnTo: String, private val setReturn: (String) -> Unit) {
    fun signIn(from: String): () -> Unit = {
        setReturn(from)
        nav.navigate(Routes.SIGNIN)
    }

    fun create(from: String): () -> Unit = {
        setReturn(from)
        nav.navigate(Routes.SIGNUP)
    }

    fun addDevice(from: String): () -> Unit = {
        setReturn(from)
        nav.navigate(Routes.trust(flow = true))
    }

    /** Leaves the account graph for the screen it started from. */
    fun finish() {
        if (!nav.popBackStack(returnTo, inclusive = false)) nav.navigateTab(returnTo)
    }
}

/** AC-1…AC-8 (milestone 6.4). */
private fun NavGraphBuilder.accountGraph(acct: AccountNav, flags: Flags) {
    val nav = acct.nav
    val flowArg = navArgument(Routes.FLOW_ARG) {
        type = NavType.BoolType
        defaultValue = true
    }
    val toTrust: () -> Unit = { nav.navigate(Routes.trust(flow = true)) { popUpTo(acct.returnTo) { inclusive = false } } }
    composable(Routes.SIGNIN) {
        SignInScreen(onBack = { nav.popBackStack() }, onSignedIn = toTrust, onCreate = {
            nav.navigate(Routes.SIGNUP) {
                popUpTo(Routes.SIGNIN) {
                    inclusive =
                        true
                }
            }
        }, onForgot = {
            nav.navigate(Routes.FORGOT)
        })
    }
    composable(Routes.SIGNUP) {
        SignUpScreen(onBack = { nav.popBackStack() }, onSignedUp = toTrust, onSignIn = {
            nav.navigate(Routes.SIGNIN) {
                popUpTo(Routes.SIGNUP) {
                    inclusive =
                        true
                }
            }
        })
    }
    composable(Routes.FORGOT) { ForgotScreen(onBack = { nav.popBackStack() }) }
    val afterKeys: (
        Boolean
    ) -> Unit = { flow ->
        if (flow) nav.navigate(Routes.CHECKLIST) { popUpTo(acct.returnTo) { inclusive = false } } else nav.popBackStack()
    }
    composable(Routes.TRUST_PATTERN, arguments = listOf(flowArg)) {
        TrustScreen(onNext = { status ->
            val target =
                when (status) {
                    KeyStatus.Setup -> Routes.keySetup(flow = true)
                    KeyStatus.Pair, KeyStatus.Rejected, KeyStatus.Refused -> Routes.keyPair(flow = true, phrase = false)
                    else -> Routes.CHECKLIST
                }
            nav.navigate(target) { popUpTo(acct.returnTo) { inclusive = false } }
        })
    }
    composable(Routes.KEY_SETUP_PATTERN, arguments = listOf(flowArg)) { entry ->
        val flow = entry.arguments?.getBoolean(Routes.FLOW_ARG) ?: true
        KeySetupScreen(onBack = { if (flow) afterKeys(true) else nav.popBackStack() }, onDone = { afterKeys(flow) }, onKeysExist = {
            nav.navigate(Routes.keyPair(flow, phrase = false)) { popUpTo(Routes.KEY_SETUP_PATTERN) { inclusive = true } }
        })
    }
    composable(
        Routes.KEY_PAIR_PATTERN,
        arguments = listOf(
            flowArg,
            navArgument(Routes.PHRASE_ARG) {
                type = NavType.BoolType
                defaultValue = false
            }
        )
    ) { entry ->
        val flow = entry.arguments?.getBoolean(Routes.FLOW_ARG) ?: true
        val phrase = entry.arguments?.getBoolean(Routes.PHRASE_ARG) ?: false
        KeyPairScreen(phraseFirst = phrase, onBack = { if (flow) afterKeys(true) else nav.popBackStack() }, onDone = { afterKeys(flow) })
    }
    composable(Routes.CHECKLIST) {
        ChecklistScreen(
            fromClipboard = acct.returnTo == ScreenIds.CLIPBOARD,
            onContinue = { acct.finish() },
            onClipboard = { nav.navigateTab(ScreenIds.CLIPBOARD) },
            onAddDevice = { nav.navigate(Routes.trust(flow = true)) },
            onSetUpKeys = { nav.navigate(Routes.keySetup(flow = true)) },
            onPair = { nav.navigate(Routes.keyPair(flow = true, phrase = false)) },
            clipboardEnabled = flags.clipboard
        )
    }
}
