package app.shareanywhere.identity

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProofOfWorkTest {
    @Test
    fun leadingZeroBitsCountsWholeAndPartialBytes() {
        assertEquals(0, ProofOfWork.leadingZeroBits(byteArrayOf(0x80.toByte())))
        assertEquals(7, ProofOfWork.leadingZeroBits(byteArrayOf(0x01)))
        assertEquals(8, ProofOfWork.leadingZeroBits(byteArrayOf(0x00, 0xFF.toByte())))
        assertEquals(12, ProofOfWork.leadingZeroBits(byteArrayOf(0x00, 0x0F)))
        assertEquals(16, ProofOfWork.leadingZeroBits(byteArrayOf(0x00, 0x00)))
    }

    @Test
    fun solutionMeetsTheDifficultyAndIsShortBase36() = runBlocking {
        val challenge = "challenge-payload.signature"
        for (difficulty in listOf(0, 4, 10, 14)) {
            val solution = ProofOfWork.solve(challenge, difficulty)
            assertTrue(solution.matches(Regex("[0-9a-z]{1,32}")))
            assertTrue("difficulty $difficulty", ProofOfWork.verify(challenge, solution, difficulty))
        }
    }

    @Test
    fun matchesTheServerAlgorithmAndTheWebSolver() = runBlocking {
        // SHA-256("t:0") = 6f88… (1 leading zero bit); SHA-256("t:4") = 1bdb… (3 bits). The Web solver walks the
        // same base-36 counter, so both clients find "4" for difficulty 3.
        assertTrue(ProofOfWork.verify("t", "0", 1))
        assertFalse(ProofOfWork.verify("t", "0", 2))
        assertTrue(ProofOfWork.verify("t", "4", 3))
        assertFalse(ProofOfWork.verify("t", "4", 4))
        assertEquals("4", ProofOfWork.solve("t", 3))
    }
}
