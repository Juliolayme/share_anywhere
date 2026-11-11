package app.shareanywhere

import android.Manifest
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.core.net.toUri
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import app.shareanywhere.data.api.FileInput
import app.shareanywhere.transfer.runtime.RxPhase
import app.shareanywhere.ui.nav.ScreenIds
import java.io.ByteArrayOutputStream
import java.util.regex.Pattern
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * RX-5b Choose folder through the system picker (Storage Access Framework, `ACTION_OPEN_DOCUMENT_TREE`) driven with
 * UiAutomator: a new folder is created in Download, chosen with Use this folder and Allow, and the received file lands
 * there through the tree URI with a matching SHA-256.
 */
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 30)
class SafFolderTest {
    @get:Rule val compose = createEmptyComposeRule()

    @get:Rule val notifications: GrantPermissionRule =
        if (android.os.Build.VERSION.SDK_INT >=
            33
        ) {
            GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            GrantPermissionRule.grant()
        }

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val picker = Pattern.compile("com\\.(google\\.)?android\\.documentsui")

    private fun text(regex: String) = By.text(Pattern.compile(regex, Pattern.CASE_INSENSITIVE))

    private fun find(selector: androidx.test.uiautomator.BySelector, what: String, timeout: Long = 15_000): UiObject2 =
        device.wait(Until.findObject(selector), timeout) ?: run {
            val out = ByteArrayOutputStream()
            device.dumpWindowHierarchy(out)
            android.util.Log.e("SA-TEST", "picker: $what not found\n$out")
            throw AssertionError("picker: $what not found")
        }

    @Test
    fun aFolderChosenInTheSystemPickerReceivesTheFile() {
        Backend.assume()
        Backend.markWelcomed()
        val entry = Backend.entry()
        val (file, sum) = TestPeer.file("saf-${System.nanoTime()}.bin", 3 * 1024 * 1024 + 7)
        TestPeer(Backend.Peer.create()).use { peer ->
            val view = runBlocking { peer.peer.api.create(listOf(FileInput(file.name, file.length(), "application/octet-stream")), false) }
            runBlocking { peer.sender(view.id, file, view.files!!.single().id, "application/octet-stream") }
            ActivityScenario.launch(MainActivity::class.java).use {
                compose.dumpOnFailure {
                    compose.waitForTag(ScreenIds.HOME)
                    compose.onNodeWithTag("home.receive").performClick()
                    compose.onNodeWithTag("receive.tab-code").performClick()
                    compose.waitForTag(ScreenIds.RECEIVE_CODE)
                    compose.onNodeWithTag("receive.code-input").performTextInput(view.code!!)
                    compose.onNodeWithTag("receive.continue").performClick()
                    compose.waitForTag(ScreenIds.RX_PREVIEW, 30_000)
                    compose.onNodeWithTag("preview.receive").tap()
                    compose.waitForTag("rx.choose-folder", 30_000)
                    compose.onNodeWithTag("rx.choose-folder").tap()

                    // DocumentsUI: open Download from the roots, make a new folder, open it, Use this folder, Allow.
                    assertTrue("system picker opened", device.wait(Until.hasObject(By.pkg(picker)), 20_000))
                    val name = "SA-${System.currentTimeMillis() % 100000}"
                    device.wait(Until.findObject(By.desc(Pattern.compile("Show roots", Pattern.CASE_INSENSITIVE))), 5_000)?.click()
                    device.wait(Until.findObject(text("^Downloads?$")), 5_000)?.click()
                    find(By.desc(Pattern.compile("More options", Pattern.CASE_INSENSITIVE)), "More options").click()
                    find(text("^New folder$"), "New folder").click()
                    find(By.clazz("android.widget.EditText"), "folder name field").text = name
                    find(text("^OK$"), "OK").click()
                    find(text("^${Pattern.quote(name)}$"), "new folder").click()
                    find(text("^Use this folder$"), "Use this folder").click()
                    find(text("^Allow$"), "Allow").click()

                    compose.waitForTag("rx.start", 30_000)
                    compose.onNodeWithTag("rx.start").tap()
                    compose.waitForTag(ScreenIds.RX_DONE, 120_000)
                    val state = entry.transferRuntime().existingReceiver(view.id)!!.state.value
                    assertEquals(RxPhase.Completed, state.phase)
                    val uri = state.files.single().documentUri!!
                    assertTrue(
                        "saved through the chosen tree: $uri",
                        uri.startsWith("content://com.android.externalstorage.documents/tree/")
                    )
                    assertEquals(sum, TestPeer.sha256(peer.context, uri.toUri()))
                    runBlocking { runCatching { peer.peer.api.close(view.id) } }
                }
            }
        }
    }
}
