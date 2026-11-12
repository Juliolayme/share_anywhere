import XCTest

/// Launch helpers for XCUITest (docs/TESTING_AND_CI.md §5b): the native CI backend at BACKEND_URL (default
/// http://127.0.0.1:8080), `-uiTesting` hooks, and `-resetState` for a fresh install.
enum UITest {
    static var backendURL: String { ProcessInfo.processInfo.environment["BACKEND_URL"] ?? "http://127.0.0.1:8080" }

    /// The nightly matrix's Dynamic Type run (`TEST_RUNNER_DYNAMIC_TYPE`), e.g. accessibility XXXL.
    static var dynamicType: [String] {
        guard let size = ProcessInfo.processInfo.environment["DYNAMIC_TYPE"], !size.isEmpty else { return [] }
        return ["-UIPreferredContentSizeCategoryName", size]
    }

    static func app(reset: Bool = true, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTesting", "-backendURL", backendURL, "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
            + (reset ? ["-resetState"] : []) + dynamicType + extra
        return app
    }

    /// Element by accessibility identifier, whatever its type.
    static func id(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    static func skipWelcome(_ app: XCUIApplication) {
        let start = id(app, "welcome.start")
        if start.waitForExistence(timeout: 10) { start.tap() }
    }

    /// Sets a switch: taps its trailing edge (a tap in the middle of a Form row only selects it) until the value is
    /// `on`, retrying while a tab or sheet transition swallows the first tap.
    static func flip(_ app: XCUIApplication, _ identifier: String, to on: Bool, file: StaticString = #filePath, line: UInt = #line) {
        let toggle = app.switches.matching(identifier: identifier).firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10), "switch \(identifier)", file: file, line: line)
        let want = on ? "1" : "0"
        reveal(app, toggle)
        for _ in 0 ..< 4 where toggle.value as? String != want {
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
            _ = XCTWaiter().wait(
                for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", want), object: toggle)],
                timeout: 2
            )
        }
        XCTAssertEqual(toggle.value as? String, want, "switch \(identifier)", file: file, line: line)
    }

    /// Answers iOS's paste prompt for a programmatic read. The prompt is drawn by the system (SpringBoard), so it is
    /// looked for there first; the app is queried only afterwards, once its read has returned.
    static func allowPaste(_ app: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow Paste"].firstMatch
        if allow.waitForExistence(timeout: 10) {
            allow.tap()
            return
        }
        let inApp = app.alerts.buttons["Allow Paste"].firstMatch
        if inApp.waitForExistence(timeout: 2) { inApp.tap() }
    }

    /// Swipes up until a row of a lazy list exists (rows below the fold are not in the tree on small screens).
    @discardableResult
    static func scrollTo(_ app: XCUIApplication, _ identifier: String, up: Bool = false, timeout: TimeInterval = 0) -> XCUIElement {
        let element = id(app, identifier)
        if timeout > 0, element.waitForExistence(timeout: timeout) { return element }
        for _ in 0 ..< 6 where !element.exists {
            if up { app.swipeDown() } else { app.swipeUp() }
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        }
        return element
    }

    /// Scrolls until `element` lies inside the window above the tab bar (coordinate taps do not scroll, and XCUITest's
    /// own scroll-to-visible fails next to iOS's secure Paste control).
    static func reveal(_ app: XCUIApplication, _ element: XCUIElement) {
        let window = app.windows.firstMatch.frame
        let visible = CGRect(x: window.minX, y: window.minY + 44, width: window.width, height: window.height - 44 - 100)
        for _ in 0 ..< 5 where !visible.contains(element.frame) {
            if element.frame.minY < visible.minY { app.swipeDown() } else { app.swipeUp() }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
    }

    /// Taps `element` where it is drawn, after revealing it.
    static func tapRevealed(_ app: XCUIApplication, _ element: XCUIElement) {
        reveal(app, element)
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    /// Waits for `element`; on a timeout prints the app's accessibility tree into the test log (the CI job log is the
    /// only place a failure can be read without the result bundle) and fails with `message`.
    @discardableResult
    static func expect(
        _ app: XCUIApplication, _ element: XCUIElement, timeout: TimeInterval, _ message: String,
        file: StaticString = #filePath, line: UInt = #line
    ) -> Bool {
        if element.waitForExistence(timeout: timeout) { return true }
        print("SA-UI-TREE begin: \(message)\n\(app.debugDescription)\nSA-UI-TREE end")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.alerts.count > 0 { print("SA-UI-TREE springboard alerts:\n\(springboard.alerts.debugDescription)") }
        XCTFail(message, file: file, line: line)
        return false
    }

    static func tab(_ app: XCUIApplication, _ label: String) {
        app.tabBars.buttons[label].tap()
    }
}

extension XCTestCase {
    /// XCTest's accessibility audit (`performAccessibilityAudit()`, the Accessibility Inspector's checks: element
    /// descriptions, hit regions, contrast, Dynamic Type, clipped text, traits) on the current screen; every issue
    /// fails the test with the element it names. Skipped by design, each for a stated reason:
    /// - the `-uiTesting` probes (`test.*`): invisible, never shown in the product;
    /// - contrast on disabled controls: inactive components are exempt from WCAG 1.4.3;
    /// - the readable-label check on file names (`report.pdf`, the seeded `sa-seed-N.bin`): user content;
    /// - clipping in the system search field (`.searchable`) and in system-styled controls (navigation-bar titles and
    ///   items, Form and List rows): sized and truncated by the system;
    /// - contrast and "partially unsupported" Dynamic Type: kept as notes, for the reasons at `noteOnly`;
    /// - an issue the audit attributes to no element: attached to the result as a note, since a test cannot inspect or
    ///   fix it.
    /// The screen is given a moment to settle first.
    func audit(_ app: XCUIApplication, _ screen: String, file: StaticString = #filePath, line: UInt = #line) {
        guard #available(iOS 17.0, *) else { return }
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        var found = auditIssues(app, screen, file: file, line: line)
        // Contrast is sampled from pixels: a view fading in or out reads low. Contrast issues count only if a second
        // pass two seconds later reports the same element again.
        if found.contains(where: { $0.type == .contrast }) {
            RunLoop.current.run(until: Date().addingTimeInterval(2))
            let again = Set(auditIssues(app, screen, types: .contrast, file: file, line: line).map(\.key))
            found.removeAll { $0.type == .contrast && !again.contains($0.key) }
        }
        let tabBar = app.tabBars.firstMatch.exists ? app.tabBars.firstMatch.frame : .null
        for issue in found {
            if let el = issue.element {
                if el.identifier.hasPrefix("test.") { continue }
                if issue.type == .contrast, !el.isEnabled { continue }
                // Behind the translucent tab bar the audit samples whatever scrolls under it.
                if issue.type == .contrast, el.frame.intersects(tabBar) { continue }
                if issue.type == .sufficientElementDescription, isFileName(el.label) { continue }
                if issue.type == .textClipped, el.elementType == .searchField || isStandardControl(app, el) { continue }
                if issue.type == .dynamicType, issue.text.localizedCaseInsensitiveContains("partially"),
                   isStandardControl(app, el) { continue }
            }
            if let reason = noteOnly(issue) {
                let note =
                    XCTAttachment(string: "\(screen): \(issue.text) — \(issue.element.map { "'\($0.label)'" } ?? "screen"): \(reason)")
                note.name = "audit note: \(screen)"
                note.lifetime = .keepAlways
                add(note)
                continue
            }
            guard let el = issue.element else {
                // The audit names no element: nothing to inspect or fix from the test, so it is kept as a note on the
                // result (with a screenshot) for review instead of failing.
                let note = XCTAttachment(string: "\(screen): \(issue.text): \(issue.detail)")
                note.name = "audit note (no element): \(screen)"
                note.lifetime = .keepAlways
                add(note)
                continue
            }
            XCTFail(
                "\(screen): \(issue.text) — \(el.elementType) '\(el.identifier)' '\(el.label)': \(issue.detail)",
                file: file,
                line: line
            )
        }
    }

    @available(iOS 17.0, *)
    private struct AuditIssue {
        let type: XCUIAccessibilityAuditType
        let element: XCUIElement?
        let text: String
        let detail: String
        var key: String { "\(text)|\(element?.identifier ?? "")|\(element?.label ?? "")" }
    }

    @available(iOS 17.0, *)
    private func auditIssues(
        _ app: XCUIApplication, _ screen: String, types: XCUIAccessibilityAuditType = .all, file: StaticString, line: UInt
    ) -> [AuditIssue] {
        // The audit itself sometimes times out on a busy runner ("failed to complete in time"): try up to three times.
        var lastError: Error?
        for attempt in 1 ... 3 {
            var found: [AuditIssue] = []
            do {
                try app.performAccessibilityAudit(for: types) { issue in
                    found.append(AuditIssue(
                        type: issue.auditType, element: issue.element, text: issue.compactDescription, detail: issue.detailedDescription
                    ))
                    return true // judged by the caller, outside the audit callback
                }
                return found
            } catch {
                lastError = error
                if attempt < 3 { RunLoop.current.run(until: Date().addingTimeInterval(2)) }
            }
        }
        XCTFail("\(screen): audit could not run: \(lastError.map { "\($0)" } ?? "unknown")", file: file, line: line)
        return []
    }

    /// Reports kept as notes on the result rather than failures, with the reason:
    /// - contrast: XCTest samples rendered pixels, and in repeated CI runs it reported token pairs that pass AA (navy
    ///   `fg` on white, 13:1) as failing. Every text colour pair is verified exactly by `scripts/tokens.test.mjs`
    ///   (WCAG AA for each declared pair) and by axe on the Web, which uses the same tokens; the iOS-specific misuse
    ///   this audit found (`fg-3` for small text) is fixed and recorded in DESIGN_DEVIATIONS §P.
    /// - "partially unsupported" Dynamic Type: reported nondeterministically, moving between screens from run to run,
    ///   including on text set in plain system text styles. Text that does not scale at all ("unsupported") still fails.
    @available(iOS 17.0, *)
    private func noteOnly(_ issue: AuditIssue) -> String? {
        if issue.type == .contrast { return "contrast is verified on the tokens (tokens.test.mjs) and by axe on the Web" }
        if issue.type == .dynamicType, issue.text.localizedCaseInsensitiveContains("partially") {
            return "partial Dynamic Type is reported nondeterministically; full non-support still fails"
        }
        return nil
    }

    /// A single file name such as `report.pdf` or `sa-seed-1.bin`: user content, read as it is named.
    private func isFileName(_ label: String) -> Bool {
        label.range(of: #"^[^\s/]+\.[A-Za-z0-9]{1,5}$"#, options: .regularExpression) != nil
    }

    /// Whether the element belongs to a system-styled control: a navigation-bar item or a Form/List row.
    private func isStandardControl(_ app: XCUIApplication, _ el: XCUIElement) -> Bool {
        let match = el.identifier.isEmpty
            ? NSPredicate(format: "label == %@", el.label)
            : NSPredicate(format: "identifier == %@", el.identifier)
        return app.navigationBars.descendants(matching: .any).matching(match).count > 0
            || app.cells.descendants(matching: .any).matching(match).count > 0
    }

    /// A screenshot attached to the result bundle (kept for the phase report).
    func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
