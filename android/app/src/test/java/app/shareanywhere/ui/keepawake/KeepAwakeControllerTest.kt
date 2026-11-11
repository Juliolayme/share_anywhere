package app.shareanywhere.ui.keepawake

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeepAwakeControllerTest {
    @Test
    fun holdsOnlyWhileSomethingNeedsTheScreen() {
        val c = KeepAwakeController()
        assertEquals(PillState.Paused, c.pill.value)
        assertFalse(c.screenOn.value)
        val a = Any()
        val b = Any()
        c.hold(a, true)
        c.hold(b, true)
        assertTrue(c.screenOn.value)
        assertEquals(PillState.On, c.pill.value)
        c.hold(a, false)
        assertTrue("another screen still needs it", c.screenOn.value)
        c.hold(b, false)
        assertFalse(c.screenOn.value)
        assertEquals(PillState.Paused, c.pill.value)
    }

    @Test
    fun theUsersChoiceLastsForThisTransferOnly() {
        val c = KeepAwakeController()
        val a = Any()
        c.hold(a, true)
        assertFalse(c.tap())
        assertEquals(PillState.Off, c.pill.value)
        assertFalse(c.screenOn.value)
        assertFalse(c.tap())
        assertEquals(PillState.On, c.pill.value)
        c.tap()
        c.hold(a, false)
        c.hold(a, true)
        assertEquals("the next session starts with the screen on", PillState.On, c.pill.value)
        assertTrue(c.screenOn.value)
    }

    @Test
    fun theSettingTurnsItOffAndThePillOffersToTurnItBackOn() {
        val c = KeepAwakeController()
        c.hold(Any(), true)
        c.setSetting(false)
        assertEquals(PillState.SetOff, c.pill.value)
        assertFalse(c.screenOn.value)
        assertTrue("tap asks the caller to turn the setting on", c.tap())
        c.setSetting(true)
        assertTrue(c.screenOn.value)
    }

    @Test
    fun pausedIsNotInteractive() {
        val c = KeepAwakeController()
        assertFalse(c.tap())
        assertEquals(PillState.Paused, c.pill.value)
    }
}
