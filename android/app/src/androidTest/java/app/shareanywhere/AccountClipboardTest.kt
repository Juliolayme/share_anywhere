package app.shareanywhere

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import app.shareanywhere.account.keys.KeyStatus
import app.shareanywhere.ui.nav.ScreenIds
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Accounts and Clipboard Sync against the CI backend at 10.0.2.2 (docs/phases/PHASE_6_ANDROID.md "Tests to add"): as a
 * guest the Clipboard tab shows the intro and registers no clipboard listener; then create an account, add this device,
 * set up the encryption key, reach the Clipboard history, capture a copy made while the app is open (foreground capture
 * through the listener), capture nothing in the background, open the app from the notification for an item another
 * device of the account synced, and sign out, which leaves a new anonymous device ID.
 */
@RunWith(AndroidJUnit4::class)
class AccountClipboardTest {
    @get:Rule val compose = createEmptyComposeRule()

    @get:Rule val notifications: GrantPermissionRule =
        if (android.os.Build.VERSION.SDK_INT >=
            33
        ) {
            GrantPermissionRule.grant(android.Manifest.permission.POST_NOTIFICATIONS)
        } else {
            GrantPermissionRule.grant()
        }

    @Test
    fun guestIntroThenSignUpAddDeviceKeyClipboardAndSignOut() {
        Backend.assume()
        Backend.markWelcomed()
        val entry = Backend.entry()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            compose.dumpOnFailure {
                compose.waitForTag(ScreenIds.HOME, 30_000)
                compose.waitUntil(30_000) { entry.identity().state.value.device != null }
                val guestDevice = checkNotNull(entry.identity().state.value.device).id

                // CB-1 as a guest: intro, no listener.
                compose.onNodeWithTag("nav.${ScreenIds.CLIPBOARD}").tap()
                compose.waitForTag("clipboard.intro")
                assertFalse(entry.clipboardRuntime().listening.value)

                // AC-2 Create account (from the Clipboard intro), AC-4 Add this device.
                compose.onNodeWithTag("clipboard.create").tap()
                compose.waitForTag(ScreenIds.SIGNUP)
                val email = "android-${UUID.randomUUID().toString().take(8)}@example.com"
                compose.onNodeWithTag("signup.email").performTextInput(email)
                val password = "Sa-android-${UUID.randomUUID().toString().take(6)}-pw!"
                compose.onNodeWithTag("signup.password").performTextInput(password)
                compose.onNodeWithTag("signup.submit").tap()
                compose.waitForTag(ScreenIds.TRUST, 30_000)
                assertTrue(entry.accountManager().state.value.signedIn)
                assertEquals("signing in keeps the same device", guestDevice, entry.identity().state.value.device?.id)
                compose.onNodeWithTag("trust.continue").tap()

                // AC-5: the first device of the account creates the key; the phrase shows once.
                compose.waitForTag(ScreenIds.KEY_SETUP, 30_000)
                compose.waitForTag("key-setup.words", 120_000)
                compose.onNodeWithTag("key-setup.saved").tap()
                compose.onNodeWithTag("key-setup.continue").tap()

                // AC-8, then Go to Clipboard.
                compose.waitForTag(ScreenIds.CHECKLIST, 60_000)
                compose.waitUntil(30_000) { entry.accountManager().state.value.keys == KeyStatus.Ready }
                compose.onNodeWithTag("checklist.clipboard").tap()
                compose.waitForTag("clipboard.home", 30_000)
                compose.waitUntil(30_000) { entry.clipboardRuntime().ui.value.snapshot.synced }
                assertTrue("a new account's clipboard is empty", entry.clipboardRuntime().ui.value.snapshot.items.isEmpty())

                // Foreground capture: a copy made while the app is in front is encrypted and synced.
                compose.waitUntil(10_000) { entry.clipboardRuntime().listening.value }
                val marker = "android clipboard marker ${System.currentTimeMillis()}"
                scenario.onActivity {
                    it.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("test", marker))
                }
                compose.waitUntil(30_000) { entry.clipboardRuntime().ui.value.snapshot.items.any { i -> i.text == marker && !i.pending } }
                // The row may sit below the fold of a small screen: scroll the list to it.
                compose.onNodeWithTag("clipboard.home").performScrollToNode(hasTestTag("clip-row"))
                val synced = entry.clipboardRuntime().ui.value.snapshot.items.first { it.text == marker }
                assertNotNull(synced.seq)

                // In the background nothing is read: the listener is gone and a copy made meanwhile is not captured.
                val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
                device.pressHome()
                compose.waitUntil(10_000) { !entry.clipboardRuntime().listening.value }
                val background = "copied in another app ${System.currentTimeMillis()}"
                ApplicationProvider.getApplicationContext<android.content.Context>()
                    .getSystemService(ClipboardManager::class.java)
                    .setPrimaryClip(ClipData.newPlainText("test", background))
                Thread.sleep(2_000)
                assertFalse(entry.clipboardRuntime().ui.value.snapshot.items.any { it.text == background })

                // Another device of the account syncs an item: a notification appears; its tap opens the Activity on Clipboard.
                runBlocking { Backend.AccountPeer.signIn(email, password).postClipboardItem(64) }
                device.openNotification()
                val notification = device.wait(Until.findObject(By.textContains(Backend.entryString(R.string.handoff_cb_notif))), 30_000)
                assertNotNull("clipboard notification posted while in the background", notification)
                notification.click()
                device.wait(Until.hasObject(By.res(ScreenIds.CLIPBOARD)), 15_000)
                compose.waitForTag(ScreenIds.CLIPBOARD, 15_000)
                compose.waitUntil(10_000) { entry.clipboardRuntime().listening.value }

                // AC-7 Sign out from Settings: a new anonymous device; the clipboard listener goes away.
                compose.onNodeWithTag("nav.${ScreenIds.SETTINGS}").tap()
                compose.waitForTag("settings.signout", 30_000)
                compose.onNodeWithTag("settings.signout").tap()
                compose.waitForTag("signout.confirm")
                compose.onNodeWithTag("signout.confirm").tap()
                compose.waitForTag("settings.guest", 30_000)
                val newDevice = entry.identity().state.value.device?.id
                assertNotNull(newDevice)
                assertNotEquals("sign-out yields a new device ID", guestDevice, newDevice)
                assertFalse(entry.accountManager().state.value.signedIn)
                compose.waitUntil(10_000) { !entry.clipboardRuntime().ui.value.active }
                assertFalse(entry.clipboardRuntime().listening.value)
            }
        }
        // Nothing of the account is left on the device.
        assertTrue(
            ApplicationProvider.getApplicationContext<android.content.Context>().noBackupFilesDir.listFiles().orEmpty().none {
                it.name ==
                    "account_keys.json"
            }
        )
    }
}
