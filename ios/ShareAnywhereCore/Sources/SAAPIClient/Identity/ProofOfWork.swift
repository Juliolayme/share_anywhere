import Crypto
import Foundation

/// Device-creation proof of work (docs/SECURITY_MODEL.md §4): find `solution` so that SHA-256(token + ":" + solution)
/// starts with `difficulty` zero bits. Solutions are base-36 counters, like the Web's and Android's, so every client
/// does the same work (difficulty 16 takes about 65,000 hashes on average).
public enum ProofOfWork {
    /// The server refuses solutions longer than 32 characters (PowSolution.solution maxLength).
    static let maxSolution = 32

    public static func leadingZeroBits(_ bytes: some Sequence<UInt8>) -> Int {
        var n = 0
        for b in bytes {
            if b == 0 {
                n += 8
                continue
            }
            return n + b.leadingZeroBitCount
        }
        return n
    }

    public static func verify(token: String, solution: String, difficulty: Int) -> Bool {
        leadingZeroBits(SHA256.hash(data: Array("\(token):\(solution)".utf8))) >= difficulty
    }

    /// Solves on the calling task; checks for cancellation every 4,096 attempts.
    public static func solve(token: String, difficulty: Int) throws -> String {
        precondition((0 ... 256).contains(difficulty), "difficulty out of range")
        let prefix = Array("\(token):".utf8)
        var i: UInt64 = 0
        while true {
            let solution = String(i, radix: 36)
            precondition(solution.count <= maxSolution)
            var h = SHA256()
            h.update(data: prefix)
            h.update(data: Array(solution.utf8))
            if leadingZeroBits(h.finalize()) >= difficulty { return solution }
            i += 1
            if i % 4096 == 0 { try Task.checkCancellation() }
        }
    }
}
