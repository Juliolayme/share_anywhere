package app.shareanywhere.clipboard

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.shareanywhere.MainActivity
import app.shareanywhere.R
import app.shareanywhere.account.AccountManager
import app.shareanywhere.account.keys.KeyStatus
import app.shareanywhere.data.api.ClipboardSettings
import app.shareanywhere.data.ws.SessionSocket
import app.shareanywhere.data.ws.SocketEvent
import app.shareanywhere.settings.SettingsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/** What the Clipboard tab shows of the runtime (CB-4). */
data class ClipboardUi(
    /** The engine runs: signed in, device added, key held (docs/CLIPBOARD_PROTOCOL.md §2.10). */
    val active: Boolean = false,
    /** This device's id (rows from it say "This device"). */
    val thisDeviceId: String? = null,
    val snapshot: ClipboardSnapshot = ClipboardSnapshot(),
    val deviceNames: Map<String, String> = emptyMap(),
    val autoCapture: Boolean = true,
    /** The last request reached the server. */
    val online: Boolean = true
)

/** What reading the clipboard gave. */
sealed interface ClipRead {
    data class Text(val text: String, val flagged: Boolean) : ClipRead

    data object Empty : ClipRead

    /** Android refused the read (the app did not have input focus). */
    data object Refused : ClipRead
}

/**
 * Runs Clipboard Sync on this device (docs/CLIPBOARD_PROTOCOL.md §2.10, PRD §7.3): an engine exists only while the account
 * is ready (signed in, device added, key held). Guests and devices that are not ready never touch `ClipboardManager` and
 * never register a listener. Capture follows Android's rules: a lifecycle-aware `OnPrimaryClipChangedListener` registered
 * only while the Activity is resumed, a read when the window gains focus, clips flagged `EXTRA_IS_SENSITIVE` skipped, and
 * Sync Clipboard for copies made elsewhere. In the background nothing is read; new items from other devices post a
 * notification whose action opens the Activity to sync.
 */
class ClipboardRuntime(
    private val context: Context,
    private val account: AccountManager,
    private val api: ClipboardEndpoints,
    private val store: ClipboardStore,
    private val socket: SessionSocket,
    private val settings: SettingsRepository,
    private val scope: CoroutineScope
) {
    private val _ui = MutableStateFlow(ClipboardUi())
    val ui: StateFlow<ClipboardUi> = _ui.asStateFlow()

    private val _listening = MutableStateFlow(false)

    /** A clipboard listener is registered right now (tests assert it is never true for a guest). */
    val listening: StateFlow<Boolean> = _listening.asStateFlow()

    /**
     * Per-process secret carried by the notification's Sync action. MainActivity is exported, so an explicit
     * ACTION_SYNC intent from another app must not make it read and upload the clipboard: without the token the
     * intent only opens the Clipboard tab.
     */
    private val syncToken: String = java.util.UUID.randomUUID().toString()

    fun isOwnSyncRequest(intent: android.content.Intent): Boolean =
        intent.action == ACTION_SYNC && intent.getStringExtra(EXTRA_SYNC_TOKEN) == syncToken

    private val lock = Mutex()
    private var engine: ClipboardEngine? = null
    private var engineJobs = listOf<Job>()
    private var namesAt = 0L
    private val notified = HashSet<String>()
    private var resumed = false

    @Volatile private var windowFocused = false
    private var listener: ClipboardManager.OnPrimaryClipChangedListener? = null
    private val manager by lazy { context.getSystemService(ClipboardManager::class.java) }

    fun start() {
        scope.launch {
            account.state
                .map { s ->
                    if (s.signedIn &&
                        s.added &&
                        s.keys == KeyStatus.Ready &&
                        s.accountId != null &&
                        s.deviceId != null
                    ) {
                        s.accountId to s.deviceId
                    } else {
                        null
                    }
                }
                .distinctUntilChanged()
                .collect { ready -> lock.withLock { switchTo(ready) } }
        }
        scope.launch {
            settings.settings.map { it.clipboardAuto }.distinctUntilChanged().collect { on ->
                _ui.value =
                    _ui.value.copy(autoCapture = on)
            }
        }
        scope.launch {
            combine(
                _ui.map {
                    it.active && it.autoCapture && it.snapshot.settings?.paused != true
                }.distinctUntilChanged(),
                resumedFlow
            ) { may, r ->
                may &&
                    r
            }
                .distinctUntilChanged()
                .collect { listen -> if (listen) register() else unregister() }
        }
    }

    private fun switchTo(ready: Pair<String, String>?) {
        val current = engine
        if (current != null && ready != null && current.userId == ready.first && current.deviceId == ready.second) return
        stopEngine()
        if (ready == null) return
        val e = ClipboardEngine(
            api,
            KeySource.of(account.keyStore(ready.first)),
            store,
            ready.first,
            ready.second,
            onKeyConflict = { account.checkKeys() }
        )
        engine = e
        notified.clear()
        _ui.value = _ui.value.copy(active = true, thisDeviceId = ready.second, snapshot = e.state.value)
        engineJobs =
            listOf(
                scope.launch { e.start() },
                scope.launch {
                    e.state.collect { snap ->
                        if (engine !== e) return@collect
                        val reachable = snap.sendError != SendError.OFFLINE && snap.loadError != LoadError.OFFLINE
                        _ui.value = _ui.value.copy(snapshot = snap, online = reachable)
                        notifyIncoming(snap)
                    }
                },
                scope.launch { socket.subscribe().collect { onSocket(e, it) } }
            )
        refreshNames(force = true)
    }

    private fun stopEngine() {
        engine?.stop()
        engine = null
        engineJobs.forEach { it.cancel() }
        engineJobs = emptyList()
        _ui.value = ClipboardUi(autoCapture = _ui.value.autoCapture)
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }

    /** The account left this device: the engine stops and every clipboard record on the device is erased. */
    suspend fun wipe() {
        lock.withLock { stopEngine() }
        runCatching { store.wipe() }
    }

    suspend fun keysChanged() {
        engine?.keysChanged()
    }

    private fun refreshNames(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - namesAt < 30_000) return
        namesAt = now
        scope.launch {
            runCatching { account.devices() }.onSuccess { list ->
                _ui.value =
                    _ui.value.copy(deviceNames = list.associate { it.id to it.name })
            }
        }
    }

    private suspend fun onSocket(e: ClipboardEngine, ev: SocketEvent) {
        when (ev.type) {
            "CLIPBOARD_EVENT_CREATED" -> {
                val origin = ev.body["origin_device_id"]?.jsonPrimitive?.contentOrNull
                if (origin != null && origin !in _ui.value.deviceNames) refreshNames()
                e.refresh()
            }
            "CLIPBOARD_EVENT_DELETED", "CLIPBOARD_HISTORY_CLEARED" -> e.refresh()
            "CLIPBOARD_SETTINGS_UPDATED" -> settingsFrom(ev)?.let { e.applySettings(it) } ?: e.loadSettings()
            "DEVICE_CONNECTED" -> {
                val id = ev.body["device_id"]?.jsonPrimitive?.contentOrNull
                if (id != null && id !in _ui.value.deviceNames) refreshNames()
            }
            SocketEvent.OPEN -> {
                scope.launch { e.refresh() }
                scope.launch { e.flush() }
            }
        }
    }

    // --- Actions of the Clipboard tab ---

    suspend fun refresh() = engine?.refresh()

    suspend fun capture(text: String, source: CaptureSource, force: Boolean = false, flagged: Boolean = false): CaptureResult =
        engine?.capture(text, source, force, flagged) ?: CaptureResult.NotReady

    /** Sync Clipboard: reads the clipboard now (the app is in front, so Android allows it) and sends it. */
    suspend fun syncNow(): Pair<ClipRead, CaptureResult?> {
        if (engine == null) return ClipRead.Empty to CaptureResult.NotReady
        val read = readClip()
        val result = if (read is ClipRead.Text) capture(read.text, CaptureSource.MANUAL, flagged = read.flagged) else null
        return read to result
    }

    /** Copy: puts the item's text on the clipboard (marked sensitive when it looked sensitive) and clears "New". */
    suspend fun copy(id: String): Boolean {
        val e = engine ?: return false
        val item = e.state.value.items.firstOrNull { it.id == id } ?: return false
        val text = item.text ?: return false
        e.noteClipboardText(text)
        val ok =
            try {
                val clip = ClipData.newPlainText(context.getString(R.string.android_clip), text)
                if (Sensitive.kind(text) != null) {
                    clip.description.extras = PersistableBundle().apply { putBoolean(EXTRA_IS_SENSITIVE, true) }
                }
                manager.setPrimaryClip(clip)
                true
            } catch (_: Exception) {
                false
            }
        if (ok) e.markCopied(id)
        return ok
    }

    suspend fun remove(id: String) = checkNotNull(engine).remove(id)

    suspend fun clear() = checkNotNull(engine).clear()

    suspend fun saveSettings(next: ClipboardSettings) = checkNotNull(engine).saveSettings(next)

    suspend fun retrySettings() = engine?.loadSettings()

    suspend fun flush() = engine?.flush()

    suspend fun dismissSkipped(id: String) = engine?.dismissSkipped(id)

    suspend fun setAutoCapture(on: Boolean) = settings.setClipboardAuto(on)

    // --- Foreground capture ---

    private val resumedFlow = MutableStateFlow(false)

    /** Follows [activity]'s lifecycle: capture can run only while it is resumed. */
    fun attach(owner: LifecycleOwner) {
        owner.lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onResume(owner: LifecycleOwner) {
                    resumed = true
                    resumedFlow.value = true
                }

                override fun onPause(owner: LifecycleOwner) {
                    resumed = false
                    resumedFlow.value = false
                    unregister()
                }
            }
        )
    }

    /** The window gained input focus: Android now allows a read, so what was copied elsewhere is captured once. */
    fun onWindowFocus(hasFocus: Boolean) {
        windowFocused = hasFocus
        Log.d(TAG, "window focus=$hasFocus listening=${_listening.value}")
        if (hasFocus && _listening.value) captureCurrent()
    }

    private fun register() {
        if (listener != null || !resumed) return
        val l = ClipboardManager.OnPrimaryClipChangedListener { captureCurrent() }
        manager.addPrimaryClipChangedListener(l)
        listener = l
        _listening.value = true
    }

    private fun unregister() {
        listener?.let { manager.removePrimaryClipChangedListener(it) }
        listener = null
        _listening.value = false
    }

    private fun captureCurrent() {
        if (!_listening.value) return
        scope.launch {
            val read = readClip()
            val result = if (read is ClipRead.Text) capture(read.text, CaptureSource.AUTO, flagged = read.flagged) else null
            // Kinds only, never the text: enough to tell a refused read from a skip or a sync in a device log.
            Log.d(TAG, "auto capture: read=${read::class.simpleName} result=${result?.let { it::class.simpleName }} focus=$windowFocused")
        }
    }

    private fun readClip(): ClipRead = try {
        val clip = manager.primaryClip
        val desc = clip?.description
        if (clip == null || clip.itemCount == 0 || desc == null || !(desc.hasMimeType("text/*"))) {
            // Android 10+ answers a read without input focus with no clip at all: a refusal (paste fallback).
            if (clip == null && Build.VERSION.SDK_INT >= 29 && !windowFocused) ClipRead.Refused else ClipRead.Empty
        } else {
            val text = clip.getItemAt(0).coerceToText(context)?.toString().orEmpty()
            val flagged = desc.extras?.getBoolean(EXTRA_IS_SENSITIVE, false) == true
            if (text.isEmpty()) ClipRead.Empty else ClipRead.Text(text, flagged)
        }
    } catch (_: SecurityException) {
        ClipRead.Refused
    }

    // --- Background notification (PRD §7.3: the action opens an Activity for user-driven sync) ---

    private fun inForeground() = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    private fun notifyIncoming(snap: ClipboardSnapshot) {
        val fresh = snap.items.filter { it.incoming && it.id !in notified }
        if (fresh.isEmpty()) return
        notified += fresh.map { it.id }
        if (inForeground()) return
        val nm = NotificationManagerCompat.from(context)
        if (!nm.areNotificationsEnabled()) return
        ensureChannel()
        val from = _ui.value.deviceNames[fresh.first().origin] ?: context.getString(R.string.product_cb_other_device)
        val open = PendingIntent.getActivity(
            context,
            1,
            Intent(context, MainActivity::class.java).setAction(ACTION_OPEN).addFlags(
                Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            ),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val sync = PendingIntent.getActivity(
            context,
            2,
            Intent(context, MainActivity::class.java).setAction(ACTION_SYNC).putExtra(EXTRA_SYNC_TOKEN, syncToken).addFlags(
                Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            ),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        // The item's text never goes into the notification (it could show on the lock screen).
        val n =
            NotificationCompat
                .Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher_monochrome)
                .setContentTitle(context.getString(R.string.android_patterns_new_clipboard_item_from_x).replace("{1}", from))
                .setContentText(context.getString(R.string.handoff_cb_notif))
                .setContentIntent(open)
                .addAction(0, context.getString(R.string.android_sync), sync)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .build()
        try {
            nm.notify(NOTIFICATION_ID, n)
        } catch (_: SecurityException) {
        }
    }

    private fun ensureChannel() {
        val channel =
            NotificationChannel(CHANNEL, context.getString(R.string.product_cb_notif_channel), NotificationManager.IMPORTANCE_DEFAULT)
        channel.description = context.getString(R.string.product_cb_notif_channel_p)
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "SA-CLIPBOARD"
        const val CHANNEL = "clipboard"
        const val NOTIFICATION_ID = 0x5A11
        const val ACTION_OPEN = "app.shareanywhere.OPEN_CLIPBOARD"
        const val ACTION_SYNC = "app.shareanywhere.SYNC_CLIPBOARD"
        private const val EXTRA_SYNC_TOKEN = "app.shareanywhere.extra.SYNC_TOKEN"

        /** `ClipDescription.EXTRA_IS_SENSITIVE` (API 33); the same key is honored on older releases. */
        val EXTRA_IS_SENSITIVE: String =
            if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE"

        /** Settings from a `CLIPBOARD_SETTINGS_UPDATED` message, or null when it is not the expected shape. */
        fun settingsFrom(e: SocketEvent): ClipboardSettings? {
            val paused = e.body["paused"]?.jsonPrimitive?.booleanOrNull ?: return null
            val skip = e.body["sensitive_skip"]?.jsonPrimitive?.booleanOrNull ?: return null
            val days = e.body["retention_days"]?.jsonPrimitive?.intOrNull ?: return null
            if (days !in 1..7) return null
            return ClipboardSettings(paused, days, skip)
        }
    }
}
