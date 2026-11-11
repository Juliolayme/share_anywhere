package app.shareanywhere.ui.format

import java.time.LocalDateTime
import java.time.ZoneOffset
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FormattersTest {
    private val en = Locale.forLanguageTag("en")
    private val vi = Locale.forLanguageTag("vi")

    @Test
    fun bytesUseDecimalUnitsAndTheLocaleSeparator() {
        assertEquals("999 B", formatBytes(999, en))
        assertEquals("1.5 KB", formatBytes(1_500, en))
        assertEquals("11.6 GB", formatBytes(11_600_000_000, en))
        assertEquals("250 MB", formatBytes(250_000_000, en))
        assertEquals("1,5 KB", formatBytes(1_500, vi))
    }

    @Test
    fun whenLabelSaysTodayYesterdayOrTheDate() {
        val zone = ZoneOffset.UTC
        val now = LocalDateTime.of(2026, 11, 11, 15, 0).toInstant(zone).toEpochMilli()
        val today = LocalDateTime.of(2026, 11, 11, 9, 30).toInstant(zone).toEpochMilli()
        val yesterday = LocalDateTime.of(2026, 11, 10, 23, 59).toInstant(zone).toEpochMilli()
        val earlier = LocalDateTime.of(2026, 10, 2, 8, 0).toInstant(zone).toEpochMilli()
        assertTrue(whenLabel(today, now, en, zone) is WhenLabel.Today)
        assertTrue(whenLabel(yesterday, now, en, zone) is WhenLabel.Yesterday)
        val other = whenLabel(earlier, now, en, zone) as WhenLabel.OnDate
        assertTrue(other.date.contains("2026"))
    }

    @Test
    fun countdownIsMinutesAndSeconds() {
        assertEquals("10:00", formatCountdown(600))
        assertEquals("0:07", formatCountdown(7))
        assertEquals("0:00", formatCountdown(-3))
    }
}
