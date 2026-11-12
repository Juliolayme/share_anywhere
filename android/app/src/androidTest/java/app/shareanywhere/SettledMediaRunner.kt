package app.shareanywhere

import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import androidx.test.runner.AndroidJUnitRunner

/**
 * The instrumentation runner. The orchestrator clears the app's data before every test (`clearPackageData`), and
 * MediaProvider handles that PACKAGE_DATA_CLEARED broadcast asynchronously, sometimes seconds later: it then orphans
 * whatever Downloads item the app created meanwhile, and the next read or write of the file being received fails with
 * SecurityException ("has no access"). Before each test starts, wait for the broadcast queues to drain and for
 * MediaProvider's MediaService to finish its queued work, each with a cap so an emulator image without these signals
 * only costs the cap once.
 */
class SettledMediaRunner : AndroidJUnitRunner() {
    override fun onStart() {
        runCatching { awaitMediaSettled() }.onFailure { Log.w(TAG, "media settle check skipped: ${it.javaClass.simpleName}") }
        super.onStart()
    }

    private fun awaitMediaSettled() {
        val began = SystemClock.elapsedRealtime()
        // Broadcasts (PACKAGE_DATA_CLEARED included) delivered to their receivers; `am` blocks until then.
        val idle = Thread { runCatching { shell("am wait-for-broadcast-idle") } }
        idle.start()
        idle.join(BROADCAST_CAP_MS)
        // MediaProvider runs the clear in MediaService (work queued through JobScheduler, so it can wait before it
        // runs): settled once no MediaService job is registered and the service is not running.
        val deadline = SystemClock.elapsedRealtime() + SERVICE_CAP_MS
        while (SystemClock.elapsedRealtime() < deadline && (mediaJobQueued() || mediaServiceRunning())) SystemClock.sleep(POLL_MS)
        Log.i(TAG, "media settled after ${SystemClock.elapsedRealtime() - began} ms")
    }

    private fun mediaServiceRunning(): Boolean =
        shell("dumpsys activity services").lineSequence().any { "ServiceRecord" in it && isMediaService(it) }

    /** Registered jobs only ("JOB #…" lines), not the job history further down the dump. */
    private fun mediaJobQueued(): Boolean =
        shell("dumpsys jobscheduler").lineSequence().any { it.trimStart().startsWith("JOB #") && isMediaService(it) }

    private fun isMediaService(line: String) = "providers.media" in line && "MediaService" in line

    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(uiAutomation.executeShellCommand(command)).bufferedReader().use { it.readText() }

    private companion object {
        const val TAG = "SA-TEST"
        const val BROADCAST_CAP_MS = 30_000L
        const val SERVICE_CAP_MS = 20_000L
        const val POLL_MS = 250L
    }
}
