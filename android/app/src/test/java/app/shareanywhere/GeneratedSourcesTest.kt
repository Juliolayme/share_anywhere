package app.shareanywhere

import android.content.Context
import android.content.res.Configuration
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.shareanywhere.data.api.ApiOperation
import app.shareanywhere.data.api.ApiOperations
import app.shareanywhere.data.api.DeviceSession
import app.shareanywhere.data.api.PowRequired
import app.shareanywhere.ui.theme.SaTokens
import java.io.File
import java.util.Locale
import javax.xml.parsers.DocumentBuilderFactory
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.w3c.dom.Element

/**
 * The generated Android sources agree with their shared inputs (tokens.json, the EN/VI catalogs, openapi.yaml).
 * `pnpm tokens:check`, `i18n:check` and `protocol:check` catch drift in CI; this test proves the generated
 * files say the same thing at runtime on Android.
 */
@RunWith(AndroidJUnit4::class)
class GeneratedSourcesTest {
    private val root = File(requireNotNull(System.getProperty("sa.repoRoot")) { "sa.repoRoot is set by app/build.gradle.kts" })
    private val json = Json { ignoreUnknownKeys = true }
    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun readJson(path: String) = json.parseToJsonElement(root.resolve(path).readText()).jsonObject

    private fun hex(v: String): Int {
        val rgba = Regex("""rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)""").matchEntire(v)
        if (rgba != null) {
            val (r, g, b, a) = rgba.destructured
            return Color(r.toInt(), g.toInt(), b.toInt(), Math.round(a.toDouble() * 255).toInt()).toArgb()
        }
        return (0xFF000000 or v.removePrefix("#").toLong(16)).toInt()
    }

    @Test
    fun tokenColoursMatchTokensJsonInBothThemes() {
        val tokens = readJson("shared/design/tokens.json")
        for ((theme, palette) in listOf("light" to SaTokens.Light, "dark" to SaTokens.Dark)) {
            val expected = tokens["color"]!!.jsonObject[theme]!!.jsonObject
            assertEquals(expected.keys, palette.byToken.keys)
            for ((name, value) in expected) {
                assertEquals("$theme.$name", hex(value.jsonPrimitive.content), palette.byToken.getValue(name).toArgb())
            }
        }
        assertEquals(hex(tokens["brand"]!!.jsonObject["blue"]!!.jsonPrimitive.content), SaTokens.Brand.Blue.toArgb())
        assertEquals("48dp", tokens["touchTarget"]!!.jsonObject["android"]!!.jsonPrimitive.content)
        assertEquals(48f, SaTokens.TouchTarget.value)
    }

    @Test
    fun windowBackgroundMatchesTheCanvasToken() {
        val tokens = readJson("shared/design/tokens.json")["color"]!!.jsonObject
        assertEquals(hex(tokens["light"]!!.jsonObject["bg"]!!.jsonPrimitive.content), context.getColor(R.color.sa_window_bg))
        val night = Configuration(context.resources.configuration).apply { uiMode = Configuration.UI_MODE_NIGHT_YES }
        assertEquals(
            hex(tokens["dark"]!!.jsonObject["bg"]!!.jsonPrimitive.content),
            context.createConfigurationContext(night).getColor(R.color.sa_window_bg)
        )
    }

    private fun flatten(prefix: String, e: JsonElement, out: MutableMap<String, String>) {
        when (e) {
            is JsonObject -> e.forEach { (k, v) -> flatten("${prefix}_$k", v, out) }
            is JsonPrimitive -> out[prefix.replace(Regex("[^A-Za-z0-9_]"), "_")] = e.content
            else -> error("unexpected $e")
        }
    }

    /** The Android slice of a catalog, keyed by resource name (scripts/gen-i18n.mjs androidResourceName). */
    private fun catalog(locale: String): Map<String, String> {
        val out = sortedMapOf<String, String>()
        for ((ns, table) in readJson("shared/i18n/$locale.json")) {
            val android = ns == "android" || ns.startsWith("android_") || ns in setOf("common", "phrases", "product", "handoff")
            if (android && table is JsonObject) flatten(ns, table, out)
        }
        return out
    }

    /** Reads a strings.xml and undoes the aapt2 escapes the generator applies. */
    private fun stringsXml(dir: String): Map<String, String> {
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(root.resolve("android/app/src/main/res/$dir/strings.xml"))
        val nodes = doc.getElementsByTagName("string")
        return (0 until nodes.length).associate { i ->
            val el = nodes.item(i) as Element
            el.getAttribute("name") to unescape(el.textContent)
        }
    }

    private fun unescape(s: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '\\' && i + 1 < s.length) {
                when (val n = s[i + 1]) {
                    'n' -> sb.append('\n')
                    't' -> sb.append('\t')
                    'u' -> {
                        sb.append(s.substring(i + 2, i + 6).toInt(16).toChar())
                        i += 4
                    }
                    else -> sb.append(n)
                }
                i += 2
            } else {
                sb.append(c)
                i++
            }
        }
        return sb.toString()
    }

    @Test
    fun androidStringResourcesMatchTheSharedCatalogs() {
        val en = catalog("en")
        val vi = catalog("vi")
        assertTrue("catalog slice should be large", en.size > 1000)
        assertEquals(en, stringsXml("values"))
        assertEquals(vi, stringsXml("values-vi"))
        assertEquals(en.keys, vi.keys)
    }

    @Test
    fun resourcesResolveInEnglishAndVietnamese() {
        assertEquals("Send files", context.getString(R.string.android_send))
        assertEquals("Start sharing", context.getString(R.string.android_vv_k34))
        assertEquals("Keep screen on during transfers", context.getString(R.string.android_yy_s_wake))
        assertEquals(" characters", context.getString(R.string.android_yy_chars))
        assertEquals("Pause on low battery (15%)", context.getString(R.string.android_yy_s_batt))
        val viConfig = Configuration(context.resources.configuration).apply { setLocale(Locale.forLanguageTag("vi")) }
        val viContext = context.createConfigurationContext(viConfig)
        assertEquals("Gửi tệp", viContext.getString(R.string.android_send))
        assertEquals("Bắt đầu chia sẻ", viContext.getString(R.string.android_vv_k34))
    }

    /** method, path and x-sa-access of every operation in openapi.yaml, read line by line. */
    private fun openapiOperations(): List<ApiOperation> {
        val ops = mutableListOf<ApiOperation>()
        var path: String? = null
        var method: String? = null
        for (line in root.resolve("shared/protocol/openapi.yaml").readLines()) {
            Regex("^  (/\\S*):\\s*$").matchEntire(line)?.let { path = it.groupValues[1] }
            Regex("^    (get|put|post|patch|delete):\\s*$").matchEntire(line)?.let { method = it.groupValues[1].uppercase() }
            Regex("^      x-sa-access: (\\S+)\\s*$").matchEntire(line)?.let {
                ops += ApiOperation(checkNotNull(method), checkNotNull(path), it.groupValues[1])
            }
            if (line == "components:") break
        }
        return ops
    }

    @Test
    fun generatedOperationsMatchOpenapi() {
        assertEquals(openapiOperations(), ApiOperations.all)
        assertEquals(ApiOperation("POST", "/v1/devices/anonymous", "public"), ApiOperations.createAnonymousDevice)
        assertEquals(ApiOperation("POST", "/v1/devices/token", "public"), ApiOperations.refreshDeviceToken)
        assertEquals("device", ApiOperations.resetCurrentDevice.access)
    }

    @Test
    fun generatedModelsDecodeServerPayloads() {
        val session =
            json.decodeFromString(
                DeviceSession.serializer(),
                """{"device":{"id":"d","kind":"anonymous","display_name":"n","platform":"Android · Pixel","created_at":"2026-11-01T00:00:00Z",
                   "last_seen_at":"2026-11-01T00:00:00Z","future_field":1},"access_token":"t","expires_in":900,"refresh_secret":"s",
                   "server_time":"2026-11-01T00:00:00Z"}"""
            )
        assertEquals("s", session.refreshSecret)
        assertEquals(900, session.expiresIn)
        val pow = json.decodeFromString(
            PowRequired.serializer(),
            """{"error":"pow_required","message":"m","challenge":{"token":"t","difficulty":16,"expires_in":300}}"""
        )
        assertEquals(16, pow.challenge.difficulty)
    }
}
