package app.shareanywhere.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import app.shareanywhere.MainActivity
import app.shareanywhere.R
import app.shareanywhere.ui.i18n.str

/**
 * Local notifications for session activity (PRD §5.3: a receiver joins while the app is in the background).
 * Only posted when the app is not in the foreground (the snackbar covers that case) and the user allowed
 * notifications (asked just in time on the session screen, ON-3). The text names the receiver's display name only.
 */
class Notifier(private val context: Context) {
    private val manager = NotificationManagerCompat.from(context)

    fun ensureChannels() {
        val channel =
            NotificationChannel(
                SESSIONS,
                context.getString(R.string.product_notif_channel_sessions),
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = context.getString(R.string.product_notif_channel_sessions_p)
            }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    val allowed: Boolean
        get() =
            manager.areNotificationsEnabled() &&
                (
                    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                        PackageManager.PERMISSION_GRANTED
                    )

    private val inForeground: Boolean
        get() = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    /** "{name} joined" / "{name} wants to join", opening the session when tapped. Returns whether it was posted. */
    fun sessionActivity(sessionId: String, participantId: String, title: String): Boolean {
        if (inForeground || !allowed) return false
        ensureChannels()
        val open =
            Intent(context, MainActivity::class.java)
                .setAction(ACTION_OPEN_SESSION)
                .putExtra(EXTRA_SESSION_ID, sessionId)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pi = PendingIntent.getActivity(
            context,
            sessionId.hashCode(),
            open,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val n =
            NotificationCompat
                .Builder(context, SESSIONS)
                .setSmallIcon(R.drawable.ic_launcher_monochrome)
                .setContentTitle(title)
                .setContentText(context.str(R.string.product_notif_open_session))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .build()
        return try {
            manager.notify(participantId.hashCode(), n)
            true
        } catch (_: SecurityException) {
            false
        }
    }

    companion object {
        const val SESSIONS = "sessions"
        const val ACTION_OPEN_SESSION = "app.shareanywhere.OPEN_SESSION"
        const val EXTRA_SESSION_ID = "session_id"
    }
}
