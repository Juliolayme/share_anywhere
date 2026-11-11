package app.shareanywhere.transfer.runtime

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ReporterTest {
    @Test
    fun pathsFollowTheServerStateMachine() {
        assertEquals(listOf("CONNECTING", "TRANSFERRING"), Transitions.pathTo("PENDING", "TRANSFERRING"))
        assertEquals(listOf("CONNECTING", "TRANSFERRING"), Transitions.pathTo("DISCONNECTED", "TRANSFERRING"))
        assertEquals(listOf("RECONNECTING", "RESUMING"), Transitions.pathTo("DISCONNECTED", "RESUMING"))
        assertEquals(listOf("CONNECTING", "TRANSFERRING", "COMPLETED"), Transitions.pathTo("PENDING", "COMPLETED"))
        assertEquals("never leaves PAUSED for an active state", emptyList<String>(), Transitions.pathTo("PAUSED", "TRANSFERRING"))
        assertEquals(listOf("COMPLETED"), Transitions.pathTo("PAUSED", "COMPLETED"))
        assertEquals(emptyList<String>(), Transitions.pathTo("COMPLETED", "FAILED"))
        assertEquals(listOf("PAUSED"), Transitions.pathTo("TRANSFERRING", "PAUSED"))
        // Never through PAUSED on the way elsewhere.
        assertEquals(listOf("CONNECTING", "RESUMING"), Transitions.pathTo("PENDING", "RESUMING"))
    }

    private class FakeSink : ReportSink {
        val calls = mutableListOf<Triple<String, String, Long>>()

        override suspend fun report(transferId: String, status: String, verifiedBytes: Long, route: String?): String {
            calls += Triple(transferId, status, verifiedBytes)
            return status
        }
    }

    @Test
    fun statesWalkThroughAllowedStepsAndProgressIsThrottled() = runTest {
        val sink = FakeSink()
        var clock = 0L
        val r = Reporter(sink, backgroundScope, intervalMs = 2000, now = { clock })
        r.seed("t1", "PENDING", 0)
        r.state("t1", "TRANSFERRING", 10)
        assertEquals(listOf("CONNECTING", "TRANSFERRING"), sink.calls.map { it.second })
        r.progress("t1", 100)
        r.progress("t1", 200)
        runCurrent()
        assertEquals(2, sink.calls.size)
        clock += 2000
        advanceTimeBy(2001)
        runCurrent()
        assertEquals(Triple("t1", "TRANSFERRING", 200L), sink.calls.last())
        r.state("t1", "COMPLETED", 300)
        r.state("t1", "FAILED")
        assertEquals("terminal states end reporting", "COMPLETED", sink.calls.last().second)
    }

    @Test
    fun leavingPausedGoesThroughResume() = runTest {
        val sink = FakeSink()
        val r = Reporter(sink, backgroundScope)
        r.seed("t1", "PAUSED", 0)
        var resumed = 0
        r.resume = {
            resumed++
            "RESUMING"
        }
        r.state("t1", "TRANSFERRING")
        assertEquals(1, resumed)
        assertEquals(listOf("TRANSFERRING"), sink.calls.map { it.second })
        r.seed("t2", "PAUSED", 0)
        r.resume = { null }
        r.state("t2", "TRANSFERRING")
        assertEquals("stays paused when the user paused it", "PAUSED", r.current("t2"))
    }
}
