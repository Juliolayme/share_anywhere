package app.shareanywhere.ui.receive

import app.shareanywhere.data.api.Participant
import app.shareanywhere.data.api.SessionView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceiveSessionUiTest {
    private fun view(status: String, me: String) = SessionView(
        id = "s",
        role = "receiver",
        status = status,
        requireApproval = true,
        me = Participant("p", "receiver", me, "Maple River", "Android", false),
        totalBytes = 0,
        fileCount = 0,
        protectedMode = false,
        expiresAt = "2026-01-01T00:00:00Z",
        serverTime = "2026-01-01T00:00:00Z"
    )

    @Test
    fun outcomesFollowTheParticipantThenTheSession() {
        assertEquals(Outcome.Removed, ReceiveSessionUi(view("ACTIVE", "REMOVED")).outcome)
        assertEquals(Outcome.Blocked, ReceiveSessionUi(view("ACTIVE", "BLOCKED")).outcome)
        assertEquals(Outcome.Rejected, ReceiveSessionUi(view("WAITING", "REJECTED")).outcome)
        assertEquals(Outcome.Left, ReceiveSessionUi(view("WAITING", "LEFT")).outcome)
        assertEquals(Outcome.Closed, ReceiveSessionUi(view("CLOSED", "JOINED")).outcome)
        assertEquals(Outcome.Ended, ReceiveSessionUi(view("EXPIRED", "JOINED")).outcome)
        assertEquals(Outcome.Ended, ReceiveSessionUi(gone = true).outcome)
        assertNull(ReceiveSessionUi(view("COMPLETED", "JOINED")).outcome)
    }

    @Test
    fun waitingAndJoinedAreExclusive() {
        val waiting = ReceiveSessionUi(view("WAITING", "REQUESTED"))
        assertTrue(waiting.waiting)
        assertFalse(waiting.joined)
        val joined = ReceiveSessionUi(view("ACTIVE", "JOINED"))
        assertTrue(joined.joined)
        assertFalse(joined.waiting)
        assertFalse(ReceiveSessionUi(view("CLOSED", "REQUESTED")).waiting)
    }
}
