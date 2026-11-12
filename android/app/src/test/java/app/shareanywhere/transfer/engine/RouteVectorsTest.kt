package app.shareanywhere.transfer.engine

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Test

/** The Android route engine reproduces shared/protocol/schemas/route-vectors.json, as the Web and iOS do. */
class RouteVectorsTest {
    private val root = File(requireNotNull(System.getProperty("sa.repoRoot")) { "sa.repoRoot is set by app/build.gradle.kts" })
    private val v: JsonObject = Json.parseToJsonElement(File(root, "shared/protocol/schemas/route-vectors.json").readText()).jsonObject

    private fun JsonObject.str(k: String): String? = (this[k] as? JsonElement)?.takeIf { it !is JsonNull }?.jsonPrimitive?.content

    private val config =
        v["monitor"]!!.jsonObject.let {
            MonitorConfig(
                sampleMs = it["sampleMs"]!!.jsonPrimitive.long,
                stallMs = it["stallMs"]!!.jsonPrimitive.long,
                cooldownMs = it["cooldownMs"]!!.jsonPrimitive.long,
                lossWindowMs = it["lossWindowMs"]!!.jsonPrimitive.long,
                lossesToEscalate = it["lossesToEscalate"]!!.jsonPrimitive.int,
                alpha = it["alpha"]!!.jsonPrimitive.doubleOrNull!!
            )
        }

    @Test
    fun classifierMatchesTheSharedVectors() {
        for (c in v["classify"]!!.jsonArray.map { it.jsonObject }) {
            val stats =
                c["stats"]!!.jsonArray.map { e ->
                    val o = e.jsonObject
                    StatsEntry(
                        type = o.str("type")!!,
                        id = o.str("id")!!,
                        selectedCandidatePairId = o.str("selectedCandidatePairId"),
                        localCandidateId = o.str("localCandidateId"),
                        remoteCandidateId = o.str("remoteCandidateId"),
                        currentRoundTripTime = o["currentRoundTripTime"]?.jsonPrimitive?.doubleOrNull,
                        selected = o["selected"]?.jsonPrimitive?.booleanOrNull,
                        nominated = o["nominated"]?.jsonPrimitive?.booleanOrNull,
                        state = o.str("state"),
                        candidateType = o.str("candidateType"),
                        relayProtocol = o.str("relayProtocol")
                    )
                }
            val got = RouteClassifier.classify(stats)
            val name = c.str("name")
            assertEquals(name, c.str("kind"), got.kind?.wire)
            assertEquals(name, (c["rttMs"] as? JsonElement)?.takeIf { it !is JsonNull }?.jsonPrimitive?.longOrNull, got.rttMs)
        }
    }

    @Test
    fun policyLadderMatchesTheSharedVectors() {
        for (p in v["policy"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(p.str("next"), PolicyStep.of(p.str("from"))!!.next?.wire)
        }
    }

    @Test
    fun monitorMatchesTheSharedSequences() {
        for (seq in v["sequences"]!!.jsonArray.map { it.jsonObject }) {
            val m = RouteMonitor(PolicyStep.of(seq.str("step")) ?: PolicyStep.ALL, config)
            for (s in seq["steps"]!!.jsonArray.map { it.jsonObject }) {
                val t = s["t"]!!.jsonPrimitive.long
                val verified = s["verified"]?.jsonPrimitive?.long ?: 0L
                if (s["rebase"]?.jsonPrimitive?.booleanOrNull == true) m.rebase(verified, t)
                val got =
                    if (s.str("event") == "lost") {
                        m.lost(t)
                    } else {
                        m.sample(s["connected"]?.jsonPrimitive?.booleanOrNull == true, verified, s["rttMs"]?.jsonPrimitive?.longOrNull, t)
                    }
                assertEquals("${seq.str("name")} t=$t", s.str("expect"), got.name.lowercase())
            }
        }
    }

    @Test
    fun urisForStepPicksTheTransport() {
        val all = listOf("turn:t:3478?transport=udp", "turn:t:3478?transport=tcp", "turns:t:443?transport=tcp")
        assertEquals(all, urisForStep(all, PolicyStep.ALL))
        assertEquals(listOf(all[0]), urisForStep(all, PolicyStep.RELAY_UDP))
        assertEquals(listOf(all[2]), urisForStep(all, PolicyStep.RELAY_TLS))
        assertEquals(listOf(all[1]), urisForStep(all.take(2), PolicyStep.RELAY_TLS))
        assertEquals(listOf(all[2]), urisForStep(listOf(all[2]), PolicyStep.RELAY_UDP))
    }
}
