package app.shareanywhere.ui.i18n

import org.junit.Assert.assertEquals
import org.junit.Test

class FormatTemplateTest {
    @Test
    fun fillsNamedAndPositionalPlaceholdersLikeTheWeb() {
        assertEquals("Anonymous since 3 Nov", formatTemplate("Anonymous since {date}", mapOf("date" to "3 Nov")))
        assertEquals("Today 14:05", formatTemplate("Today {1}", positional = listOf("14:05")))
        assertEquals("Sending to Lan · 40%", formatTemplate("Sending to {1} · {2}%", positional = listOf("Lan", 40)))
    }

    @Test
    fun leavesUnknownPlaceholdersVisible() {
        assertEquals("Retry in {time}", formatTemplate("Retry in {time}"))
        assertEquals("{2} of {1}", formatTemplate("{2} of {1}", positional = emptyList()))
    }
}
