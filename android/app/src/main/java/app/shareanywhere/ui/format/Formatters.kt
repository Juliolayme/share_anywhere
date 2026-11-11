package app.shareanywhere.ui.format

import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * Byte sizes in decimal units (1 GB = 10^9 bytes), as the Web client shows them. Unit symbols are SI symbols,
 * the same in English and Vietnamese; the number uses the UI locale's separators.
 */
fun formatBytes(bytes: Long, locale: Locale): String {
    if (bytes < 1000) return "${NumberFormat.getIntegerInstance(locale).format(bytes)} B"
    val units = listOf("KB", "MB", "GB", "TB")
    var value = bytes / 1000.0
    var i = 0
    while (value >= 1000 && i < units.lastIndex) {
        value /= 1000
        i++
    }
    val nf =
        NumberFormat.getNumberInstance(locale).apply {
            maximumFractionDigits = if (value < 10) {
                2
            } else if (value < 100) {
                1
            } else {
                0
            }
            minimumFractionDigits = 0
        }
    return "${nf.format(value)} ${units[i]}"
}

/** When an entry ended, relative to [now]: which day it was, plus the time in the UI locale. */
sealed interface WhenLabel {
    val time: String

    data class Today(override val time: String) : WhenLabel

    data class Yesterday(override val time: String) : WhenLabel

    data class OnDate(val date: String, override val time: String) : WhenLabel
}

fun whenLabel(epochMs: Long, now: Long, locale: Locale, zone: ZoneId = ZoneId.systemDefault()): WhenLabel {
    val at = Instant.ofEpochMilli(epochMs).atZone(zone)
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val time = at.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))
    val day: LocalDate = at.toLocalDate()
    return when (day) {
        today -> WhenLabel.Today(time)
        today.minusDays(1) -> WhenLabel.Yesterday(time)
        else -> WhenLabel.OnDate(at.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale)), time)
    }
}

/** A calendar date in the UI locale (Devices "Anonymous since"). */
fun formatDate(epochMs: Long, locale: Locale, zone: ZoneId = ZoneId.systemDefault()): String =
    Instant.ofEpochMilli(epochMs).atZone(zone).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))

/** Whole seconds as m:ss for countdowns. */
fun formatCountdown(seconds: Long): String {
    val s = seconds.coerceAtLeast(0)
    return "%d:%02d".format(Locale.ROOT, s / 60, s % 60)
}
