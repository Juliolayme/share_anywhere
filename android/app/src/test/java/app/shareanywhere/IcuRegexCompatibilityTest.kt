package app.shareanywhere

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Android compiles `Regex` with ICU, which rejects an unescaped `}` that does not close a `{n,m}` quantifier;
 * the JVM used by unit tests accepts it. Phase 6.1's first emulator run crashed at startup on exactly that
 * (`Regex("\\{(\\w+)}")`), so every `Regex("…")` literal in the app's sources is checked here on the JVM.
 */
class IcuRegexCompatibilityTest {
    private val literal = Regex("""Regex\("((?:[^"\\]|\\.)*)"\)""")

    @Test
    fun everyRegexLiteralIsValidForIcu() {
        val root = File("src/main/java")
        assertTrue("sources not found from ${File(".").absolutePath}", root.isDirectory)
        val problems = mutableListOf<String>()
        root.walkTopDown().filter { it.extension == "kt" }.forEach { file ->
            literal.findAll(file.readText()).forEach { m ->
                val pattern = unescapeKotlin(m.groupValues[1])
                icuProblem(pattern)?.let { problems += "${file.path}: Regex(\"${m.groupValues[1]}\"): $it" }
            }
        }
        assertTrue(problems.joinToString("\n"), problems.isEmpty())
    }

    @Test
    fun theCheckCatchesTheOriginalBug() {
        assertTrue(icuProblem("\\{(\\w+)}") != null)
        assertTrue(icuProblem("\\{(\\w+)\\}") == null)
        assertTrue(icuProblem("a{2,3}[}]") == null)
    }

    private fun unescapeKotlin(s: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '\\' && i + 1 < s.length) {
                out.append(
                    when (val n = s[i + 1]) {
                        'n' -> '\n'
                        't' -> '\t'
                        else -> n
                    }
                )
                i += 2
            } else {
                out.append(c)
                i++
            }
        }
        return out.toString()
    }

    /** Null when ICU accepts every `}` in [p]; otherwise a description of the first offending one. */
    private fun icuProblem(p: String): String? {
        var inClass = false
        var openQuantifier = -1
        var i = 0
        while (i < p.length) {
            val c = p[i]
            when {
                c == '\\' -> i++
                inClass -> if (c == ']') inClass = false
                c == '[' -> inClass = true
                c == '{' -> openQuantifier = i
                c == '}' -> {
                    val body = if (openQuantifier >= 0) p.substring(openQuantifier + 1, i) else null
                    if (body == null || !body.matches(Regex("\\d+(,\\d*)?"))) return "unescaped '}' at index $i"
                    openQuantifier = -1
                }
            }
            i++
        }
        return null
    }
}
