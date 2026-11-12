package app.shareanywhere

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.shareanywhere.di.AppScope
import app.shareanywhere.history.HistoryRepository
import app.shareanywhere.identity.IdentityManager
import app.shareanywhere.notify.Notifier
import app.shareanywhere.settings.SettingsRepository
import app.shareanywhere.transfer.IncomingDao
import app.shareanywhere.transfer.OutgoingFileDao
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Creates (or restores) the anonymous device identity in the background whenever the app comes to the
 * foreground (PRD §5.1: never in front of the UI), and applies the History retention once per launch.
 */
@HiltAndroidApp
class ShareAnywhereApp : Application() {
    @Inject lateinit var identity: IdentityManager

    @Inject lateinit var history: HistoryRepository

    @Inject lateinit var settings: SettingsRepository

    @Inject lateinit var notifier: Notifier

    @Inject lateinit var incoming: IncomingDao

    @Inject lateinit var outgoing: OutgoingFileDao

    @Inject lateinit var config: app.shareanywhere.config.AppConfig

    @Inject lateinit var account: dagger.Lazy<app.shareanywhere.account.AccountManager>

    @Inject lateinit var clipboard: dagger.Lazy<app.shareanywhere.clipboard.ClipboardRuntime>

    @Inject lateinit var transfers: dagger.Lazy<app.shareanywhere.transfer.runtime.TransferRuntime>

    @Inject @AppScope
    lateinit var scope: CoroutineScope

    override fun onCreate() {
        super.onCreate()
        notifier.ensureChannels()
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) = identity.start()
            }
        )
        // Accounts and Clipboard Sync follow the identity's `acct` claim (nothing runs for a guest beyond reading it).
        if (config.flags.accounts) account.get().start()
        if (config.flags.clipboard) clipboard.get().start()
        scope.launch { runCatching { history.sweep(settings.settings.first().retention) } }
        scope.launch {
            // Receive progress and save folders untouched for a day, and picked files of sessions past their maximum
            // lifetime, are forgotten (as the Web's storage sweep; docs/TRANSFER_PROTOCOL.md §4). First, so a stale
            // receive is never resumed and then deleted under it.
            val now = System.currentTimeMillis()
            withContext(Dispatchers.IO) {
                runCatching {
                    incoming.removeOlderThan(now - DAY_MS)
                    incoming.removeTargetsOlderThan(now - DAY_MS)
                    outgoing.deleteOlderThan(now - 2 * DAY_MS)
                }
            }
            // Then a receive the process ended in the middle of resumes once the device identity is ready (PRD §6).
            identity.state.first { it.status == app.shareanywhere.identity.IdentityStatus.Ready }
            transfers.get().resumeUnfinished(since = now - DAY_MS)
        }
    }

    private companion object {
        const val DAY_MS = 24L * 60 * 60 * 1000
    }
}
