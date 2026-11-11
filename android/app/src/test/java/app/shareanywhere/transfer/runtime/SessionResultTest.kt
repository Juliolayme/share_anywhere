package app.shareanywhere.transfer.runtime

import app.shareanywhere.transfer.storage.Folders
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The sender's result rules, as the Web's sender-controller.test.ts and the server's EndStatus. */
class SessionResultTest {
    private fun r(status: TxStatus, delivered: Boolean = false, done: Int = 0, total: Int = 2) = ResultInput(status, delivered, done, total)

    @Test
    fun resultCountsOnlyReceiversThatCount() {
        assertEquals(TxFinal.Completed, SessionResult.final(listOf(r(TxStatus.Completed, done = 2), r(TxStatus.Removed))))
        assertEquals(
            "removed after receiving everything still counts",
            TxFinal.Completed,
            SessionResult.final(listOf(r(TxStatus.Removed, delivered = true)))
        )
        assertEquals(TxFinal.Partial, SessionResult.final(listOf(r(TxStatus.Completed, done = 2), r(TxStatus.Failed, done = 1))))
        assertEquals(TxFinal.Partial, SessionResult.final(listOf(r(TxStatus.Cancelled, done = 1))))
        assertEquals(TxFinal.Failed, SessionResult.final(listOf(r(TxStatus.Failed), r(TxStatus.Cancelled))))
        assertEquals(TxFinal.Cancelled, SessionResult.final(listOf(r(TxStatus.Cancelled), r(TxStatus.Blocked))))
    }

    @Test
    fun aLiveSessionHasNoResultUntilEveryoneEnded() {
        assertNull(SessionResult.of(emptyList(), ended = false))
        assertNull(SessionResult.of(listOf(r(TxStatus.Completed, done = 2), r(TxStatus.Transferring)), ended = false))
        assertNull("nobody counts yet", SessionResult.of(listOf(r(TxStatus.Removed)), ended = false))
        assertEquals(TxFinal.Completed, SessionResult.of(listOf(r(TxStatus.Completed, done = 2)), ended = false))
        assertEquals("an ended session is final", TxFinal.Cancelled, SessionResult.of(listOf(r(TxStatus.Transferring)), ended = true))
    }

    @Test
    fun serverStatusesMapToTheCard() {
        assertEquals(TxStatus.Completed, SessionResult.statusFromServer(listOf("COMPLETED", "COMPLETED")))
        assertEquals(TxStatus.Cancelled, SessionResult.statusFromServer(listOf("COMPLETED", "CANCELLED")))
        assertEquals(TxStatus.Failed, SessionResult.statusFromServer(listOf("CANCELLED", "FAILED")))
        assertEquals(TxStatus.Paused, SessionResult.statusFromServer(listOf("PAUSED", "TRANSFERRING")))
        assertEquals(TxStatus.Reconnecting, SessionResult.statusFromServer(listOf("DISCONNECTED", "PENDING")))
        assertEquals(TxStatus.Transferring, SessionResult.statusFromServer(listOf("RESUMING")))
        assertEquals(TxStatus.Connecting, SessionResult.statusFromServer(listOf("CONNECTING")))
        assertEquals(TxStatus.Waiting, SessionResult.statusFromServer(listOf("PENDING")))
        assertNull(SessionResult.statusFromServer(emptyList()))
    }

    @Test
    fun theSlowestActiveReceiverDecidesTheGroupEta() {
        fun rx(status: TxStatus, eta: Long?) = TxReceiver("p", "n", "x", true, false, status, emptyList(), 0, 0, null, eta = eta)
        assertEquals(-1L, SessionResult.groupEta(listOf(rx(TxStatus.Completed, null))))
        assertNull(SessionResult.groupEta(listOf(rx(TxStatus.Transferring, 30), rx(TxStatus.Connecting, null))))
        assertEquals(
            90L,
            SessionResult.groupEta(listOf(rx(TxStatus.Transferring, 30), rx(TxStatus.Transferring, 90), rx(TxStatus.Paused, null)))
        )
    }

    @Test
    fun throughputIsProvisionalAtFirstAndAfterAStall() {
        val t = Throughput()
        t.sample(0, 0)
        assertNull("provisional before 3 %", t.estimate(0, 1000).second)
        t.sample(100, 1000)
        t.sample(200, 2000)
        val (bps, eta) = t.estimate(200, 1000)
        assertEquals(100.0, bps, 0.001)
        assertEquals(8L, eta)
        t.sample(200, 13_000)
        assertEquals("stalled for 10 s", 0.0, t.estimate(200, 1000).first, 0.0)
        assertNull(t.estimate(200, 1000).second)
        assertNull(
            "reconnecting",
            Throughput().apply {
                sample(0, 0)
                sample(500, 1000)
            }.estimate(500, 1000, reconnecting = true).second
        )
    }

    @Test
    fun receivedFileNamesCannotEscapeTheFolder() {
        assertEquals("_etc_passwd", Folders.safeName("/etc/passwd"))
        assertEquals("a_b", Folders.safeName("a\\\\b".replace("\\\\", "\\")))
        assertEquals("hidden", Folders.safeName("..hidden"))
        assertEquals("file", Folders.safeName("..."))
        assertEquals("x_y", Folders.safeName("x\u0000y"))
        assertEquals(200, Folders.safeName("a".repeat(500)).length)
    }

    @Test
    fun redialBacksOffWithJitter() {
        assertEquals(1000L, ReceiverController.redialDelay(0) { 0.5 })
        assertEquals(8000L, ReceiverController.redialDelay(3) { 0.5 })
        assertEquals(15000L, ReceiverController.redialDelay(9) { 0.5 })
        assertEquals(750L, ReceiverController.redialDelay(0) { 0.0 })
    }
}
