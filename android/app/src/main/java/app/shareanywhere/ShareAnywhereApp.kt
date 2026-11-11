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
        scope.launch { runCatching { history.sweep(settings.settings.first().retention) } }
        // Receive progress and save folders untouched for a day, and picked files of sessions past their maximum
        // lifetime, are forgotten (as the Web's storage sweep; docs/TRANSFER_PROTOCOL.md §4).
        scope.launch(Dispatchers.IO) {
            runCatching {
                val now = System.currentTimeMillis()
                incoming.removeOlderThan(now - DAY_MS)
                incoming.removeTargetsOlderThan(now - DAY_MS)
                outgoing.deleteOlderThan(now - 2 * DAY_MS)
            }
        }
    }

    private companion object {
        const val DAY_MS = 24L * 60 * 60 * 1000
    }
}
