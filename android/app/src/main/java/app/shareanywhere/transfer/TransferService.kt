package app.shareanywhere.transfer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.shareanywhere.MainActivity
import app.shareanywhere.R
import app.shareanywhere.di.AppScope
import app.shareanywhere.notify.Notifier
import app.shareanywhere.transfer.runtime.TransferActivity
import app.shareanywhere.transfer.runtime.TransferRuntime
import app.shareanywhere.ui.i18n.str
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Foreground service (type dataSync) that keeps transfers running while the screen is off or the app is in the
 * background (docs/ARCHITECTURE.md §7.2, docs/ADR/0006-android-sdk-and-fgs-limits.md). It shows progress in an
 * ongoing notification, holds a PARTIAL_WAKE_LOCK and a Wi-Fi lock only while bytes move, and stops when no transfer
 * work is left. On API 35 the system's dataSync time budget ends it through [onTimeout]: transfers pause (their
 * bitmaps are already persisted), the service stops, and a notification asks the user to reopen the app.
 */
@AndroidEntryPoint
class TransferService : Service() {
    @Inject lateinit var runtime: TransferRuntime

    @Inject @AppScope
    lateinit var scope: CoroutineScope

    private var job: Job? = null
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private var lastUpdate = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        running = true
        val a = runtime.activity.value
        try {
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
            ServiceCompat.startForeground(this, NOTIFICATION_ID, build(a), type)
        } catch (e: Exception) {
            // Not allowed now (started from the background on Android 12+, or the Android 15 dataSync budget is spent):
            // transfers continue while the app is open.
            android.util.Log.w("SA-TRANSFER", "foreground service not started: ${e::class.java.simpleName}")
            running = false
            stopSelf()
            return START_NOT_STICKY
        }
        if (job == null) {
            job =
                scope.launch {
                    runtime.activity.collectLatest { act ->
                        if (!act.pending && !act.moving) {
                            stop()
                            return@collectLatest
                        }
                        locks(act.moving)
                        val now = System.currentTimeMillis()
                        if (now - lastUpdate >= 1000) {
                            lastUpdate = now
                            if (canNotify()) {
                                try {
                                    NotificationManagerCompat.from(this@TransferService).notify(NOTIFICATION_ID, build(act))
                                } catch (_: SecurityException) {
                                    // Notifications turned off meanwhile: the transfer goes on.
                                }
                            }
                        }
                    }
                }
        }
        return START_NOT_STICKY
    }

    /** API 35 dataSync budget reached (6 h in 24 h): checkpoint (pause), stop, tell the user. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        runtime.pauseAll()
        if (canNotify()) {
            try {
                NotificationManagerCompat.from(this).notify(
                    BUDGET_ID,
                    NotificationCompat
                        .Builder(this, CHANNEL)
                        .setSmallIcon(R.drawable.ic_launcher_monochrome)
                        .setContentTitle(str(R.string.product_fgs_budget_h))
                        .setContentText(str(R.string.product_fgs_budget_p))
                        .setContentIntent(openApp(null))
                        .setAutoCancel(true)
                        .build()
                )
            } catch (_: SecurityException) {
                // Notifications turned off meanwhile.
            }
        }
        stop()
    }

    /** Notifications may be refused (Android 13+ permission); the transfer works either way. */
    private fun canNotify(): Boolean = NotificationManagerCompat.from(this).areNotificationsEnabled() &&
        (
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
            )

    private fun stop() {
        running = false
        job?.cancel()
        job = null
        locks(false)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        job?.cancel()
        locks(false)
        super.onDestroy()
    }

    private fun locks(on: Boolean) {
        if (on) {
            if (wake?.isHeld != true) {
                wake =
                    getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ShareAnywhere:transfer").apply {
                        acquire(LOCK_TIMEOUT_MS)
                    }
            }
            if (wifi?.isHeld != true) {
                @Suppress("DEPRECATION")
                val mode = if (Build.VERSION.SDK_INT >=
                    Build.VERSION_CODES.Q
                ) {
                    WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                } else {
                    WifiManager.WIFI_MODE_FULL_HIGH_PERF
                }
                wifi = applicationContext.getSystemService(WifiManager::class.java)?.createWifiLock(mode, "ShareAnywhere:transfer")?.apply {
                    setReferenceCounted(false)
                    acquire()
                }
            }
        } else {
            wake?.takeIf { it.isHeld }?.release()
            wifi?.takeIf { it.isHeld }?.release()
            wake = null
            wifi = null
        }
    }

    private fun openApp(sessionId: String?): PendingIntent {
        val i =
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP).apply {
                if (sessionId != null) {
                    action = Notifier.ACTION_OPEN_SESSION
                    putExtra(Notifier.EXTRA_SESSION_ID, sessionId)
                }
            }
        return PendingIntent.getActivity(this, 1, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun build(a: TransferActivity): Notification {
        val pct = { done: Long, total: Long -> if (total > 0) (done * 100 / total).toInt() else 0 }
        val (title, done, total) =
            if (a.receivingFiles > 0) {
                Triple(
                    str(R.string.product_fgs_receiving, "n" to a.receivingFiles, "pct" to "${pct(a.receiveVerified, a.receiveTotal)}%"),
                    a.receiveVerified,
                    a.receiveTotal
                )
            } else {
                Triple(
                    str(R.string.product_fgs_sending, "n" to a.sendingTo, "pct" to "${pct(a.sendVerified, a.sendTotal)}%"),
                    a.sendVerified,
                    a.sendTotal
                )
            }
        return NotificationCompat
            .Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(if (a.moving) title else getString(R.string.android_keep))
            .setContentText(if (a.moving) getString(R.string.android_keep) else null)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setProgress(100, pct(done, total), !a.moving || total == 0L)
            .setContentIntent(openApp(a.sessionId))
            .build()
    }

    companion object {
        /** Whether the service is in the foreground now (the runtime starts it when transfer work appears). */
        @Volatile var running = false
            private set

        const val CHANNEL = "transfers"
        private const val NOTIFICATION_ID = 0x5A01
        private const val BUDGET_ID = 0x5A02

        /** A safety bound; the lock is released as soon as bytes stop moving. */
        private const val LOCK_TIMEOUT_MS = 6L * 60 * 60 * 1000

        fun ensureChannel(context: Context) {
            val ch =
                NotificationChannel(CHANNEL, context.getString(R.string.product_fgs_channel), NotificationManager.IMPORTANCE_LOW).apply {
                    description = context.getString(R.string.product_fgs_channel_p)
                }
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }

        /** Starts the service when there is transfer work; call while the app is in the foreground. */
        fun start(context: Context) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, TransferService::class.java)) }
        }
    }
}
