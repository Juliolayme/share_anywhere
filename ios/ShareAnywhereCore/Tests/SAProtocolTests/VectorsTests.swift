import Foundation
@testable import SAProtocol
import XCTest

/// Repository root, found from this file's path (ios/ShareAnywhereCore/Tests/<target>/<file>).
func repoRoot(_ file: String = #filePath) -> URL {
    URL(fileURLWithPath: file).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
}

func vectors(_ name: String) throws -> [String: Any] {
    let data = try Data(contentsOf: repoRoot().appendingPathComponent("shared/protocol/schemas/\(name)"))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

func pattern(_ n: Int, from: Int64 = 0) -> [UInt8] { (0 ..< n).map { UInt8(truncatingIfNeeded: (from + Int64($0)) * 31 + 7) } }

/// The iOS engine reproduces shared/protocol/schemas/transfer-vectors.json byte for byte (docs/TRANSFER_PROTOCOL.md §8),
/// as the Web and Android engines do.
final class VectorsTests: XCTestCase {
    func testFramesMatchTheSharedVectors() throws {
        let v = try vectors("transfer-vectors.json")
        let frames = try XCTUnwrap(v["frames"] as? [[String: Any]])
        let blockSize = 65536
        let size: Int64 = 200_000
        let file = pattern(Int(size))
        let first = Array(file[0 ..< blockSize])
        var bm = Bitmap(size: 10)
        for i in [0, 3, 9] {
            bm.set(i)
        }
        let cases: [String: [UInt8]] = try [
            "HELLO receiver": Frame.json(.hello, HelloReceiver(sessionId: "s1", participantId: "p1", capability: "c1")),
            "HELLO sender": Frame.json(.hello, HelloSender(sessionId: "s1")),
            "FILE_META": Frame.json(.fileMeta, FileMeta(files: [
                FileMetaEntry(
                    file: 0,
                    fileId: "f1",
                    transferId: "t1",
                    name: "a.bin",
                    size: size,
                    mime: "application/octet-stream",
                    blockSize: blockSize,
                    blockCount: 4
                )
            ])),
            "BITMAP file 0, blocks {0,3,9} of 10": Frame.encode(.bitmap, file: 0, payload: bm.bytes),
            "BLOCK first frame (digest + first 16 bytes), file 0 block 0":
                Frame.encode(.block, flags: Wire.flagFirst, file: 0, block: 0, offset: 0, payload: sha256(first) + first[0 ..< 16]),
            "BLOCK last frame, file 0 block 3 at offset 4096, 8 bytes":
                Frame.encode(
                    .block,
                    flags: Wire.flagLast,
                    file: 0,
                    block: 3,
                    offset: 4096,
                    payload: pattern(8, from: 3 * Int64(blockSize) + 4096)
                ),
            "ACK file 0 block 2": Frame.encode(.ack, file: 0, block: 2),
            "NACK file 0 block 2 checksum": Frame.json(.nack, NackBody(reason: "checksum"), file: 0, block: 2),
            "PAUSE": Frame.encode(.pause),
            "RESUME": Frame.encode(.resume),
            "DONE file 0 from the sender": Frame.json(.done, DoneBody(sha256: sha256(file).hex), file: 0),
            "ERROR cancelled": Frame.json(.error, ErrorBody(code: "cancelled", fatal: true))
        ]
        XCTAssertEqual(frames.count, cases.count)
        for f in frames {
            let name = try XCTUnwrap(f["name"] as? String)
            let bytes = try XCTUnwrap(cases[name], "no case for \(name)")
            XCTAssertEqual(bytes.hex, f["hex"] as? String, name)
            let d = try Frame.decode(bytes)
            XCTAssertEqual(d.encoded.hex, bytes.hex, name)
        }
        // Bodies read back.
        XCTAssertEqual(try Frame.decode(cases["NACK file 0 block 2 checksum"]!).body(NackBody.self).reason, "checksum")
        let meta = try Frame.decode(cases["FILE_META"]!).body(FileMeta.self)
        XCTAssertEqual(meta.files.first?.size, size)
        let hello = try Frame.decode(cases["HELLO receiver"]!).body(HelloBody.self)
        XCTAssertEqual(hello.participantId, "p1")
    }

    func testBitmapsFileHashesAndFramingMatch() throws {
        let v = try vectors("transfer-vectors.json")
        for b in try XCTUnwrap(v["bitmaps"] as? [[String: Any]]) {
            var bm = try Bitmap(size: XCTUnwrap(b["blocks"] as? Int))
            for i in try XCTUnwrap(b["set"] as? [Int]) { bm.set(i) }
            XCTAssertEqual(bm.bytes.hex, b["hex"] as? String)
            if let m = b["missing"] as? [Int] { XCTAssertEqual(bm.missing(), m) }
            if let c = b["missing_count"] as? Int { XCTAssertEqual(bm.missing().count, c) }
            XCTAssertEqual(try Bitmap(size: bm.size, bytes: bm.bytes), bm)
        }
        let f = try XCTUnwrap(v["file"] as? [String: Any])
        let size = try Int64(XCTUnwrap(f["size"] as? Int))
        let bs = try XCTUnwrap(f["block_size"] as? Int)
        let data = pattern(Int(size))
        XCTAssertEqual(Wire.blockCount(size: size, blockSize: bs), f["block_count"] as? Int)
        let sums = (0 ..< Wire.blockCount(size: size, blockSize: bs)).map { i in
            sha256(data[i * bs ..< i * bs + Wire.blockLength(size: size, index: i, blockSize: bs)]).hex
        }
        XCTAssertEqual(sums, f["block_sha256"] as? [String])
        XCTAssertEqual(sha256(data).hex, f["sha256"] as? String)
        var h = StreamHasher()
        // Fed out of order with overlaps, the stream hash still equals the whole-file hash.
        h.update(offset: 0, data[0 ..< 1000])
        XCTAssertFalse(h.update(offset: 5000, data[5000 ..< 6000]))
        h.update(offset: 500, data[500...])
        XCTAssertEqual(h.hex(), f["sha256"] as? String)
        XCTAssertEqual(StreamHasher().hex(), v["empty_file_sha256"] as? String)
        for x in try XCTUnwrap(v["framing"] as? [[String: Any]]) {
            let per = Wire.dataPerFrame(maxMessageSize: x["max_message_size"] as? Int)
            XCTAssertEqual(per, x["data_per_frame"] as? Int)
            let len = try XCTUnwrap(x["block_length"] as? Int)
            XCTAssertEqual((len + Wire.digestBytes + per - 1) / per, x["frames"] as? Int)
        }
    }

    func testMalformedFramesAreRejected() {
        XCTAssertThrowsError(try Frame.decode([1, 4, 0]))
        var bad = Frame.encode(.ack, file: 0, block: 2)
        bad[0] = 2
        XCTAssertThrowsError(try Frame.decode(bad))
        var unknown = Frame.encode(.ack)
        unknown[1] = 99
        XCTAssertThrowsError(try Frame.decode(unknown))
        var length = Frame.encode(.ack)
        length[19] = 1
        XCTAssertThrowsError(try Frame.decode(length))
        // A control frame with a payload, and a first block frame shorter than its digest.
        XCTAssertThrowsError(try Frame.decode(Frame(type: .ack, payload: [1]).encoded))
        XCTAssertThrowsError(
            try Frame
                .decode(Frame(type: .block, flags: Wire.flagFirst, file: 0, payload: [UInt8](repeating: 0, count: 10)).encoded)
        )
        // block and offset beyond the signed 32-bit range of the other engines.
        var big = Frame.encode(.ack, file: 0)
        big[8] = 0x80
        XCTAssertThrowsError(try Frame.decode(big))
        XCTAssertThrowsError(try Frame(type: .nack, payload: Array("{".utf8)).body(NackBody.self))
        XCTAssertThrowsError(try Frame(type: .ack).body(NackBody.self))
        XCTAssertThrowsError(try Bitmap(size: 10, bytes: [0, 0xFF]))
        XCTAssertThrowsError(try Bitmap(size: 10, bytes: [0]))
    }

    func testJSONQuotingMatchesJSONStringify() {
        XCTAssertEqual(JSONObjectWriter.quote("a\"b\\c\n\t\u{01}é/✓"), "\"a\\\"b\\\\c\\n\\t\\u0001é/✓\"")
    }
}
