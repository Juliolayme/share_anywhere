package app.shareanywhere

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.shareanywhere.di.AppScope
import app.shareanywhere.history.HistoryRepository
import app.shareanywhere.identity.IdentityManager
import app.shareanywhere.settings.SettingsRepository
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject
import kotlinx.coroutines.CoroutineScope
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

    @Inject @AppScope
    lateinit var scope: CoroutineScope

    override fun onCreate() {
        super.onCreate()
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) = identity.start()
            }
        )
        scope.launch { runCatching { history.sweep(settings.settings.first().retention) } }
    }
}
