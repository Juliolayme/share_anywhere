package app.shareanywhere

import android.Manifest
import android.content.ContentValues
import android.provider.MediaStore
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import app.shareanywhere.ui.nav.ScreenIds
import java.io.ByteArrayOutputStream
import java.util.regex.Pattern
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * TR-2/TR-3 through the real Send screen (docs/phases/PHASE_6_ANDROID.md): Home → Send → Choose files opens the system
 * picker (SAF `OpenMultipleDocuments`), a document is picked with UiAutomator, Require approval is off by default, and
 * Create share session opens the session with a six-digit code. The app reads the document through its content URI.
 */
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 29) // the test document is created through MediaStore Downloads
class SendFlowTest {
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

    private fun dump(what: String): Nothing {
        val out = ByteArrayOutputStream()
        device.dumpWindowHierarchy(out)
        android.util.Log.e("SA-TEST", "picker: $what\n$out")
        throw AssertionError("picker: $what")
    }

    @Test
    fun guestPicksAFileWithTheSystemPickerAndCreatesASession() {
        Backend.assume()
        Backend.markWelcomed()
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val name = "sa-send-${System.currentTimeMillis() % 1_000_000}.txt"
        val values =
            ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, "text/plain")
                put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/")
            }
        val doc = checkNotNull(context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values))
        context.contentResolver.openOutputStream(doc)!!.use { it.write("hello from the send flow test\n".toByteArray()) }
        try {
            ActivityScenario.launch(MainActivity::class.java).use {
                compose.dumpOnFailure {
                    compose.waitForTag(ScreenIds.HOME, 30_000)
                    compose.onNodeWithTag("home.send").performClick()
                    compose.waitForTag(ScreenIds.SEND)
                    compose.onNodeWithTag("send.choose").tap()

                    // DocumentsUI: the file may be listed (Recent or Downloads); otherwise search for it by name.
                    val file = By.text(Pattern.compile("^${Pattern.quote(name)}$"))
                    var row = device.wait(Until.findObject(file), 8_000)
                    if (row == null) {
                        val search =
                            device.wait(Until.findObject(By.desc(Pattern.compile("Search", Pattern.CASE_INSENSITIVE))), 10_000)
                                ?: dump("Search not found")
                        search.click()
                        // DocumentsUI's search box is a SearchView (an AutoCompleteTextView): take the focused field.
                        val field =
                            device.wait(Until.findObject(By.focused(true)), 10_000) ?: dump("search field not found")
                        field.text = name
                        device.pressEnter()
                        row = device.wait(Until.findObject(file), 15_000) ?: dump("$name not found")
                    }
                    row.click()

                    // Back in the app: the file is listed; Require approval is off by default.
                    compose.waitForTag("send.total", 20_000)
                    val approval = compose.onNodeWithTag(
                        "send.approval"
                    ).fetchSemanticsNode().config.getOrNull(SemanticsProperties.ToggleableState)
                    assertFalse("Require approval is off by default", approval == ToggleableState.On)
                    compose.onNodeWithTag("send.create").tap()
                    compose.waitForTag(ScreenIds.SESSION, 30_000)
                    val code =
                        compose.onNodeWithTag("session-code").fetchSemanticsNode().config[SemanticsProperties.Text]
                            .joinToString("") { it.text }.replace(" ", "")
                    assertEquals("a six-digit code", 6, code.count { it.isDigit() })
                    val uris = runBlocking { Backend.entry().outgoingFiles().uris() }
                    assertNotNull("the picked document is stored by its content URI", uris.firstOrNull { it.startsWith("content://") })
                }
            }
        } finally {
            context.contentResolver.delete(doc, null, null)
        }
    }
}
