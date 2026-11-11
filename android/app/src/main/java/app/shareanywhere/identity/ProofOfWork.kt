package app.shareanywhere.identity

import java.security.MessageDigest
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.ensureActive

/**
 * Device-creation proof of work (docs/SECURITY_MODEL.md §4): find `solution` so that
 * SHA-256(token + ":" + solution) starts with `difficulty` zero bits. Solutions are base-36 counters, like the
 * Web client's, so both clients do the same work (difficulty 16 takes about 65,000 hashes on average).
 */
object ProofOfWork {
    /** The server refuses solutions longer than 32 characters (PowSolution.solution maxLength). */
    private const val MAX_SOLUTION = 32
    private const val CHECK_EVERY = 4096

    fun leadingZeroBits(bytes: ByteArray): Int {
        var n = 0
        for (b in bytes) {
            val v = b.toInt() and 0xFF
            if (v == 0) {
                n += 8
                continue
            }
            return n + Integer.numberOfLeadingZeros(v) - 24
        }
        return n
    }

    fun verify(token: String, solution: String, difficulty: Int): Boolean {
        val digest = MessageDigest.getInstance("SHA-256").digest("$token:$solution".toByteArray(Charsets.UTF_8))
        return leadingZeroBits(digest) >= difficulty
    }

    /** Solves on the caller's dispatcher (use Dispatchers.Default); cancellable. */
    suspend fun solve(token: String, difficulty: Int): String {
        require(difficulty in 0..256) { "difficulty out of range" }
        val md = MessageDigest.getInstance("SHA-256")
        val prefix = "$token:".toByteArray(Charsets.UTF_8)
        var i = 0L
        while (true) {
            val solution = i.toString(36)
            check(solution.length <= MAX_SOLUTION)
            md.reset()
            md.update(prefix)
            if (leadingZeroBits(md.digest(solution.toByteArray(Charsets.UTF_8))) >= difficulty) return solution
            if (++i % CHECK_EVERY == 0L) coroutineContext.ensureActive()
        }
    }
}
