import Foundation
@testable import SATransferRuntime
import XCTest

/// The iOS route engine reproduces shared/protocol/schemas/route-vectors.json, as the Web and Android engines do.
final class RouteVectorsTests: XCTestCase {
    private func routeVectors(_ file: String = #filePath) throws -> [String: Any] {
        var root = URL(fileURLWithPath: file)
        for _ in 0 ..< 5 {
            root.deleteLastPathComponent()
        }
        let data = try Data(contentsOf: root.appendingPathComponent("shared/protocol/schemas/route-vectors.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func config(_ v: [String: Any]) throws -> MonitorConfig {
        let m = try XCTUnwrap(v["monitor"] as? [String: Any])
        var c = MonitorConfig()
        c.sampleMs = try XCTUnwrap(m["sampleMs"] as? NSNumber).int64Value
        c.stallMs = try XCTUnwrap(m["stallMs"] as? NSNumber).int64Value
        c.cooldownMs = try XCTUnwrap(m["cooldownMs"] as? NSNumber).int64Value
        c.lossWindowMs = try XCTUnwrap(m["lossWindowMs"] as? NSNumber).int64Value
        c.lossesToEscalate = try XCTUnwrap(m["lossesToEscalate"] as? NSNumber).intValue
        c.alpha = try XCTUnwrap(m["alpha"] as? NSNumber).doubleValue
        return c
    }

    func testClassifierMatchesTheSharedVectors() throws {
        let cases = try XCTUnwrap(routeVectors()["classify"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let stats = try XCTUnwrap(c["stats"] as? [[String: Any]]).map { o in
                StatsEntry(
                    type: o["type"] as? String ?? "",
                    id: o["id"] as? String ?? "",
                    selectedCandidatePairId: o["selectedCandidatePairId"] as? String,
                    localCandidateId: o["localCandidateId"] as? String,
                    remoteCandidateId: o["remoteCandidateId"] as? String,
                    currentRoundTripTime: (o["currentRoundTripTime"] as? NSNumber)?.doubleValue,
                    selected: o["selected"] as? Bool,
                    nominated: o["nominated"] as? Bool,
                    state: o["state"] as? String,
                    candidateType: o["candidateType"] as? String,
                    relayProtocol: o["relayProtocol"] as? String
                )
            }
            let got = classifyRoute(stats)
            let name = c["name"] as? String ?? "?"
            XCTAssertEqual(got.kind?.rawValue, c["kind"] as? String, name)
            XCTAssertEqual(got.rttMs, (c["rttMs"] as? NSNumber)?.int64Value, name)
        }
    }

    func testPolicyLadderMatchesTheSharedVectors() throws {
        for p in try XCTUnwrap(routeVectors()["policy"] as? [[String: Any]]) {
            let from = try XCTUnwrap(PolicyStep(rawValue: p["from"] as? String ?? ""))
            XCTAssertEqual(from.next?.rawValue, p["next"] as? String)
        }
    }

    func testMonitorMatchesTheSharedSequences() throws {
        let v = try routeVectors()
        let cfg = try config(v)
        for seq in try XCTUnwrap(v["sequences"] as? [[String: Any]]) {
            var m = RouteMonitor(step: PolicyStep(rawValue: seq["step"] as? String ?? "") ?? .all, config: cfg)
            for s in try XCTUnwrap(seq["steps"] as? [[String: Any]]) {
                let t = try XCTUnwrap(s["t"] as? NSNumber).int64Value
                let verified = (s["verified"] as? NSNumber)?.int64Value ?? 0
                if s["rebase"] as? Bool == true { m.rebase(verified: verified, now: t) }
                let got = if s["event"] as? String == "lost" {
                    m.lost(now: t)
                } else {
                    m.sample(
                        connected: s["connected"] as? Bool == true,
                        verified: verified,
                        rttMs: (s["rttMs"] as? NSNumber)?.int64Value,
                        now: t
                    )
                }
                XCTAssertEqual(got.rawValue, s["expect"] as? String, "\(seq["name"] ?? "?") t=\(t)")
            }
        }
    }

    func testMigrationAdvancesTheStepAndSmoothsRtt() {
        var m = RouteMonitor()
        _ = m.sample(connected: true, verified: 0, rttMs: 100, now: 0)
        _ = m.sample(connected: true, verified: 1000, rttMs: 200, now: 2000)
        XCTAssertEqual(m.rttMs, 130)
        XCTAssertEqual(m.bytesPerSecond, 500, accuracy: 0.001)
        XCTAssertEqual(m.sample(connected: true, verified: 1000, rttMs: nil, now: 14000), .migrate)
        XCTAssertEqual(m.step, .relayUdp)
        XCTAssertTrue(m.step.relayOnly)
    }

    func testResetReturnsToTheStartingStepAndHoldsTheCooldown() {
        var m = RouteMonitor()
        _ = m.lost(now: 0)
        XCTAssertEqual(m.lost(now: 1000), .migrate)
        XCTAssertEqual(m.step, .relayUdp)
        m.reset(to: .all, now: 5000)
        XCTAssertEqual(m.step, .all)
        XCTAssertEqual(m.lost(now: 6000), .stay)
        XCTAssertEqual(m.lost(now: 7000), .stay)
        XCTAssertEqual(m.lost(now: 36000), .migrate)
    }

    func testUrisForStepPicksTheTransport() {
        let all = ["turn:t:3478?transport=udp", "turn:t:3478?transport=tcp", "turns:t:443?transport=tcp"]
        XCTAssertEqual(urisForStep(all, .all), all)
        XCTAssertEqual(urisForStep(all, .relayUdp), [all[0]])
        XCTAssertEqual(urisForStep(all, .relayTls), [all[2]])
        XCTAssertEqual(urisForStep(Array(all.prefix(2)), .relayTls), [all[1]])
        XCTAssertEqual(urisForStep([all[2]], .relayUdp), [all[2]])
    }
}
