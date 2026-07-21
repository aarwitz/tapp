import XCTest

/// Autonomous exploration engine for iOS QA.
/// Runs as a UI test that attaches to any app via bundle ID.
/// Communicates results via OCQA_ prefixed stdout markers.
///
/// Fully generalized — no app-specific logic. Uses depth-first exploration
/// that prioritizes in-screen content over persistent navigation (tab bars).
///
/// Modes:
/// - testAutonomousExploration: Full autonomous exploration loop
/// - testDumpUITree: One-shot accessibility tree dump
/// - testTapAtCoordinate / testTapById: Single action for engine control
/// - testScreenshot: Capture and attach a screenshot
class ExplorerTests: XCTestCase {

    private struct InputDescriptor {
        let key: String
        let label: String
        let secure: Bool
        let placeholder: String
    }

    var app: XCUIApplication!
    /// Set whenever OCQA_COMPLETE is printed — the crash-teardown net only fires without it.
    var didEmitComplete = false
    var config: [String: Any] = [:]
    /// Detected once at setUp; avoids hardcoded device dimensions
    private var screenBounds: CGRect = .zero
    /// Set by performSmartAction for the most recent type action, read by narrate()
    private var lastTypedWasOverride = false
    private var lastTypedSecure = false
    /// Screens already reported for a11y-invisible field content (one finding per screen).
    private var valueHiddenReported = Set<String>()

    var targetBundleId: String { config["OCQA_BUNDLE_ID"] as? String ?? ProcessInfo.processInfo.environment["OCQA_BUNDLE_ID"] ?? "" }
    var maxActions: Int { Int(config["OCQA_MAX_ACTIONS"] as? String ?? ProcessInfo.processInfo.environment["OCQA_MAX_ACTIONS"] ?? "400") ?? 400 }
    var timeoutSeconds: Int { Int(config["OCQA_TIMEOUT_SECONDS"] as? String ?? ProcessInfo.processInfo.environment["OCQA_TIMEOUT_SECONDS"] ?? "1800") ?? 1800 }
    /// Launch arguments to forward to the target app (e.g. ["--uitesting"])
    var appLaunchArgs: [String] { config["OCQA_APP_LAUNCH_ARGS"] as? [String] ?? [] }
    /// Environment variables to forward to the target app (e.g. ["UI_TEST_ROLE": "resident"])
    var appLaunchEnv: [String: String] {
        if let dict = config["OCQA_APP_LAUNCH_ENV"] as? [String: String] { return dict }
        return [:]
    }
    /// Targeted exploration: beeline to this screen (following `route`, a sequence of control
    /// labels) before exploring. Empty = normal broad exploration.
    var targetScreen: String { config["OCQA_TARGET_SCREEN"] as? String ?? "" }
    var route: [String] { config["OCQA_ROUTE"] as? [String] ?? [] }

    /// Resolve a string key: config (as String) -> process environment -> fallback
    private func resolve(_ key: String, fallback: String = "") -> String {
        if let v = config[key] as? String { return v }
        if let v = ProcessInfo.processInfo.environment[key], !v.isEmpty { return v }
        return fallback
    }

    private func loadConfig() {
        // OCQA_CONFIG_PATH (forwarded from the host via TEST_RUNNER_OCQA_CONFIG_PATH) is
        // authoritative and per-run — checked FIRST so each device reads its own config and
        // never picks up a stale /tmp file from a previous run.
        let paths = [
            ProcessInfo.processInfo.environment["OCQA_CONFIG_PATH"] ?? "",
            "/tmp/ocqa-run-config.json",
            NSTemporaryDirectory() + "ocqa-run-config.json",
        ]
        for path in paths where !path.isEmpty {
            if let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
               let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                config = dict
                print("OCQA_STATE:config_loaded path=\(path) overrides=\((dict["OCQA_INPUT_OVERRIDES"] as? [String: String])?.count ?? 0)")
                return
            }
        }
        print("OCQA_STATE:config_not_found — using defaults")
    }

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
        loadConfig()
        if !targetBundleId.isEmpty {
            app = XCUIApplication(bundleIdentifier: targetBundleId)
        } else {
            app = XCUIApplication()
        }

        // Crash safety net, registered BEFORE launch: an app that dies in setUp (instant
        // launch crash) or mid-run aborts the test on the next XCUITest query — teardown
        // blocks still run, so a dead app + no OCQA_COMPLETE becomes a CRITICAL crash
        // finding instead of a zero-marker run. (Corpus finding: Yattee dies at launch;
        // the frame query at the end of setUp threw before the test body could arm a net.)
        addTeardownBlock { [self] in
            if !didEmitComplete, let app, app.state != .runningForeground {
                didEmitComplete = true
                print("OCQA_ISSUE:{\"type\":\"crash\",\"severity\":\"critical\",\"title\":\"App crashed at launch or during the run (terminated mid-query)\",\"screen\":\"Launch\",\"step\":0}")
                print("OCQA_COMPLETE:{\"actions\":0,\"states\":0,\"issues\":1,\"screens\":\"\",\"outcome\":\"crash_teardown\"}")
            }
        }

        // Handle system alerts (location, notifications, tracking, etc.)
        addUIInterruptionMonitor(withDescription: "System Alert") { alert in
            let allowLabels = ["Allow", "Allow While Using App", "OK", "Continue", "Allow Full Access"]
            for label in allowLabels {
                let btn = alert.buttons[label]
                if btn.exists {
                    btn.tap()
                    return true
                }
            }
            if alert.buttons.count > 0 {
                alert.buttons.element(boundBy: 0).tap()
                return true
            }
            return false
        }

        // Launch with auth-bypass args if configured, otherwise just activate
        if !appLaunchArgs.isEmpty || !appLaunchEnv.isEmpty {
            app.launchArguments = appLaunchArgs
            app.launchEnvironment = appLaunchEnv
            app.launch()
            _ = app.wait(for: .runningForeground, timeout: 10)
        } else {
            app.activate()
            let started = app.wait(for: .runningForeground, timeout: 10)
            if !started {
                app.launch()
                _ = app.wait(for: .runningForeground, timeout: 10)
            }
        }

        // Detect actual screen dimensions from the running app — but only if it survived
        // launch (a frame query on a dead app throws; the teardown net reports the crash).
        guard app.state == .runningForeground else { return }
        let windowFrame = app.windows.firstMatch.frame
        if windowFrame.width > 0 && windowFrame.height > 0 {
            screenBounds = windowFrame
        } else {
            screenBounds = app.frame
        }
    }

    // MARK: - UI Tree Dump

    func testDumpUITree() {
        let elements = readUITree(app)
        let state = buildAppState(elements: elements)
        emitUITree(state)
    }

    // MARK: - Tap Actions

    func testTapAtCoordinate() {
        let xStr = resolve("OCQA_TAP_X")
        let yStr = resolve("OCQA_TAP_Y")
        guard !xStr.isEmpty, !yStr.isEmpty,
              let x = Double(xStr), let y = Double(yStr) else {
            XCTFail("OCQA_TAP_X and OCQA_TAP_Y must be set")
            return
        }
        let coord = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: x, dy: y))
        coord.tap()
        print("OCQA_ACTION:{\"type\":\"tap\",\"x\":\(x),\"y\":\(y)}")
        Thread.sleep(forTimeInterval: 0.5)
    }

    func testTapById() {
        let identifier = resolve("OCQA_TAP_ID")
        guard !identifier.isEmpty else {
            XCTFail("OCQA_TAP_ID must be set")
            return
        }
        let queries: [XCUIElementQuery] = [
            app.buttons, app.staticTexts, app.cells,
            app.links, app.switches, app.textFields
        ]
        for query in queries {
            let element = query[identifier]
            if element.exists && element.isHittable {
                element.tap()
                print("OCQA_ACTION:{\"type\":\"tap\",\"identifier\":\"\(identifier)\"}")
                Thread.sleep(forTimeInterval: 0.5)
                return
            }
        }
        let predicate = NSPredicate(format: "label == %@", identifier)
        let match = app.descendants(matching: .any).matching(predicate).firstMatch
        if match.exists && match.isHittable {
            match.tap()
            print("OCQA_ACTION:{\"type\":\"tap\",\"label\":\"\(identifier)\"}")
        } else {
            print("OCQA_ACTION:{\"type\":\"tap\",\"identifier\":\"\(identifier)\",\"status\":\"not_found\"}")
        }
        Thread.sleep(forTimeInterval: 0.5)
    }

    // MARK: - Swipe Actions

    func testSwipe() {
        let dir = resolve("OCQA_SWIPE_DIR", fallback: "up")
        switch dir {
        case "up":    app.swipeUp()
        case "down":  app.swipeDown()
        case "left":  app.swipeLeft()
        case "right": app.swipeRight()
        default:      app.swipeUp()
        }
        print("OCQA_ACTION:{\"type\":\"swipe\",\"direction\":\"\(dir)\"}")
        Thread.sleep(forTimeInterval: 0.5)
    }

    // MARK: - Type Text

    func testTypeText() {
        let text = resolve("OCQA_TYPE_TEXT")
        guard !text.isEmpty else {
            XCTFail("OCQA_TYPE_TEXT must be set")
            return
        }
        let identifier = resolve("OCQA_TYPE_ID")
        if !identifier.isEmpty {
            let field = app.textFields[identifier]
            if field.exists {
                field.tap()
                field.typeText(text)
                print("OCQA_ACTION:{\"type\":\"typeText\",\"identifier\":\"\(identifier)\"}")
                return
            }
            let secure = app.secureTextFields[identifier]
            if secure.exists {
                secure.tap()
                secure.typeText(text)
                print("OCQA_ACTION:{\"type\":\"typeText\",\"identifier\":\"\(identifier)\"}")
                return
            }
        }
        let firstField = app.textFields.firstMatch
        if firstField.exists {
            firstField.tap()
            firstField.typeText(text)
        }
        print("OCQA_ACTION:{\"type\":\"typeText\"}")
    }

    // MARK: - Navigation

    func testGoBack() {
        let backButton = app.navigationBars.buttons.firstMatch
        if backButton.exists && backButton.isHittable {
            backButton.tap()
            print("OCQA_ACTION:{\"type\":\"back\",\"method\":\"button\"}")
        } else {
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
            start.press(forDuration: 0.05, thenDragTo: end)
            print("OCQA_ACTION:{\"type\":\"back\",\"method\":\"swipe\"}")
        }
        Thread.sleep(forTimeInterval: 0.5)
    }

    // MARK: - Screenshot

    func testScreenshot() {
        let label = resolve("OCQA_SCREENSHOT_LABEL", fallback: "screenshot")
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = label
        attachment.lifetime = .keepAlways
        add(attachment)
        print("OCQA_ACTION:{\"type\":\"screenshot\",\"label\":\"\(label)\"}")
    }

    // MARK: - Interactive Session (Playwright-style tap → inspect loop)

    /// Launches the app ONCE and then services a queue of single commands from a file, emitting the
    /// fresh accessibility tree after each — so a client (the MCP server / Copilot) can drive
    /// tap/type/swipe/inspect loops without paying a cold XCUITest launch per action. Commands are
    /// JSON `{seq, action, id?, x?, y?, text?, direction?, label?}` written to OCQA_SESSION_CMD_PATH;
    /// a `{seq, status, action}` ack is written to OCQA_SESSION_RESULT_PATH and the tree goes to stdout.
    func testInteractiveSession() {
        // Fresh launch for a deterministic starting screen — terminate any leftover instance first
        // so the session always begins from the app's launch state, not whatever a prior run left.
        // Reapply the configured launch args/env (e.g. backend override, login bypass) on relaunch.
        if !targetBundleId.isEmpty { app.terminate() }
        app.launchArguments = appLaunchArgs
        app.launchEnvironment = appLaunchEnv
        app.launch()
        var lastCount = 0
        for _ in 0..<5 {
            Thread.sleep(forTimeInterval: 0.4)
            let q = app.descendants(matching: .any)
            _ = q.firstMatch.waitForExistence(timeout: 3)
            let c = q.count
            if c > 10 && c == lastCount { break }
            lastCount = c
        }

        let cmdPath = resolve("OCQA_SESSION_CMD_PATH", fallback: "/tmp/ocqa-session-cmd.json")
        let resultPath = resolve("OCQA_SESSION_RESULT_PATH", fallback: "/tmp/ocqa-session-result.json")
        let sessionTimeout = Double(resolve("OCQA_SESSION_TIMEOUT", fallback: "1800")) ?? 1800

        try? FileManager.default.removeItem(atPath: cmdPath)
        print("OCQA_SESSION:ready")
        emitSessionTree()

        let start = Date()
        var lastSeq = -1
        while Date().timeIntervalSince(start) < sessionTimeout {
            Thread.sleep(forTimeInterval: 0.25)
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: cmdPath)),
                  let cmd = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let seq = cmd["seq"] as? Int, seq != lastSeq else { continue }
            lastSeq = seq
            let action = (cmd["action"] as? String ?? "").lowercased()
            var status = "ok"

            switch action {
            case "tap":
                if let id = cmd["id"] as? String, !id.isEmpty {
                    status = sessionTapById(id)
                } else if let x = cmd["x"] as? Double, let y = cmd["y"] as? Double {
                    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
                } else { status = "bad_args" }
            case "type":
                status = sessionType(cmd["text"] as? String ?? "", id: cmd["id"] as? String) ? "ok" : "not_found"
            case "swipe":
                switch (cmd["direction"] as? String ?? "up") {
                case "down": app.swipeDown(); case "left": app.swipeLeft(); case "right": app.swipeRight(); default: app.swipeUp()
                }
            case "back":
                sessionBack()
            case "wait":
                let target = (cmd["id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (cmd["text"] as? String ?? "")
                let waitMs = (cmd["timeoutMs"] as? Int) ?? 5000
                status = sessionWaitFor(target, timeoutMs: waitMs) ? "ok" : "timeout"
            case "tree", "inspect":
                break
            case "screenshot":
                let shot = app.screenshot()
                let a = XCTAttachment(screenshot: shot); a.name = cmd["label"] as? String ?? "session"; a.lifetime = .keepAlways; add(a)
            case "quit":
                print("OCQA_SESSION:bye")
                try? "{\"seq\":\(seq),\"status\":\"ok\",\"action\":\"quit\"}".write(toFile: resultPath, atomically: true, encoding: .utf8)
                return
            default:
                status = "unknown_action"
            }

            waitForAnimationsToSettle()
            emitSessionTree()
            try? "{\"seq\":\(seq),\"status\":\"\(status)\",\"action\":\"\(escapeJSON(action))\"}"
                .write(toFile: resultPath, atomically: true, encoding: .utf8)
        }
        print("OCQA_SESSION:timeout")
    }

    private func emitSessionTree() {
        emitUITree(buildAppState(elements: readUITree(app)))
    }

    /// Returns "ok" if tapped, "not_hittable" if the element exists but couldn't be tapped (disabled,
    /// or covered by the keyboard even after dismissing it), or "not_found" if nothing matched. The
    /// distinction tells the caller whether to enter valid input first vs. that the target is absent.
    private func sessionTapById(_ identifier: String) -> String {
        var existedButNotHittable = false
        func tryTap(_ el: XCUIElement) -> Bool {
            guard el.exists else { return false }
            if el.isHittable { el.tap(); return true }
            // Often covered by the keyboard (a submit button below filled fields) — dismiss + retry,
            // like Playwright auto-scrolls a target into view.
            dismissKeyboardIfPresent()
            if el.isHittable { el.tap(); return true }
            existedButNotHittable = true
            return false
        }
        let queries: [XCUIElementQuery] = [app.buttons, app.staticTexts, app.cells, app.links, app.switches, app.textFields]
        for query in queries where tryTap(query[identifier]) { return "ok" }
        // Exact label, then a forgiving case-insensitive "contains" match so callers can tap by the
        // visible text they see in the tree without an exact accessibility id.
        if tryTap(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", identifier)).firstMatch) { return "ok" }
        if tryTap(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", identifier)).firstMatch) { return "ok" }
        return existedButNotHittable ? "not_hittable" : "not_found"
    }

    private func dismissKeyboardIfPresent() {
        guard app.keyboards.count > 0 else { return }
        // Tap a neutral area near the top (logo/title space) to resign the keyboard without hitting a control.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        Thread.sleep(forTimeInterval: 0.4)
    }

    private func sessionWaitFor(_ target: String, timeoutMs: Int) -> Bool {
        guard !target.isEmpty else { return false }
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        repeat {
            let queries: [XCUIElementQuery] = [app.buttons, app.staticTexts, app.cells, app.links, app.switches, app.textFields, app.otherElements]
            for q in queries where q[target].exists { return true }
            if app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR label CONTAINS[c] %@", target, target)).firstMatch.exists { return true }
            Thread.sleep(forTimeInterval: 0.3)
        } while Date() < deadline
        return false
    }

    @discardableResult
    private func sessionType(_ text: String, id: String?) -> Bool {
        // Explicit target by accessibility id/label across text AND secure fields.
        if let id = id, !id.isEmpty {
            for field in [app.textFields[id], app.secureTextFields[id]] where field.exists {
                field.tap(); field.typeText(text); return true
            }
        }
        // Otherwise type into whatever field currently has keyboard focus — this respects a prior
        // tap (e.g. tap the password field by coordinate, then type). Critical for login forms whose
        // fields have NO accessibility id/label: without this, every value falls to the first text
        // field (the email), so the password ends up in the email box.
        if app.keyboards.firstMatch.exists {
            app.typeText(text)
            return true
        }
        // Nothing focused and no usable id — last resort: the first text field.
        let first = app.textFields.firstMatch
        if first.exists { first.tap(); first.typeText(text); return true }
        return false
    }

    private func sessionBack() {
        let backButton = app.navigationBars.buttons.firstMatch
        if backButton.exists && backButton.isHittable {
            backButton.tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)))
        }
    }

    /// Replays an explicit, config-driven login flow (OCQA_LOGIN_STEPS) before exploration — for the
    /// custom login UIs the heuristic preamble can't parse, which are the #1 reason a real app stays
    /// invisible to AutoTap. Steps are a JSON array of {action: type|tap|wait, target: <id-or-label>,
    /// value?: <text; "$TEST_EMAIL"/"$TEST_PASSWORD" substituted from stored creds>, timeoutMs?}.
    /// Returns true if any step ran (so the caller skips the heuristic preamble). Tolerant: a failed
    /// step is logged but doesn't abort — exploration still proceeds, and the coverage eval reveals
    /// whether login was actually passed (login_present without a wall).
    private func executeLoginSteps(_ json: String, email: String, password: String) -> Bool {
        guard let data = json.data(using: .utf8),
              let steps = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]],
              !steps.isEmpty else { return false }
        print("OCQA_STATE:login_replay_started steps=\(steps.count)")
        waitForUIStability(timeout: 2.0)
        for (i, step) in steps.enumerated() {
            let action = (step["action"] as? String ?? "").lowercased()
            let target = step["target"] as? String ?? ""
            let value = (step["value"] as? String ?? "")
                .replacingOccurrences(of: "$TEST_EMAIL", with: email)
                .replacingOccurrences(of: "$TEST_PASSWORD", with: password)
            var status = "ok"
            switch action {
            case "type": status = sessionType(value, id: target) ? "ok" : "field_not_found"
            case "tap":  status = sessionTapById(target)
            case "wait":
                let ms = (step["timeoutMs"] as? Int) ?? 5000
                status = sessionWaitFor(target, timeoutMs: ms) ? "ok" : "timeout"
            default:     status = "unknown_action"
            }
            print("OCQA_ACTION:{\"type\":\"login_\(escapeJSON(action))\",\"target\":\"\(escapeJSON(target))\",\"step\":\(i + 1),\"status\":\"\(escapeJSON(status))\",\"reason\":\"login_replay\"}")
            waitForAnimationsToSettle()
        }
        print("OCQA_STATE:login_replay_done")
        return true
    }

    // MARK: - Flow replay (deterministic E2E tests)
    //
    // Replays a recorded/authored Flow (see docs/flows-architecture.md) step-by-step and checks its
    // assertions. Deterministic by construction: fresh launch, wait-for-stability between steps,
    // poll-with-timeout assertions (never instant-checks), and the same id→label→contains selector
    // resolution the session uses. Exact assertions gate pass/fail; `assert_ai` is opt-in and routed
    // host-side (skipped when no judge is configured, so the deterministic core runs everywhere).
    func testReplayFlow() {
        let flowJson = resolve("OCQA_FLOW_JSON")
        guard !flowJson.isEmpty,
              let data = flowJson.data(using: .utf8),
              let flow = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let steps = flow["steps"] as? [[String: Any]] else {
            print("OCQA_FLOW_RESULT:{\"passed\":false,\"total\":0,\"failed\":0,\"error\":\"no OCQA_FLOW_JSON with steps\"}")
            return
        }
        // Variable substitution: $TEST_EMAIL/$TEST_PASSWORD from creds, plus any OCQA_FLOW_VARS.
        var vars: [String: String] = ["TEST_EMAIL": resolve("OCQA_TEST_EMAIL", fallback: "test@example.com"),
                                      "TEST_PASSWORD": resolve("OCQA_TEST_PASSWORD", fallback: "TestPass123!")]
        if let vd = flow["vars"] as? [String: Any] {
            for (k, v) in vd { vars[k] = "\(v)" }
        }
        if let extra = (try? JSONSerialization.jsonObject(with: Data(resolve("OCQA_FLOW_VARS").utf8))) as? [String: Any] {
            for (k, v) in extra { vars[k] = "\(v)" }
        }
        func subst(_ s: String) -> String {
            var out = s
            for (k, v) in vars { out = out.replacingOccurrences(of: "$\(k)", with: v) }
            return out
        }

        if !targetBundleId.isEmpty { app.launch() } else { app.launch() }
        waitForUIStability(timeout: 3.0)
        print("OCQA_FLOW_RESULT:started total=\(steps.count) name=\(escapeJSON(flow["name"] as? String ?? "flow"))")

        var failed = 0
        var aiIndex = 0
        for (i, raw) in steps.enumerated() {
            let idx = i + 1
            // A step is either {action: value} sugar or {action:..., target/value/...}. Normalize.
            let (action, step) = normalizeFlowStep(raw)
            let target = subst((step["target"] as? String) ?? "")
            let value = subst((step["value"] as? String) ?? "")
            let timeoutMs = (step["timeoutMs"] as? Int) ?? 6000
            var status = "pass"
            var detail = ""

            switch action {
            case "tap":
                status = sessionTapById(target) == "ok" ? "pass" : "fail"
                if status == "fail" { detail = "could not tap ‘\(target)’" }
            case "type":
                status = sessionType(value, id: target.isEmpty ? nil : target) ? "pass" : "fail"
                if status == "fail" { detail = "no field ‘\(target)’ to type into" }
            case "swipe":
                switch target.lowercased() { case "down": app.swipeDown(); case "left": app.swipeLeft(); case "right": app.swipeRight(); default: app.swipeUp() }
            case "back":
                _ = tryGoBack()
            case "wait":
                Thread.sleep(forTimeInterval: Double(timeoutMs) / 1000.0)
            case "wait_for":
                status = sessionWaitFor(target, timeoutMs: timeoutMs) ? "pass" : "fail"
                if status == "fail" { detail = "‘\(target)’ never appeared within \(timeoutMs)ms" }
            case "assert_screen":
                let ok = pollUntil(timeoutMs: timeoutMs) { (detectTitle(readUITree(app)) ?? "").caseInsensitiveCompare(value.isEmpty ? target : value) == .orderedSame }
                status = ok ? "pass" : "fail"
                if !ok { detail = "expected screen ‘\(value.isEmpty ? target : value)’, saw ‘\(detectTitle(readUITree(app)) ?? "?")’" }
            case "assert_exists":
                let ok = sessionWaitFor(target, timeoutMs: timeoutMs)
                status = ok ? "pass" : "fail"
                if !ok { detail = "‘\(target)’ not found" }
            case "assert_absent":
                waitForUIStability(timeout: 1.5)
                let present = elementPresent(target)
                status = present ? "fail" : "pass"
                if present { detail = "‘\(target)’ was present but should be absent" }
            case "assert_text":
                let of = subst((step["of"] as? String) ?? target)
                let needle = subst((step["contains"] as? String) ?? value)
                let ok = pollUntil(timeoutMs: timeoutMs) { elementTextContains(of, needle) }
                status = ok ? "pass" : "fail"
                if !ok { detail = "‘\(of)’ did not contain ‘\(needle)’" }
            case "assert_ai":
                aiIndex += 1
                let claim = value.isEmpty ? target : value
                let (aiStatus, aiDetail) = judgeWithAI(index: aiIndex, claim: claim)
                status = aiStatus; detail = aiDetail
            default:
                status = "fail"; detail = "unknown action ‘\(action)’"
            }

            // App-death is a hard failure for any step (real crash during the flow).
            if app.state != .runningForeground && action != "assert_absent" {
                status = "fail"; detail = "app left the foreground (crash?) during ‘\(action)’"
            }

            let isAssert = action.hasPrefix("assert_")
            print("OCQA_FLOW_STEP:{\"index\":\(idx),\"action\":\"\(escapeJSON(action))\",\"target\":\"\(escapeJSON(target.isEmpty ? value : target))\",\"assert\":\(isAssert),\"status\":\"\(status)\",\"detail\":\"\(escapeJSON(detail))\"}")
            if status == "fail" {
                failed += 1
                // A failed step surfaces as a finding, with the same shape QA findings use.
                let screen = detectTitle(readUITree(app)) ?? "Unknown"
                print("OCQA_ISSUE:{\"type\":\"flow_assertion_failed\",\"severity\":\"high\",\"title\":\"\(escapeJSON("Step \(idx) (\(action)) failed: \(detail)"))\",\"screen\":\"\(escapeJSON(screen))\",\"step\":\(idx)}")
                // Stop on the first failure by default — later steps assume earlier ones succeeded.
                if (flow["continueOnFailure"] as? Bool) != true { break }
            }
            waitForAnimationsToSettle()
        }

        let shot = app.screenshot()
        let att = XCTAttachment(screenshot: shot); att.name = "flow_final"; att.lifetime = .keepAlways; add(att)
        print("OCQA_FLOW_RESULT:{\"passed\":\(failed == 0),\"total\":\(steps.count),\"failed\":\(failed)}")
        if failed > 0 { XCTFail("Flow had \(failed) failed step(s)") }
    }

    /// Accepts both sugar (`{ tap: "Sign In" }`) and explicit (`{ action: "tap", target: "Sign In" }`).
    private func normalizeFlowStep(_ raw: [String: Any]) -> (String, [String: Any]) {
        if let action = raw["action"] as? String { return (action.lowercased(), raw) }
        // Sugar: the single key is the action; a string value is target, an object is the params.
        for (k, v) in raw {
            if let s = v as? String { return (k.lowercased(), ["target": s, "value": s]) }
            if let o = v as? [String: Any] {
                var params = o
                // map {field:} → target for type steps
                if let f = o["field"] as? String, params["target"] == nil { params["target"] = f }
                return (k.lowercased(), params)
            }
            return (k.lowercased(), [:])
        }
        return ("noop", [:])
    }

    private func pollUntil(timeoutMs: Int, _ cond: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        repeat { if cond() { return true }; Thread.sleep(forTimeInterval: 0.25) } while Date() < deadline
        return false
    }

    private func elementPresent(_ target: String) -> Bool {
        guard !target.isEmpty else { return false }
        let queries: [XCUIElementQuery] = [app.buttons, app.staticTexts, app.cells, app.links, app.switches, app.textFields, app.otherElements]
        for q in queries where q[target].exists { return true }
        return app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR label CONTAINS[c] %@", target, target)).firstMatch.exists
    }

    private func elementTextContains(_ of: String, _ needle: String) -> Bool {
        let lc = needle.lowercased()
        for el in readUITree(app) {
            let id = el.identifier.trimmingCharacters(in: .whitespaces)
            let label = el.label.trimmingCharacters(in: .whitespaces)
            if id == of || label == of || label.lowercased().contains(of.lowercased()) {
                if el.value.lowercased().contains(lc) || el.label.lowercased().contains(lc) { return true }
            }
        }
        return false
    }

    /// Routes an `assert_ai` claim to a host-side judge over a file channel (same pattern as vision
    /// escalation). No judge configured ⇒ skipped (not failed), so deterministic flows run anywhere.
    private func judgeWithAI(index: Int, claim: String) -> (String, String) {
        let responsePath = resolve("OCQA_FLOW_AI_RESPONSE_PATH")
        let imageDir = resolve("OCQA_FLOW_AI_IMAGE_DIR")
        guard !responsePath.isEmpty, !imageDir.isEmpty else { return ("skip", "no AI judge configured") }
        try? FileManager.default.createDirectory(atPath: imageDir, withIntermediateDirectories: true)
        let imagePath = (imageDir as NSString).appendingPathComponent("assert-\(index).png")
        guard (try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: imagePath))) != nil else { return ("skip", "screenshot failed") }
        try? FileManager.default.removeItem(atPath: responsePath)
        print("OCQA_FLOW_AI_QUERY:{\"index\":\(index),\"claim\":\"\(escapeJSON(claim))\",\"image\":\"\(escapeJSON(imagePath))\"}")
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.4)
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: responsePath)),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (obj["index"] as? Int) == index else { continue }
            let pass = (obj["pass"] as? Bool) ?? false
            return (pass ? "pass" : "fail", (obj["reason"] as? String) ?? "")
        }
        return ("skip", "AI judge timed out")
    }

    // MARK: - Full Autonomous Exploration

    func testAutonomousExploration() {
        let maxActions = self.maxActions
        let timeoutSeconds = Double(self.timeoutSeconds)
        var inputOverrides = (config["OCQA_INPUT_OVERRIDES"] as? [String: String]) ?? [:]

        // (Crash safety net registered in setUp — covers launch-phase and mid-run deaths.)

        var visitedStates = Set<String>()
        var stateTransitions: [(from: String, to: String, action: String)] = []
        var actionCounts: [String: Int] = [:]
        var stateActionCounts: [String: Int] = [:] // "stateHash|actionKey" -> count
        // "screenTitle|actionKey" of text fields we've typed into — SCREEN-scoped because anonymous
        // action keys (position buckets) collide across screens (login Password and signup Confirm
        // Password landed in the same bucket, wrongly marking the latter "filled"). Drives
        // form-completion steering's unfilled check; membership is permanent per run (termination).
        var typedFieldKeys = Set<String>()
        // Screens where the one-shot stuck-escape dismiss has already been tried.
        var stuckDismissTried = Set<String>()
        var actionCooldownUntilStep: [String: Int] = [:] // actionKey -> next allowed step
        var lastActionKey: String?
        var lastActionFromStateHash: String?
        var previousStateHash: String?
        var repeatedStateCount = 0
        var actionCount = 0
        var issues: [(type: String, severity: String, title: String, desc: String)] = []
        /// De-dupes high-impact findings (failed submits, dead controls) so each is reported once.
        var reportedIssueKeys = Set<String>()
        /// Per-screen scroll-to-discover state — reveals below-the-fold content so off-screen
        /// controls (and the issues on them) are actually reached.
        var screenScrollDepth: [String: Int] = [:]
        var screenScrolledToBottom = Set<String>()
        var screenTitles: [String: String] = [:] // hash -> title
        /// Tracks element keys that appear in multiple distinct screen hashes — likely persistent nav
        var elementScreenPresence: [String: Set<String>] = [:]
        var totalDistinctStates = 0
        var recentStateHashes: [String] = []
        var actionsSinceNewState = 0
        var sameScreenStreak = 0
        var screenTextEntryCount: [String: Int] = [:]
        /// Screen title -> count of submits that left us on the same screen (failed login/form)
        var failedSubmits: [String: Int] = [:]
        /// Set once any sign-in (a submit on a screen with a password field) navigates the user
        /// forward. Suppresses false "auth failed" / loop / unresponsive findings when the explorer
        /// later re-pokes the login form (e.g. after tapping Sign Out).
        var authSucceeded = false
        /// Per-screen-title visit count — drives "don't revisit explored screens" logic
        var screenVisitCount: [String: Int] = [:]
        /// Per-screen-title set of action keys already tried — never repeat an action on the same screen
        var screenActionsTried: [String: Set<String>] = [:]
        /// Remembered transitions: "fromTitle|actionKey" -> destination screen title
        var knownTransitions: [String: String] = [:]
        /// Affordance fingerprint of the destination reached by "fromTitle|actionKey" — the set of
        /// interactable-element labels on the destination screen. Used for template-sibling detection.
        var destFingerprint: [String: String] = [:]
        /// Per hub title: affordance fingerprint -> the distinct action keys that led to it. A hub
        /// with any fingerprint reached by >= 2 keys is a repeating template list (e.g. a list of
        /// structurally-identical detail screens), so its remaining siblings can be deferred.
        var hubKeysByFingerprint: [String: [String: Set<String>]] = [:]
        /// Set after performing an action; resolved on next iteration to populate knownTransitions
        var pendingTransitionFrom: (title: String, actionKey: String)? = nil
        /// Tracks which tab bar position (0-4) to try next for rotation
        var nextTabRotation = 0
        /// Count of distinct screen titles discovered so far
        var knownScreenTitles = Set<String>()
        /// Step at which we last forced a tab switch
        var lastTabSwitchStep = 0
        let startTime = Date()

        // ---- Interactive mid-run input ----
        // When the host enables it, the harness pauses on the first screen with input fields and
        // waits for the user to supply values (written to OCQA_INPUT_RESPONSE_PATH). Time spent
        // blocked here is tracked in `totalWaitSeconds` and excluded from the exploration timeout.
        var totalWaitSeconds = 0.0
        var promptedScreens = Set<String>()
        var dontAskAgain = false
        var interactiveInputEnabled = resolve("OCQA_INTERACTIVE_INPUT") == "1"
        let inputResponsePath = resolve("OCQA_INPUT_RESPONSE_PATH")
        let inputWaitTimeout = Double(resolve("OCQA_INPUT_WAIT_TIMEOUT", fallback: "30")) ?? 30

        // ---- In-loop vision escalation (opt-in, off by default) ----
        // When the a11y tree goes blank/stuck the structural explorer is out of moves. If the host
        // enabled it, screenshot the screen and ask the host's vision model for the single next tap
        // (normalized coords) or gesture — the model call stays HOST-side; the harness only requests
        // via OCQA_VISION_QUERY and executes the reply. Budgeted so cost/latency stay bounded.
        let visionEscalationEnabled = resolve("OCQA_VISION_ESCALATION") == "1"
        let visionResponsePath = resolve("OCQA_VISION_RESPONSE_PATH")
        let visionImageDir = resolve("OCQA_VISION_IMAGE_DIR")
        let visionEscalationBudget = Int(resolve("OCQA_VISION_BUDGET", fallback: "4")) ?? 4
        let visionWaitTimeout = Double(resolve("OCQA_VISION_WAIT_TIMEOUT", fallback: "60")) ?? 60
        var visionEscalationsUsed = 0

        if !targetBundleId.isEmpty {
            app.activate()
        } else {
            app.launch()
        }

        // Wait for app to settle before the first capture. Uses waitForUIStability (requires TWO
        // consecutive stable element-count reads, not one) — the same check testReplayFlow uses on
        // launch. A single-stable-read check can break mid-animation for a launch-time `.sheet`
        // (e.g. a "Get Started" welcome sheet over a TabView): the sheet's own nav bar isn't in the
        // tree yet, so the first capture reads the screen underneath instead of the sheet, and
        // grounding/replay disagree on the entry screen. Requiring two consecutive stable reads
        // reliably lands after the presentation animation finishes.
        _ = app.descendants(matching: .any).firstMatch.waitForExistence(timeout: 3)
        _ = waitForUIStability(timeout: 2.0)

        print("OCQA_STATE:exploration_started max_actions=\(maxActions)")

        let testEmail = resolve("OCQA_TEST_EMAIL")
        let testPassword = resolve("OCQA_TEST_PASSWORD")

        // --- Explicit login replay (config-driven): a recorded type/tap/wait sequence for custom
        // login UIs the heuristic preamble below can't parse. When configured it takes precedence. ---
        let ranExplicitLogin = executeLoginSteps(resolve("OCQA_LOGIN_STEPS"), email: testEmail, password: testPassword)

        // --- Login preamble: if credentials are provided and login fields are visible, log in first ---
        if !ranExplicitLogin, !testEmail.isEmpty, !testPassword.isEmpty {
            waitForUIStability(timeout: 2.0) // let app fully settle
            let allTextFields = app.textFields.allElementsBoundByIndex.filter { $0.exists && $0.frame.width > 0 }
            let allSecureFields = app.secureTextFields.allElementsBoundByIndex.filter { $0.exists && $0.frame.width > 0 }
            print("OCQA_STATE:login_preamble_fields textFields=\(allTextFields.count) secureFields=\(allSecureFields.count)")

            let emailField = allTextFields.first { f in
                let hint = (f.identifier + " " + (f.placeholderValue ?? "") + " " + f.label).lowercased()
                return hint.contains("email") || hint.contains("e-mail")
            } ?? (allSecureFields.count > 0 ? allTextFields.first : nil)

            let passwordField = allSecureFields.first
                ?? allTextFields.first { f in
                    let hint = (f.identifier + " " + (f.placeholderValue ?? "") + " " + f.label).lowercased()
                    return hint.contains("password") || hint.contains("passcode")
                }

            if let emailF = emailField, emailF.exists, let passF = passwordField, passF.exists {
                // ---- Pause-first at credential surfaces (attended runs must never get surprise
                // typing). When the host wired interactive input, ask BEFORE the preamble types:
                // the prompt shows the known email as its default; Submit overrides the values,
                // Skip skips login entirely, Use-defaults or a 30s timeout (unattended run)
                // proceeds with the configured credentials — the old silent behavior becomes the
                // fallback, not the default.
                var preambleEmail = testEmail
                var preamblePassword = testPassword
                var skipPreambleLogin = false
                if interactiveInputEnabled, !inputResponsePath.isEmpty {
                    let navTitle = app.navigationBars.firstMatch.exists ? app.navigationBars.firstMatch.identifier : ""
                    let promptScreen = navTitle.isEmpty ? "Sign In" : navTitle
                    let emailKey = emailF.identifier.isEmpty ? "email" : emailF.identifier
                    let passKey = passF.identifier.isEmpty ? "password" : passF.identifier
                    let descriptors = [
                        InputDescriptor(key: emailKey, label: "Email", secure: false, placeholder: emailF.placeholderValue ?? ""),
                        InputDescriptor(key: passKey, label: "Password", secure: true, placeholder: passF.placeholderValue ?? ""),
                    ]
                    promptedScreens.insert(normalizeKey(promptScreen)) // don't re-ask in the main loop
                    let action = awaitInteractiveInput(
                        requestId: UUID().uuidString,
                        screenTitle: promptScreen,
                        descriptors: descriptors,
                        responsePath: inputResponsePath,
                        waitTimeout: inputWaitTimeout,
                        overrides: &inputOverrides,
                        totalWaitSeconds: &totalWaitSeconds,
                        dontAskAgain: &dontAskAgain,
                        interactiveEnabled: &interactiveInputEnabled
                    )
                    if action == "skip" {
                        skipPreambleLogin = true
                        print("OCQA_STATE:login_preamble_skipped_by_user")
                    } else if action == "submit" {
                        let screenKey = normalizeKey(promptScreen)
                        if let v = inputOverrides["screen:\(screenKey)|\(emailKey)"] ?? inputOverrides[emailKey], !v.isEmpty {
                            preambleEmail = v
                        }
                        if let v = inputOverrides["screen:\(screenKey)|\(passKey)"] ?? inputOverrides[passKey], !v.isEmpty {
                            preamblePassword = v
                        }
                    } // "defaults" / "dont_ask" / "timeout" → proceed with the configured creds
                }

                if !skipPreambleLogin {
                print("OCQA_STATE:login_preamble_attempting")
                emailF.tap()
                Thread.sleep(forTimeInterval: 0.3)
                emailF.typeText(preambleEmail)
                Thread.sleep(forTimeInterval: 0.3)

                passF.tap()
                Thread.sleep(forTimeInterval: 0.3)
                passF.typeText(preamblePassword)
                Thread.sleep(forTimeInterval: 0.3)

                // Dismiss keyboard
                let keyboard = app.keyboards.firstMatch
                if keyboard.exists {
                    let aboveKeyboard = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
                    aboveKeyboard.tap()
                    Thread.sleep(forTimeInterval: 0.3)
                }

                // Find and tap login/sign-in button
                let loginLabels = ["Log In", "Login", "Sign In", "Sign in", "log in", "LOG IN", "SIGN IN"]
                var tappedLogin = false
                for label in loginLabels {
                    let btn = app.buttons[label]
                    if btn.exists && btn.isHittable {
                        btn.tap()
                        tappedLogin = true
                        break
                    }
                    let st = app.staticTexts[label]
                    if st.exists && st.isHittable {
                        st.tap()
                        tappedLogin = true
                        break
                    }
                }
                if tappedLogin {
                    print("OCQA_STATE:login_preamble_submitted")
                    Thread.sleep(forTimeInterval: 2.0)
                    waitForUIStability(timeout: 4.0)
                } else {
                    // Two-step auth: try entering email + tapping Continue, then handle password on next screen
                    let continueLabels = ["Continue", "Next", "Submit", "Proceed", "Get Started"]
                    var tappedContinue = false
                    for label in continueLabels {
                        let btn = app.buttons[label]
                        if btn.exists && btn.isHittable {
                            btn.tap()
                            tappedContinue = true
                            break
                        }
                    }
                    if tappedContinue {
                        print("OCQA_STATE:login_preamble_continue_tapped")
                        Thread.sleep(forTimeInterval: 1.5)
                        // Now look for password field on the next screen
                        let passFieldAfter = app.secureTextFields.firstMatch
                        if passFieldAfter.exists {
                            passFieldAfter.tap()
                            Thread.sleep(forTimeInterval: 0.3)
                            passFieldAfter.typeText(preamblePassword)
                            Thread.sleep(forTimeInterval: 0.3)
                            for label in loginLabels + continueLabels {
                                let btn = app.buttons[label]
                                if btn.exists && btn.isHittable {
                                    btn.tap()
                                    print("OCQA_STATE:login_preamble_two_step_submitted")
                                    Thread.sleep(forTimeInterval: 2.0)
                                    waitForUIStability(timeout: 4.0)
                                    break
                                }
                            }
                        }
                    } else {
                        print("OCQA_STATE:login_preamble_no_submit_button")
                    }
                }

                // OTP / verification code step — look for numeric code fields after login submission
                Thread.sleep(forTimeInterval: 0.5)
                let otpLabels = ["code", "otp", "verification", "passcode", "one-time", "pin"]
                let otpCandidate = app.textFields.allElementsBoundByIndex.first { f in
                    let hint = (f.identifier + " " + (f.placeholderValue ?? "") + " " + f.label).lowercased()
                    return otpLabels.contains { hint.contains($0) }
                }
                if let otpField = otpCandidate, otpField.exists, otpField.isHittable {
                    let testOTP = resolve("OCQA_TEST_OTP", fallback: "123456")
                    otpField.tap()
                    Thread.sleep(forTimeInterval: 0.3)
                    otpField.typeText(testOTP)
                    print("OCQA_STATE:otp_entered")
                    Thread.sleep(forTimeInterval: 0.3)
                    for label in ["Verify", "Continue", "Submit", "Confirm"] {
                        let btn = app.buttons[label]
                        if btn.exists && btn.isHittable { btn.tap(); break }
                    }
                    Thread.sleep(forTimeInterval: 2.0)
                }
                } // !skipPreambleLogin
            }
        }

        // Early-death guard: an app that dies at launch or during the login preamble must
        // surface as a CRITICAL crash finding — not as an XCTest "Failed to resolve query"
        // error with zero markers (which reports 0 findings and, against a baseline, would
        // sail through a regression gate). Found via corpus bug-seeding: a state-restoring
        // app that crashes in its restored screen dies here, before the loop's crash checks.
        if app.state != .runningForeground {
            _ = app.wait(for: .runningForeground, timeout: 5)
        }
        if app.state != .runningForeground {
            print("OCQA_ISSUE:{\"type\":\"crash\",\"severity\":\"critical\",\"title\":\"App crashed at launch/startup\",\"screen\":\"Launch\",\"step\":0}")
            didEmitComplete = true
            print("OCQA_COMPLETE:{\"actions\":0,\"states\":0,\"issues\":1,\"screens\":\"\",\"outcome\":\"crash_at_launch\"}")
            return
        }

        // Trigger the interruption monitor on any pending system alerts
        app.tap()
        Thread.sleep(forTimeInterval: 0.3)

        // Record the TRUE initial screen (e.g. a "Get Started" welcome sheet) before
        // navigateToRootScreen() below auto-dismisses it. Without this, grounding (AI-generate,
        // coverage) never sees the app's real launch screen or its dismiss control (e.g. "Continue")
        // — it only sees the post-dismiss root ("Dashboard") — while a fresh replay of a
        // Flow (no auto-dismiss there; see testReplayFlow) DOES see the undismissed sheet, so a
        // generated flow's first assertion mismatched. Emitting it here as a normal OCQA_STATE makes
        // it the grounding's startScreen with its real tap targets, same shape a recorded Flow sees.
        let initialElements = readUITree(app)
        let initialTitle = detectTitle(initialElements) ?? "Unknown"
        let initialInputs = detectInputDescriptors(in: initialElements)
        let initialInteractable = initialElements.filter { $0.isEnabled && isInteractable($0.type) }
        let initialRole = classifyScreenRole(title: initialTitle, elements: initialElements, inputs: initialInputs, interactable: initialInteractable)
        let initialSummary = describeScreen(title: initialTitle, role: initialRole, elements: initialElements, inputs: initialInputs, interactable: initialInteractable)
        let initialAtext = visionTextInventory(initialElements).map { "\"\(escapeJSON($0))\"" }.joined(separator: ",")
        print("OCQA_STATE:{\"screen\":\"\(escapeJSON(initialTitle))\",\"hash\":\"\(computeHash(initialElements))\",\"elements\":\(initialElements.count),\"action\":0,\"role\":\"\(escapeJSON(initialRole))\",\"summary\":\"\(escapeJSON(initialSummary))\",\"settled\":\(isScreenSettled() ? "true" : "false"),\"atext\":[\(initialAtext)],\"inputs\":[]}")

        navigateToRootScreen(actionCount: &actionCount)

        // ---- Directed (targeted) exploration ----
        // Beeline from the root to the requested screen as fast as possible by following the route
        // (control labels learned from prior runs), then fall into the normal loop to explore from
        // there. Tab rotation is disabled below in directed mode so we stay in the target's area.
        if !targetScreen.isEmpty {
            beelineToTarget(target: targetScreen, route: route, actionCount: &actionCount, maxActions: maxActions)
        }

        while actionCount < maxActions {
            // Subtract time spent paused for interactive input so human typing never eats the budget.
            if Date().timeIntervalSince(startTime) - totalWaitSeconds > timeoutSeconds {
                print("OCQA_STATE:timeout_reached")
                break
            }

            // ---- Tab rotation: move to a new tab only once the current tab has gone STALE ----
            // (≥ tabRotationInterval actions on this tab AND a short drought of new screens). This
            // lets the explorer fully exhaust a tab's screens — including nested NavigationLinks —
            // before wandering off, which improves real coverage and makes deep screens reliably
            // reachable. The previous fixed-interval rotation (plus an early warmup sweep) abandoned
            // rich screens before their links were visited.
            let tabRotationInterval = 6
            if targetScreen.isEmpty   // directed mode stays in the target's area — no tab rotation
                && actionCount > 0
                && (actionCount - lastTabSwitchStep) >= tabRotationInterval
                && actionsSinceNewState >= 3
                && nextTabRotation < 5 {
                let rotationElements = readUITree(app).filter { $0.isEnabled && $0.isHittable && isInteractable($0.type) }
                guard hasVisibleGlobalNavigation(rotationElements, screenBounds: screenBounds) else {
                    lastTabSwitchStep = actionCount
                    continue
                }
                // Skip position 0 (home tab) since we usually start there — try other tabs first
                let rotationOrder = [1, 2, 3, 4, 0]
                if nextTabRotation < rotationOrder.count {
                    let tabIdx = rotationOrder[nextTabRotation]
                    // First go back to root of current tab
                    for _ in 0..<5 {
                        if tryGoBack() {
                            Thread.sleep(forTimeInterval: 0.3)
                        } else {
                            break
                        }
                    }
                    tapTab(atRotationIndex: tabIdx)
                    nextTabRotation += 1
                    lastTabSwitchStep = actionCount
                    actionCount += 1
                    print("OCQA_ACTION:{\"type\":\"tab_rotation\",\"tab_index\":\(tabIdx),\"step\":\(actionCount),\"narrative\":\"\(escapeJSON(recoveryNarrative("tab_rotation", screen: "")))\"}")
                    Thread.sleep(forTimeInterval: 0.5)
                    emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                    continue
                }
            }

            var elements = readUITree(app)
            if elements.isEmpty {
                // App may have gone to background, crashed, or be unresponsive.
                print("OCQA_STATE:empty_tree_reactivating step=\(actionCount)")
                app.activate()
                Thread.sleep(forTimeInterval: 2.0)
                elements = readUITree(app)
                if elements.isEmpty {
                    print("OCQA_STATE:empty_tree_after_retry step=\(actionCount)")
                    // A dead app (didn't come back on reactivate) is a CRASH — often from an ASYNC
                    // failure a few hundred ms after the action (e.g. a background captcha fetch),
                    // so it surfaces here at the next tree read rather than at the early crash check.
                    // Report it against the action that led here instead of breaking silently. (Real:
                    // Wikipedia's WMFCaptchaViewController.refreshImage assertionFailure crashes the
                    // app during login — a genuine production crash AutoTap must surface.)
                    if app.state != .runningForeground {
                        let where_ = pendingTransitionFrom?.title ?? "the previous screen"
                        let crashKey = "crash-async:\(where_)"
                        if !reportedIssueKeys.contains(crashKey) {
                            reportedIssueKeys.insert(crashKey)
                            issues.append((type: "crash", severity: "critical", title: "App crashed during \(where_)",
                                           desc: "The app terminated and did not recover after the action on '\(where_)' — likely an unhandled error or assertion failure (possibly from an async task started by that action)."))
                            print("OCQA_ISSUE:{\"type\":\"crash\",\"severity\":\"critical\",\"title\":\"\(escapeJSON("App crashed during \(where_)"))\",\"screen\":\"\(escapeJSON(where_))\",\"step\":\(actionCount)}")
                        }
                    }
                    break
                }
            }
            let stateHash = computeHash(elements)
            let screenTitle = detectTitle(elements)
            let titleStr = screenTitle ?? "Unknown"

            // Resolve pending transition from previous action — now emit with real destination
            if let pending = pendingTransitionFrom {
                knownTransitions["\(pending.title)|\(pending.actionKey)"] = titleStr
                pendingTransitionFrom = nil
                if pending.title != titleStr {
                    // Real navigation: record the destination's affordance fingerprint under the hub
                    // it was reached from, so a hub that reaches >= 2 same-fingerprint screens can be
                    // detected as a repeating template list. Only destinations that have real content
                    // affordances participate — content-less screens (just text / a spinner) are never
                    // treated as a template, so they (and any finding in their text) are never skipped.
                    let (fp, contentCount) = affordanceFingerprint(elements)
                    if contentCount >= 1 {
                        destFingerprint["\(pending.title)|\(pending.actionKey)"] = fp
                        hubKeysByFingerprint[pending.title, default: [:]][fp, default: []].insert(pending.actionKey)
                    }

                    let escapedFrom = escapeJSON(pending.title)
                    let escapedTo   = escapeJSON(titleStr)
                    let escapedAct  = escapeJSON(pending.actionKey)
                    print("OCQA_TRANSITION_RESOLVED:{\"from\":\"\(escapedFrom)\",\"to\":\"\(escapedTo)\",\"action\":\"\(escapedAct)\"}")
                }
            }
            screenVisitCount[titleStr, default: 0] += 1
            knownScreenTitles.insert(titleStr)

            // If the last action returned us to the same state, cooldown that action key.
            if let lastActionKey, let lastFrom = lastActionFromStateHash, lastFrom == stateHash {
                let currentCooldown = actionCooldownUntilStep[lastActionKey] ?? 0
                actionCooldownUntilStep[lastActionKey] = max(currentCooldown, actionCount + 18)
            }

            if let title = screenTitle {
                screenTitles[stateHash] = title
            }

            // Track which elements appear on which screens (for persistent-nav detection)
            if !visitedStates.contains(stateHash) {
                totalDistinctStates += 1
                actionsSinceNewState = 0
                for el in elements where el.isEnabled && isInteractable(el.type) {
                    let key = actionKey(for: el)
                    elementScreenPresence[key, default: []].insert(stateHash)
                }
            } else {
                actionsSinceNewState += 1
            }

            recentStateHashes.append(stateHash)
            if recentStateHashes.count > 12 {
                recentStateHashes.removeFirst(recentStateHashes.count - 12)
            }

            if previousStateHash == stateHash {
                repeatedStateCount += 1
            } else {
                repeatedStateCount = 0
            }
            if let previousHash = previousStateHash,
               let previousTitle = screenTitles[previousHash],
               previousTitle == titleStr {
                sameScreenStreak += 1
            } else {
                sameScreenStreak = 0
            }
            previousStateHash = stateHash

            visitedStates.insert(stateHash)

            // Bail out only when we're genuinely making no progress — i.e. not discovering new
            // states. A stable, correct screen title alone is NOT stuck (a rich screen can have
            // many controls worth tapping), so the title-streak path also requires a new-state drought.
            if actionsSinceNewState >= 14 || (sameScreenStreak >= 10 && actionsSinceNewState >= 5) {
                let escaped = escapeJSON(titleStr)
                print("OCQA_STATE:stuck_same_screen screen=\(escaped) streak=\(sameScreenStreak) actions_without_new_state=\(actionsSinceNewState) step=\(actionCount)")
                // Deterministic escape first: a modal sheet (booking calendar, picker) traps the
                // explorer with value-selection controls that never yield a new state — a stuck
                // break here ends the WHOLE RUN (observed: died at 17/100 actions inside a real
                // app's authenticated area). Try dismissing the screen once before bailing.
                if !stuckDismissTried.contains(titleStr) {
                    stuckDismissTried.insert(titleStr)
                    if tryGoBack() {
                        actionCount += 1
                        print("OCQA_ACTION:{\"type\":\"back\",\"reason\":\"stuck_escape\",\"step\":\(actionCount),\"screen\":\"\(escaped)\",\"narrative\":\"\(escapeJSON("Dismissing the \(titleStr) screen — nothing here leads anywhere new."))\"}")
                        actionsSinceNewState = 0
                        sameScreenStreak = 0
                        emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                        continue
                    }
                }
                // Last resort before bailing: ask vision for one directed move (if enabled + budget).
                // A win resets the drought counter and keeps exploration alive on a screen the
                // structural heuristics have exhausted.
                if visionEscalationEnabled, visionEscalationsUsed < visionEscalationBudget,
                   !visionResponsePath.isEmpty,
                   visionEscalate(app: app, screenTitle: titleStr, reason: "stuck_same_screen",
                                  actionCount: &actionCount, usedCount: &visionEscalationsUsed,
                                  responsePath: visionResponsePath, imageDir: visionImageDir,
                                  waitTimeout: visionWaitTimeout) {
                    actionsSinceNewState = 0
                    sameScreenStreak = 0
                    emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                    continue
                }
                break
            }

            let detectedInputs = detectInputDescriptors(in: elements)
            let inputJsonArray = detectedInputs.map { descriptor in
                "{\"key\":\"\(escapeJSON(descriptor.key))\",\"label\":\"\(escapeJSON(descriptor.label))\",\"secure\":\(descriptor.secure ? "true" : "false"),\"placeholder\":\"\(escapeJSON(descriptor.placeholder))\"}"
            }.joined(separator: ",")
            let interactableForSummary = elements.filter { $0.isEnabled && isInteractable($0.type) }
            let screenRole = classifyScreenRole(title: titleStr, elements: elements, inputs: detectedInputs, interactable: interactableForSummary)
            let screenSummary = describeScreen(title: titleStr, role: screenRole, elements: elements, inputs: detectedInputs, interactable: interactableForSummary)

            // Emit screen state. `settled` marks a resting screenshot (no keyboard/menu/sheet up) so
            // the post-run vision pass can prefer un-ambiguous captures (see isScreenSettled). `atext`
            // is the fuller a11y text inventory that grounds the vision reviewer (see visionTextInventory).
            let escapedTitle = escapeJSON(titleStr)
            let settled = isScreenSettled()
            let atextJson = visionTextInventory(elements).map { "\"\(escapeJSON($0))\"" }.joined(separator: ",")
            print("OCQA_STATE:{\"screen\":\"\(escapedTitle)\",\"hash\":\"\(stateHash)\",\"elements\":\(elements.count),\"action\":\(actionCount),\"role\":\"\(escapeJSON(screenRole))\",\"summary\":\"\(escapeJSON(screenSummary))\",\"settled\":\(settled ? "true" : "false"),\"atext\":[\(atextJson)],\"inputs\":[\(inputJsonArray)]}")

            // ---- Interactive input: pause ONLY on credential/login forms, where a real value
            // genuinely matters and a default would be wrong. Optional in-app fields (search,
            // "special instructions", notes, etc.) get a smart default during normal action
            // selection and exploration keeps moving — autonomous runs must never freeze waiting for
            // input that an unattended user can't provide. (This is what caused multi-minute stalls
            // on detail screens like RestaurantDemo's item pages.)
            let promptKey = normalizeKey(titleStr)
            let needsRealInput = detectedInputs.contains { $0.secure } || screenRole == "login" || screenRole == "signup"
            if interactiveInputEnabled, !dontAskAgain, !inputResponsePath.isEmpty,
               needsRealInput, !promptedScreens.contains(promptKey),
               detectedInputs.contains(where: { hasNoOverride(key: $0.key, screen: titleStr, in: inputOverrides) }) {
                promptedScreens.insert(promptKey) // mark before waiting so we never double-ask
                awaitInteractiveInput(
                    requestId: UUID().uuidString,
                    screenTitle: titleStr,
                    descriptors: detectedInputs,
                    responsePath: inputResponsePath,
                    waitTimeout: inputWaitTimeout,
                    overrides: &inputOverrides,
                    totalWaitSeconds: &totalWaitSeconds,
                    dontAskAgain: &dontAskAgain,
                    interactiveEnabled: &interactiveInputEnabled
                )
            }

            // Screenshot
            let screenshot = app.screenshot()
            let attachment = XCTAttachment(screenshot: screenshot)
            attachment.name = "state_\(actionCount)_\(titleStr.replacingOccurrences(of: " ", with: "_"))"
            attachment.lifetime = .keepAlways
            add(attachment)

            // ---- Error / failure surface detection ----
            // A visible error/failure message is a high-impact signal that something broke.
            if let errorText = detectErrorSurface(elements) {
                let short = String(errorText.prefix(60))
                let errKey = "error:\(titleStr)|\(short.lowercased())"
                if !reportedIssueKeys.contains(errKey) {
                    reportedIssueKeys.insert(errKey)
                    let issueTitle = "Error message shown: \(short)"
                    issues.append((type: "error_surface", severity: "high", title: issueTitle, desc: "A failure/error message is visible on '\(titleStr)': \(short)"))
                    print("OCQA_ISSUE:{\"type\":\"error_surface\",\"severity\":\"high\",\"title\":\"\(escapeJSON(issueTitle))\",\"screen\":\"\(escapedTitle)\",\"step\":\(actionCount)}")
                }
            }

            // ---- Stuck-loading / hang detection ----
            // A loading indicator that never resolves is a hang or a silently-failed load. Poll
            // briefly; DemoApp's 1.2s dashboard spinner resolves and is not flagged.
            // Only when the spinner IS the screen: a loading indicator alongside substantial
            // content is an infinite-scroll/pagination loader, not a hang (observed FP on a
            // content-feed app: post detail + replies-loading spinner flagged app_hang HIGH).
            let visibleTextCount = elements.filter { isStaticTextType($0.type) && normalizeVisibleText($0.label).count >= 3 }.count
            if screenVisitCount[titleStr] ?? 0 <= 1, visibleTextCount <= 4,
               app.activityIndicators.firstMatch.exists || app.progressIndicators.firstMatch.exists {
                let loadingKey = "loading:\(titleStr)"
                if !reportedIssueKeys.contains(loadingKey) {
                    var resolved = false
                    let deadline = Date().addingTimeInterval(8.0)
                    while Date() < deadline {
                        Thread.sleep(forTimeInterval: 1.0)
                        if !(app.activityIndicators.firstMatch.exists || app.progressIndicators.firstMatch.exists) {
                            resolved = true
                            break
                        }
                    }
                    if !resolved {
                        reportedIssueKeys.insert(loadingKey)
                        let issueTitle = "Screen stuck loading: \(titleStr)"
                        issues.append((type: "app_hang", severity: "high", title: issueTitle, desc: "A loading indicator on '\(titleStr)' did not resolve after 8s — likely a hang or a silently failed load."))
                        print("OCQA_ISSUE:{\"type\":\"app_hang\",\"severity\":\"high\",\"title\":\"\(escapeJSON(issueTitle))\",\"screen\":\"\(escapedTitle)\",\"step\":\(actionCount)}")
                    }
                }
            }

            // ---- Carousel handling ----
            // A page indicator means the screen advances by SWIPING, not tapping. The only tappable
            // control is often a Back button, so the explorer would otherwise leave after page one.
            // Swipe through the pages (bounded) so every page is observed, then fall through to
            // normal exploration once content stops changing.
            if app.pageIndicators.firstMatch.exists {
                let swipeKey = "carousel:\(titleStr)"
                let swipesDone = actionCounts[swipeKey] ?? 0
                if swipesDone < 6 {
                    swipeScreenLeft()
                    actionCounts[swipeKey, default: 0] += 1
                    actionCount += 1
                    Thread.sleep(forTimeInterval: 0.5)
                    let afterElements = readUITree(app)
                    let changed = !afterElements.isEmpty && computeHash(afterElements) != stateHash
                    let carouselName = titleStr.isEmpty || titleStr == "Unknown" ? "the carousel" : "the \(titleStr) carousel"
                    print("OCQA_ACTION:{\"type\":\"swipe\",\"direction\":\"left\",\"reason\":\"carousel_page\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON("Swiping through \(carouselName) to the next page."))\"}")
                    if !changed { actionCounts[swipeKey] = 999 } // reached the last page
                    emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                    continue
                }
            }

            // Exclude on-screen keyboard keys from the candidate pool — we never want to "explore"
            // by pressing individual keys (that's how we ended up tapping "shift").
            let kbFrame = keyboardFrame()
            let interactable = elements.filter {
                $0.isEnabled && $0.isHittable && isInteractable($0.type) && !isExternalLink($0)
                    && !(kbFrame.height > 0 && $0.frame.midY >= kbFrame.minY && !isTextField($0.type))
            }
            let globalNavElements = interactable.filter { isLikelyGlobalNavigation($0, screenBounds: screenBounds) }
            let nonGlobalCandidates = interactable.filter { !isLikelyGlobalNavigation($0, screenBounds: screenBounds) }
            let candidatePool = nonGlobalCandidates.isEmpty ? interactable : nonGlobalCandidates

            // If keyboard occludes a likely submit action (Continue / Sign Up / Next), dismiss it first.
            if shouldDismissKeyboardForSubmit(elements: elements) {
                dismissKeyboardIfNeeded()
                actionCount += 1
                print("OCQA_ACTION:{\"type\":\"keyboard_dismiss\",\"reason\":\"reveal_submit\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON(recoveryNarrative("keyboard_dismiss", screen: titleStr)))\"}")
                Thread.sleep(forTimeInterval: 0.3)
                emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                continue
            }

            // ---- Blank-screen detection ----
            // Distinguish between "no a11y labels / custom UI" vs genuinely empty.
            if elements.count < 5 && interactable.count == 0 {
                let blankKey = "blank:\(titleStr)"
                let blankCount = (actionCounts[blankKey] ?? 0) + 1
                actionCounts[blankKey] = blankCount
                if blankCount == 1 {
                    issues.append((type: "blank_screen", severity: "medium", title: "Blank or inaccessible screen: \(titleStr)", desc: "Screen has \(elements.count) elements, none interactable"))
                    print("OCQA_ISSUE:{\"type\":\"blank_screen\",\"severity\":\"medium\",\"title\":\"Blank or inaccessible screen\",\"screen\":\"\(escapedTitle)\",\"element_count\":\(elements.count),\"step\":\(actionCount)}")
                }
                // Before giving up on a blank/inaccessible screen, escalate to vision (if enabled) —
                // the a11y tree is empty but a real user could still see and tap something. A single
                // vision-directed action can unstick a custom-drawn/canvas UI the structural pass is
                // blind to. Bounded by budget; on any non-action reply we fall through to conclude.
                if visionEscalationEnabled, visionEscalationsUsed < visionEscalationBudget,
                   !visionResponsePath.isEmpty, blankCount >= 2 {
                    if visionEscalate(app: app, screenTitle: titleStr, reason: "blank_surface",
                                      actionCount: &actionCount, usedCount: &visionEscalationsUsed,
                                      responsePath: visionResponsePath, imageDir: visionImageDir,
                                      waitTimeout: visionWaitTimeout) {
                        emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                        continue
                    }
                }
                // If consistently blank for 3+ consecutive reads on same screen, treat as limited-surface
                if blankCount >= 3 && sameScreenStreak >= 2 {
                    print("OCQA_ISSUE:{\"type\":\"limited_surface\",\"severity\":\"high\",\"title\":\"Limited interaction surface\",\"screen\":\"\(escapedTitle)\",\"desc\":\"App surface not accessible via standard accessibility APIs\",\"step\":\(actionCount)}")
                    didEmitComplete = true
                    print("OCQA_COMPLETE:{\"actions\":\(actionCount),\"states\":\(visitedStates.count),\"issues\":\(issues.count + 1),\"screens\":\"\",\"outcome\":\"limited_surface\"}")
                    return
                }
            }

            // ---- Navigation-loop detection ----
            // Check if recentStateHashes has a repeating cycle of length 2 or 3
            if recentStateHashes.count >= 6 {
                let recent = recentStateHashes
                let hasLoop2 = recent.count >= 4 &&
                    recent[recent.count - 1] == recent[recent.count - 3] &&
                    recent[recent.count - 2] == recent[recent.count - 4]
                let hasLoop3 = recent.count >= 6 &&
                    recent[recent.count - 1] == recent[recent.count - 4] &&
                    recent[recent.count - 2] == recent[recent.count - 5] &&
                    recent[recent.count - 3] == recent[recent.count - 6]
                if (hasLoop2 || hasLoop3) && !(authSucceeded && detectedInputs.contains { $0.secure }) {
                    let loopKey = "nav_loop:\(titleStr)"
                    if actionCounts[loopKey] == nil {
                        let period = hasLoop2 ? 2 : 3
                        issues.append((type: "navigation_loop", severity: "low", title: "Navigation loop detected (period \(period))", desc: "Exploration is cycling between the same \(period) screens"))
                        print("OCQA_ISSUE:{\"type\":\"navigation_loop\",\"severity\":\"low\",\"title\":\"Navigation loop\",\"screen\":\"\(escapedTitle)\",\"period\":\(period),\"step\":\(actionCount)}")
                        actionCounts[loopKey] = 1
                    }
                }
            }

            // ---- Unresponsive-element detection ----
            // Skip when we're merely re-poking a login screen we've already passed (Sign Out → re-login
            // churn) — that's an exploration artifact, not a frozen/broken screen.
            if repeatedStateCount >= 5 && !(authSucceeded && detectedInputs.contains { $0.secure }) {
                let unrespKey = "unresponsive:\(titleStr)"
                if actionCounts[unrespKey] == nil {
                    issues.append((type: "unresponsive_element", severity: "medium", title: "Unresponsive UI on \(titleStr)", desc: "Actions are not changing app state — possible frozen or broken screen"))
                    print("OCQA_ISSUE:{\"type\":\"unresponsive_element\",\"severity\":\"medium\",\"title\":\"Unresponsive UI\",\"screen\":\"\(escapedTitle)\",\"repeated_state_count\":\(repeatedStateCount),\"step\":\(actionCount)}")
                    actionCounts[unrespKey] = 1
                }
            }

            if interactable.count < 3 {
                print("OCQA_STATE:low_interactable screen=\(escapedTitle) total=\(elements.count) interactable=\(interactable.count) global=\(globalNavElements.count) nonGlobal=\(nonGlobalCandidates.count)")
            }

            // ---- Dead end ----
            if candidatePool.isEmpty {
                let deadEndKey = "deadEnd:\(titleStr)"
                let deadEndCount = actionCounts[deadEndKey] ?? 0
                actionCounts[deadEndKey, default: 0] += 1

                // If we've been stuck on this dead-end screen 3+ times, use blind tab escape
                if deadEndCount >= 3 {
                    let tabBarY = screenBounds.height > 0 ? screenBounds.height - 30 : 820.0
                    let screenW = screenBounds.width > 0 ? screenBounds.width : 402.0
                    let tabPositions: [CGFloat] = [0.12, 0.31, 0.5, 0.69, 0.88]
                    let tabTryKey = "deadEndTab:\(titleStr)"
                    let tabIndex = actionCounts[tabTryKey] ?? 0
                    if tabIndex < tabPositions.count {
                        let xPos = screenW * tabPositions[tabIndex]
                        let coord = app.coordinate(withNormalizedOffset: .zero)
                            .withOffset(CGVector(dx: xPos, dy: tabBarY))
                        coord.tap()
                        actionCounts[tabTryKey, default: 0] += 1
                        actionCount += 1
                        print("OCQA_ACTION:{\"type\":\"tap\",\"target\":\"tab_bar_pos_\(tabIndex)\",\"reason\":\"dead_end_tab_escape\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON(recoveryNarrative("dead_end_tab_escape", screen: titleStr)))\"}")
                        Thread.sleep(forTimeInterval: 0.5)
                        continue
                    }
                    // All tab positions tried — truly stuck
                    print("OCQA_STATE:truly_stuck_dead_end screen=\(escapedTitle) step=\(actionCount)")
                    emitNavigationTrap(titleStr: titleStr, escapedTitle: escapedTitle, step: actionCount, reported: &reportedIssueKeys, issues: &issues)
                    break
                }

                let issueTitle = "Dead end: \(titleStr)"
                issues.append((type: "dead_end", severity: "medium", title: issueTitle, desc: "No interactable elements found"))
                print("OCQA_ISSUE:{\"type\":\"dead_end\",\"severity\":\"medium\",\"title\":\"\(escapedTitle)\",\"screen\":\"\(escapedTitle)\",\"step\":\(actionCount)}")

                // tryGoBack does swipe-down as its last resort (sheet dismiss)
                let preBackTitle = titleStr
                let backWorked = tryGoBack()
                actionCount += 1
                Thread.sleep(forTimeInterval: 0.3)
                let postElements = readUITree(app)
                let postTitle = detectTitle(postElements) ?? "Unknown"
                if (backWorked || postTitle != preBackTitle) && postTitle != preBackTitle {
                    print("OCQA_ACTION:{\"type\":\"back\",\"reason\":\"dead_end_escape\",\"from\":\"\(escapedTitle)\",\"to\":\"\(escapeJSON(postTitle))\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON(recoveryNarrative("back_dead_end", screen: titleStr, to: postTitle)))\"}")
                    continue
                }
                // Swipe right (back gesture) as another option
                let swipeStart = app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5))
                let swipeEnd = app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
                swipeStart.press(forDuration: 0.05, thenDragTo: swipeEnd)
                actionCount += 1
                Thread.sleep(forTimeInterval: 0.5)
                let postSwipeElements = readUITree(app)
                let postSwipeTitle = detectTitle(postSwipeElements) ?? "Unknown"
                if postSwipeTitle != preBackTitle {
                    print("OCQA_ACTION:{\"type\":\"swipe_back\",\"reason\":\"dead_end_escape\",\"to\":\"\(escapeJSON(postSwipeTitle))\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON(recoveryNarrative("swipe_back", screen: titleStr, to: postSwipeTitle)))\"}")
                    continue
                }
                continue
            }

            // ---- Screen-title-aware DFS action selection ----
            // Only consider actions not yet tried on this screen title
            let triedHere = screenActionsTried[titleStr] ?? []
            let freshCandidates = candidatePool.filter { !triedHere.contains(actionKey(for: $0)) }

            // Prioritize actions leading to UNDISCOVERED screens, then others
            let newScreenCandidates = freshCandidates.filter { el in
                let key = actionKey(for: el)
                if let destTitle = knownTransitions["\(titleStr)|\(key)"] {
                    // Known destination — only try if we haven't visited it many times
                    return (screenVisitCount[destTitle] ?? 0) < 12
                }
                // Unknown destination — always try first!
                return true
            }
            
            var activeCandidates = newScreenCandidates.isEmpty ? freshCandidates : newScreenCandidates

            // ---- Template-sibling deferral (affordance fingerprint) ----
            // If this hub reached >= 2 destinations with the SAME affordance fingerprint (the set of
            // interactable-element labels — *what you can do* on a screen), it's a repeating template
            // list, e.g. a list of structurally-identical detail screens. Defer its same-template
            // links — proven-redundant ones and unvisited siblings predicted to match — so the budget
            // goes to novel screens first. This only REORDERS: ways to leave are never deferred, and
            // deferred links stay in the pool (visited if nothing novel remains), so per-screen issue
            // detection still runs on every screen actually visited — no finding is suppressed.
            // (Affordance, not structural: validated that this collapses identical siblings while
            // keeping screens whose actions differ — e.g. an error screen's "Retry" — distinct.)
            //
            // Scoped to DIRECTED exploration (a beeline-to-a-screen run, where tab-rotation is off and
            // the goal is to thoroughly cover one area): there, skipping redundant siblings reaches
            // more of the target area. In broad autonomous mode it's left off — A/B testing showed the
            // freed budget there just re-treads already-explored tabs rather than reaching novel
            // screens, so it only lowered the distinct-screen count without benefit.
            let hubTemplateFps = targetScreen.isEmpty
                ? Set<String>()
                : Set((hubKeysByFingerprint[titleStr] ?? [:]).filter { $0.value.count >= 2 }.keys)
            if !hubTemplateFps.isEmpty {
                let novelCandidates = activeCandidates.filter { el in
                    if isNavBackButton(el) || isLikelyGlobalNavigation(el, screenBounds: screenBounds) { return true }
                    let key = actionKey(for: el)
                    if let fp = destFingerprint["\(titleStr)|\(key)"] {
                        return !hubTemplateFps.contains(fp)   // proven same-template destination — defer
                    }
                    return false   // unvisited sibling on a confirmed template hub — predict redundant, defer
                }
                if !novelCandidates.isEmpty { activeCandidates = novelCandidates }
            }

            // Allow one text entry per distinct field on the screen so multi-field forms
            // (e.g. Create Account with 4 fields) get every field filled — not just the first
            // two. Capped at 8 to avoid runaway re-entry on pathological screens. The
            // prefer-pending-fields logic below keeps us moving to empty fields each time.
            let textFieldCap = max(2, min(detectedInputs.count, 8))
            let textEntriesHere = screenTextEntryCount[titleStr, default: 0]
            if textEntriesHere >= textFieldCap {
                activeCandidates = activeCandidates.filter { !isTextField($0.type) }
            }

            // Prefer text fields that still need input before revisiting already-filled fields.
            let pendingTextFields = activeCandidates.filter { isTextField($0.type) && elementNeedsInput($0, in: app) }
            if !pendingTextFields.isEmpty {
                activeCandidates = pendingTextFields
            } else if detectedInputs.count >= 2 {
                // Form likely complete on this screen: prioritize submit/continue controls next.
                let submitCandidates = activeCandidates.filter { isLikelySubmitControl($0) }
                if !submitCandidates.isEmpty {
                    activeCandidates = submitCandidates
                }
            }

            if (screenVisitCount[titleStr] ?? 0) >= 2 {
                let exploratoryCandidates = activeCandidates.filter { isLikelyExploratoryNavigation($0) }
                if !exploratoryCandidates.isEmpty {
                    activeCandidates = exploratoryCandidates
                } else {
                    let namedCandidates = activeCandidates.filter { !isAnonymousControl($0) }
                    if !namedCandidates.isEmpty {
                        activeCandidates = namedCandidates
                    }
                }
            }

            if (screenVisitCount[titleStr] ?? 0) >= 3 {
                let dismissCandidates = activeCandidates.filter { isLikelyDismissControl($0) }
                if !dismissCandidates.isEmpty {
                    activeCandidates = dismissCandidates
                }
            }

            // If a form on this screen already failed to submit (e.g. bad login), stop
            // re-typing into its fields and re-submitting. Prefer anything that navigates
            // away — links like "Sign Up"/"Forgot password", or other tabs.
            if (failedSubmits[titleStr] ?? 0) >= 1 {
                let escapeCandidates = activeCandidates.filter { !isTextField($0.type) && !isLikelySubmitControl($0) }
                if !escapeCandidates.isEmpty {
                    activeCandidates = escapeCandidates
                }
            }

            // Prefer real CONTENT over ways to LEAVE the screen (back / global nav). On a scrollable
            // screen whose only remaining options are to leave, first scroll to reveal below-the-fold
            // content — so off-screen controls (and the issues on them) are actually reached, instead
            // of bailing out the moment the visible content is exhausted.
            let contentCandidates = activeCandidates.filter {
                !isNavBackButton($0) && !isLikelyGlobalNavigation($0, screenBounds: screenBounds)
            }
            if contentCandidates.isEmpty, !activeCandidates.isEmpty,
               isScrollableScreen(), !screenScrolledToBottom.contains(titleStr),
               (screenScrollDepth[titleStr] ?? 0) < 8 {
                let beforeSig = contentSignature(elements)
                performScroll(in: app, upward: true) // swipe up = reveal content further down
                screenScrollDepth[titleStr, default: 0] += 1
                actionCount += 1
                Thread.sleep(forTimeInterval: 0.5)
                let afterEls = readUITree(app)
                if afterEls.isEmpty || contentSignature(afterEls) == beforeSig {
                    screenScrolledToBottom.insert(titleStr) // nothing new revealed — reached bottom
                }
                print("OCQA_ACTION:{\"type\":\"scroll\",\"direction\":\"down\",\"reason\":\"discover_below_fold\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON(recoveryNarrative("scroll_reveal", screen: titleStr)))\"}")
                emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                continue
            }
            if !contentCandidates.isEmpty {
                activeCandidates = contentCandidates
            }

            // No untried actions on this screen — escape
            if activeCandidates.isEmpty {
                // Try scrolling to reveal hidden content (once per direction per screen)
                if !triedHere.contains("scroll:up") {
                    performScroll(in: app, upward: true)
                    screenActionsTried[titleStr, default: []].insert("scroll:up")
                    actionCount += 1
                    print("OCQA_ACTION:{\"type\":\"scroll\",\"direction\":\"up\",\"reason\":\"screen_exhausted\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON(recoveryNarrative("scroll_reveal", screen: titleStr)))\"}")
                    Thread.sleep(forTimeInterval: 0.5)
                    emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                    continue
                }
                if !triedHere.contains("scroll:down") {
                    performScroll(in: app, upward: false)
                    screenActionsTried[titleStr, default: []].insert("scroll:down")
                    actionCount += 1
                    print("OCQA_ACTION:{\"type\":\"scroll\",\"direction\":\"down\",\"reason\":\"screen_exhausted\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON(recoveryNarrative("scroll_back", screen: titleStr)))\"}")
                    Thread.sleep(forTimeInterval: 0.5)
                    emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                    continue
                }
                // Try tapping unexplored areas before giving up
                if !triedHere.contains("tap:center") {
                    let center = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
                    center.tap()
                    screenActionsTried[titleStr, default: []].insert("tap:center")
                    actionCount += 1
                    print("OCQA_ACTION:{\"type\":\"tap\",\"target\":\"center_unexplored\",\"reason\":\"screen_exhausted\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON(recoveryNarrative("center_probe", screen: titleStr)))\"}")
                    Thread.sleep(forTimeInterval: 0.5)
                    emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                    continue
                }
                // Try swipe-left (carousel/onboarding advance) before giving up
                if !triedHere.contains("swipe:left") {
                    let midY = screenBounds.height / 2
                    let swipeStart = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: screenBounds.width * 0.8, dy: midY))
                    let swipeEnd = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: screenBounds.width * 0.2, dy: midY))
                    swipeStart.press(forDuration: 0.05, thenDragTo: swipeEnd)
                    screenActionsTried[titleStr, default: []].insert("swipe:left")
                    actionCount += 1
                    print("OCQA_ACTION:{\"type\":\"swipe\",\"direction\":\"left\",\"reason\":\"carousel_probe\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON(recoveryNarrative("carousel_probe", screen: titleStr)))\"}")
                    Thread.sleep(forTimeInterval: 0.5)
                    emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                    continue
                }
                // Try edge-swipe from left (drawer reveal) before giving up
                if !triedHere.contains("edge_swipe:left") {
                    let desc = performEdgeSwipeLeft(in: app)
                    screenActionsTried[titleStr, default: []].insert("edge_swipe:left")
                    actionCount += 1
                    print("OCQA_ACTION:{\"type\":\"\(desc)\",\"reason\":\"drawer_probe\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON(recoveryNarrative("drawer_probe", screen: titleStr)))\"}")
                    Thread.sleep(forTimeInterval: 0.6)
                    let postEdgeElements = readUITree(app)
                    let postEdgeTitle = detectTitle(postEdgeElements) ?? titleStr
                    if postEdgeTitle != titleStr {
                        emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                        continue
                    }
                    emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                    continue
                }
                // Scrolling done — try to go back and verify the screen actually changed
                let preBackTitle = titleStr
                let backResult = tryGoBack()
                actionCount += 1
                Thread.sleep(forTimeInterval: 0.3)
                let postBackElements = readUITree(app)
                let postBackTitle = detectTitle(postBackElements) ?? "Unknown"
                if postBackTitle != preBackTitle {
                    print("OCQA_ACTION:{\"type\":\"back\",\"reason\":\"screen_exhausted\",\"screen\":\"\(escapedTitle)\",\"to\":\"\(escapeJSON(postBackTitle))\",\"step\":\(actionCount),\"narrative\":\"\(escapeJSON(recoveryNarrative("back_exhausted", screen: titleStr, to: postBackTitle)))\"}")
                    emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                    continue
                }
                if backResult {
                    // Back button worked but screen title didn't change (same-titled parent)
                    print("OCQA_ACTION:{\"type\":\"back\",\"reason\":\"screen_exhausted_same_title\",\"screen\":\"\(escapedTitle)\",\"step\":\(actionCount),\"narrative\":\"\(escapeJSON(recoveryNarrative("back_same_title", screen: titleStr)))\"}")
                    emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                    continue
                }
                // Back didn't change screens — fall through to global nav
                print("OCQA_ACTION:{\"type\":\"back\",\"reason\":\"screen_exhausted_failed\",\"screen\":\"\(escapedTitle)\",\"step\":\(actionCount),\"narrative\":\"\(escapeJSON(recoveryNarrative("back_failed", screen: titleStr)))\"}")
                // Stuck on this screen — use global navigation (tab bar) to reach unexplored areas
                let globalNav = interactable
                    .filter { isLikelyGlobalNavigation($0, screenBounds: screenBounds) }
                    .filter { el in
                        let key = actionKey(for: el)
                        // Allow retrying global nav if it leads to undiscovered screens
                        if let dest = knownTransitions["\(titleStr)|\(key)"] {
                            // Only skip if we've explored it many times (9+)
                            return (screenVisitCount[dest] ?? 0) < 9
                        }
                        return true
                    }
                if !globalNav.isEmpty {
                    activeCandidates = globalNav
                } else {
                    // No visible global nav — try coordinate-tapping the tab bar area
                    // Tab bars are typically at the very bottom of the screen
                    let tabBarY = screenBounds.height > 0 ? screenBounds.height - 30 : 820.0
                    let screenW = screenBounds.width > 0 ? screenBounds.width : 402.0
                    let tabPositions: [CGFloat] = [0.12, 0.31, 0.5, 0.69, 0.88]
                    let tabTryKey = "tabTry:\(titleStr)"
                    let tabIndex = actionCounts[tabTryKey] ?? 0
                    if tabIndex < tabPositions.count {
                        let xPos = screenW * tabPositions[tabIndex]
                        let coord = app.coordinate(withNormalizedOffset: .zero)
                            .withOffset(CGVector(dx: xPos, dy: tabBarY))
                        coord.tap()
                        actionCounts[tabTryKey, default: 0] += 1
                        actionCount += 1
                        print("OCQA_ACTION:{\"type\":\"tap\",\"target\":\"tab_bar_pos_\(tabIndex)\",\"reason\":\"blind_tab_escape\",\"x\":\(Int(xPos)),\"y\":\(Int(tabBarY)),\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON(recoveryNarrative("blind_tab_escape", screen: titleStr)))\"}")
                        Thread.sleep(forTimeInterval: 0.5)
                        emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                        continue
                    }
                    // All tab positions tried — try swipe-to-dismiss (sheet/modal)
                    let swipeStart = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
                    let swipeEnd = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
                    swipeStart.press(forDuration: 0.1, thenDragTo: swipeEnd)
                    actionCount += 1
                    print("OCQA_ACTION:{\"type\":\"swipe_dismiss\",\"reason\":\"escape_stuck\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON(recoveryNarrative("swipe_dismiss", screen: titleStr)))\"}")
                    Thread.sleep(forTimeInterval: 0.5)
                    // Check if screen changed
                    let postSwipeElements = readUITree(app)
                    let postSwipeTitle = detectTitle(postSwipeElements) ?? "Unknown"
                    if postSwipeTitle != titleStr {
                        emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                        continue
                    }
                    // Truly stuck — break
                    print("OCQA_STATE:truly_stuck screen=\(escapedTitle) step=\(actionCount)")
                    emitNavigationTrap(titleStr: titleStr, escapedTitle: escapedTitle, step: actionCount, reported: &reportedIssueKeys, issues: &issues)
                    break
                }
            }

            // Sort and select best candidate
            let persistentThreshold = max(2, totalDistinctStates / 2)
            var sorted = prioritizeElements(activeCandidates, actionCounts: actionCounts,
                                            elementScreenPresence: elementScreenPresence,
                                            persistentThreshold: persistentThreshold,
                                            screenBounds: screenBounds)

            // ---- Form-completion steering ----
            // A half-filled form is one tap from progress (submit) or oblivion (Close/Cancel
            // discards everything typed). While the screen has unfilled text fields, fill the
            // topmost next (forms read top-to-bottom); once all are filled, prefer the primary
            // submit; and while the form is in progress, push dismiss-style controls to the very
            // back of the queue. (First real-app run: the explorer filled 3 of 4 signup fields,
            // then tapped the sheet's Close button.) Bounded: each field is typed once
            // (actionCounts guard), so this can never trap the explorer on a screen.
            // Tree-based (not pool-based): the candidate pool empties as elements get acted on
            // (tried-here dedup etc.), but the form is still there — steering must see the real
            // screen or it abandons a form whose remaining field the pool has dropped (observed:
            // signup's Confirm Password missing from the pool while hittable in the tree).
            // Termination is per-field via typedFieldKeys, so this can never loop.
            let treeHasFields = elements.contains(where: { isTextField($0.type) })
            let unfilledFields = elements.filter {
                isTextField($0.type) && $0.isEnabled && $0.isHittable
                    && fieldLooksUnfilled($0, screen: titleStr, typedKeys: typedFieldKeys)
            }
            if treeHasFields {
                // Observability for form steering: which fields the pool actually contains vs the
                // full tree, so field-skipped bugs are diagnosable from any run log.
                let treeFields = elements.filter { isTextField($0.type) }
                let poolDesc = activeCandidates.filter { isTextField($0.type) }
                    .map { "\(actionKey(for: $0))@\(Int($0.frame.midY))" }.joined(separator: ",")
                let treeDesc = treeFields.map { "\(Int($0.frame.midY)):h\($0.isHittable ? 1 : 0)e\($0.isEnabled ? 1 : 0)" }.joined(separator: ",")
                print("OCQA_STATE:form_steering step=\(actionCount) pool=[\(poolDesc)] tree=[\(treeDesc)] unfilled=\(unfilledFields.count) kb=\(app.keyboards.firstMatch.exists ? 1 : 0)")
            }
            if let nextField = unfilledFields.min(by: { $0.frame.minY < $1.frame.minY }) {
                let nextKey = actionKey(for: nextField)
                sorted = [nextField] + sorted.filter { actionKey(for: $0) != nextKey }
                let (dismiss, rest) = sorted.dropFirst().reduce(into: ([SimpleElement](), [SimpleElement]())) {
                    if isDismissControl($1) { $0.0.append($1) } else { $0.1.append($1) }
                }
                sorted = [nextField] + rest + dismiss
            } else if treeHasFields, !app.keyboards.firstMatch.exists,
                      let submit = sorted.first(where: { isLikelySubmitControl($0) && (actionCounts[actionKey(for: $0)] ?? 0) == 0 }) {
                let submitKey = actionKey(for: submit)
                sorted = [submit] + sorted.filter { actionKey(for: $0) != submitKey }
            } else if treeHasFields, app.keyboards.firstMatch.exists,
                      (actionCounts["kbreveal:\(titleStr)"] ?? 0) < max(2, elements.filter { isTextField($0.type) }.count) {
                // With the keyboard up, field values are UNRELIABLE (a never-typed SecureField can
                // read as filled) and the submit may be occluded — settle the keyboard before
                // choosing a submit or leaving. (Observed live: submit tapped before Confirm
                // Password was filled → "Passwords do not match.") Bounded per screen by field
                // count so a stubborn keyboard can't loop this forever.
                actionCounts["kbreveal:\(titleStr)", default: 0] += 1
                dismissKeyboardIfNeeded()
                actionCount += 1
                repeatedStateCount = 0 // settling the keyboard is progress, not a frozen screen
                print("OCQA_ACTION:{\"type\":\"keyboard_dismiss\",\"reason\":\"reveal_submit_after_fill\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON("Hiding the keyboard to look for the form's submit button."))\"}")
                Thread.sleep(forTimeInterval: 0.3)
                emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                continue
            } else if (screenRole == "login" || screenRole == "signup"),
                      !app.keyboards.firstMatch.exists,
                      screenTextEntryCount[titleStr, default: 0] >= 2,
                      // Interactable controls only — a static TITLE like "Create Account" matches
                      // the submit tokens but is not a control the user can tap.
                      !elements.contains(where: { isInteractable($0.type) && $0.isEnabled && isLikelySubmitControl($0) }),
                      !reportedIssueKeys.contains("nosubmit:\(titleStr)") {
                // A credentials form we FILLED (≥2 fields) with the keyboard down and still no
                // submit control anywhere in the tree — the user cannot complete this flow.
                // Found on a real app: a signup sheet with four fields and only a Close button.
                // Scoped to login/signup roles: settings-style forms legitimately auto-save.
                reportedIssueKeys.insert("nosubmit:\(titleStr)")
                let issueTitle = "Form has no submit control: \(titleStr)"
                issues.append((type: "form_no_submit", severity: "medium", title: issueTitle,
                               desc: "Filled the form on '\(titleStr)' but found no button to submit it — the flow cannot be completed."))
                print("OCQA_ISSUE:{\"type\":\"form_no_submit\",\"severity\":\"medium\",\"title\":\"\(escapeJSON(issueTitle))\",\"screen\":\"\(escapedTitle)\",\"step\":\(actionCount)}")
            }

            // ---- Numeric-grid (calendar) handling ----
            // Day cells in a booking calendar are value-selection, not navigation — each tap
            // "succeeds" without a new state, so a month of cells can eat the whole budget
            // (observed live: 3,4,5,6,7,8 tapped in sequence until the run died). After two
            // bare-numeric buttons on this screen have been tried, push the rest to the back.
            let numericTriedHere = (screenActionsTried[titleStr] ?? []).filter {
                $0.hasPrefix("label:") && Int($0.dropFirst("label:".count)) != nil
            }.count
            if numericTriedHere >= 2 {
                let (numericCells, others) = sorted.reduce(into: ([SimpleElement](), [SimpleElement]())) {
                    if Int($1.label.trimmingCharacters(in: .whitespaces)) != nil { $0.0.append($1) } else { $0.1.append($1) }
                }
                if !numericCells.isEmpty { sorted = others + numericCells }
            }

            guard let target = sorted.first else { break }

            if !isTextField(target.type) {
                dismissKeyboardIfNeeded()
            }

            let preContentSig = contentSignature(elements)
            let actionDesc = performSmartAction(
                on: target,
                in: app,
                screenTitle: titleStr,
                inputOverrides: inputOverrides,
                elementTapCount: actionCounts[actionKey(for: target), default: 0],
                screenElements: elements,
                screenRole: screenRole
            )
            let key = actionKey(for: target)
            actionCounts[key, default: 0] += 1
            let stateKey = "\(stateHash)|\(key)"
            stateActionCounts[stateKey, default: 0] += 1
            if isTextField(target.type) {
                typedFieldKeys.insert("\(titleStr)|\(key)")
                // Typing changes field VALUES, which the (value-blind) state hash can't see — now
                // that keyboard elements are excluded from the tree, a multi-field fill is a run of
                // identical hashes. That's progress, not a frozen screen: keep the repeated-state
                // counter from false-firing "Unresponsive UI" mid-form.
                repeatedStateCount = 0
            }
            lastActionKey = key
            lastActionFromStateHash = stateHash
            screenActionsTried[titleStr, default: []].insert(key)
            if isTextField(target.type) {
                screenTextEntryCount[titleStr, default: 0] += 1
            }
            pendingTransitionFrom = (title: titleStr, actionKey: key)
            actionCount += 1

            let targetName = target.identifier.isEmpty ? target.label : target.identifier
            let escapedTarget = escapeJSON(targetName)
            let actionType = isTextField(target.type) ? "type" : "tap"
            let actionNarrative = narrate(action: actionType, target: target, screenTitle: titleStr, actionDesc: actionDesc)
            let escapedNarrative = escapeJSON(actionNarrative)
            print("OCQA_ACTION:{\"type\":\"\(actionType)\",\"target\":\"\(escapedTarget)\",\"elementType\":\"\(target.type)\",\"step\":\(actionCount),\"x\":\(Int(target.frame.midX)),\"y\":\(Int(target.frame.midY)),\"narrative\":\"\(escapedNarrative)\",\"screen\":\"\(escapedTitle)\"}")

            waitForAnimationsToSettle()

            // ---- Early crash check ----
            // If the action just killed the app, report it NOW — before any tree/submit query below,
            // which would throw "Application is not running" and record a spurious test failure while
            // the crash itself goes unreported. app.state is non-throwing even when the app is dead.
            // (Found on a real app: a login submit terminated the app; the run limped on but emitted
            // no crash finding.) Try one relaunch to distinguish a hard crash from a transient exit.
            if app.state != .runningForeground {
                print("OCQA_STATE:app_left_foreground step=\(actionCount) state=\(app.state.rawValue)")
                app.activate()
                Thread.sleep(forTimeInterval: 3.0)
                if app.state != .runningForeground {
                    let crashKey = "crash:\(titleStr)|\(key)"
                    if !reportedIssueKeys.contains(crashKey) {
                        reportedIssueKeys.insert(crashKey)
                        issues.append((type: "crash", severity: "critical", title: "App crashed after \(actionType) on \(titleStr)",
                                       desc: "The app terminated after \(actionType) '\(targetName)' on '\(titleStr)' and did not recover on relaunch."))
                        print("OCQA_ISSUE:{\"type\":\"crash\",\"severity\":\"critical\",\"title\":\"\(escapeJSON("App crashed after \(actionType) on \(titleStr)"))\",\"screen\":\"\(escapedTitle)\",\"control\":\"\(escapedTarget)\",\"step\":\(actionCount)}")
                    }
                    break
                }
                print("OCQA_STATE:app_reactivated step=\(actionCount)")
                emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                continue
            }

            // After a submit/login tap, the result is usually a network round-trip. Wait for the
            // screen to actually change (success navigation or inline error) before continuing,
            // so we don't evaluate the next action against a still-loading screen.
            if !isTextField(target.type) && isLikelySubmitControl(target) {
                print("OCQA_STATE:awaiting_submit_result screen=\(escapedTitle) step=\(actionCount)")
                waitForSubmitResult(previousHash: stateHash)
                // Evaluate the submit result. A submit that navigates away OR changes the visible
                // content (an inline "Saved"/"Thanks" confirmation, a validation error) DID have an
                // effect. Only a submit that leaves us on the same screen with NO content change is a
                // genuine failed submit/sign-in.
                let postSubmit = readUITree(app)
                let postSubmitTitle = detectTitle(postSubmit) ?? "Unknown"
                let postSubmitContentChanged = !postSubmit.isEmpty && contentSignature(postSubmit) != preContentSig
                let onAuthScreen = detectedInputs.contains { $0.secure }
                if postSubmitTitle != titleStr {
                    // Moved forward — success. Remember a successful sign-in so a later re-poke of the
                    // login form (after Sign Out) isn't mis-reported as an auth failure.
                    if onAuthScreen { authSucceeded = true }
                } else if !postSubmitContentChanged {
                    // Still on the same screen with no visible change — record it so we stop re-filling
                    // and re-submitting the same form and instead navigate away.
                    failedSubmits[titleStr, default: 0] += 1
                    print("OCQA_STATE:submit_no_change screen=\(escapedTitle) attempts=\(failedSubmits[titleStr, default: 0])")
                    let submitKey = "submitfail:\(titleStr)"
                    // Only a genuine, novel failure counts: a strong submit/sign-in control, an actual
                    // form present, not an already-selected segment, and NOT a login screen we've
                    // already authenticated past (Sign Out → re-login churn, not a product defect).
                    if !reportedIssueKeys.contains(submitKey)
                        && isStrongSubmitControl(target)
                        && !detectedInputs.isEmpty
                        && !target.isSelected
                        && !(onAuthScreen && authSucceeded) {
                        reportedIssueKeys.insert(submitKey)
                        let issueType = onAuthScreen ? "auth_failed" : "submit_failed"
                        let issueTitle = onAuthScreen ? "Sign-in did not succeed" : "Form submission had no effect"
                        let issueDesc = "Tapping '\(targetName)' on '\(titleStr)' left the user on the same screen with no visible change — likely a failed \(onAuthScreen ? "sign-in" : "validation or broken action")."
                        issues.append((type: issueType, severity: "high", title: issueTitle, desc: issueDesc))
                        print("OCQA_ISSUE:{\"type\":\"\(issueType)\",\"severity\":\"high\",\"title\":\"\(escapeJSON(issueTitle))\",\"screen\":\"\(escapedTitle)\",\"control\":\"\(escapedTarget)\",\"step\":\(actionCount)}")
                    }
                }
            } else if !isTextField(target.type) {
                // ---- No-op / dead control detection ----
                // A labeled BUTTON that produces NO visible change (no navigation, no content or
                // value change) is likely a dead control — exactly the "clicking a button does
                // nothing" case. We compare a content signature (labels + values) so controls that
                // only change a value (counters, toggles) are never falsely flagged, exclude
                // selection/value controls, and require a second confirming read to rule out a
                // merely-delayed update. NATIVE buttons only (rawValue:9): web buttons/links live
                // inside a WKWebView, whose dynamic DOM changes aren't reliably reflected in the
                // accessibility tree, so we can't measure their responsiveness this way.
                let isButton = target.type.contains("rawValue: 9")
                let isToggle = target.type.contains("Switch") || target.type.contains("Toggle") || target.type.contains("rawValue: 40")
                // Require a human-readable VISIBLE LABEL — not just a dotted developer identifier
                // like "resident.home.curatedForYou" (those are usually containers exposed as buttons,
                // not real tappable controls a user would expect to act).
                let humanLabel = target.label.trimmingCharacters(in: .whitespacesAndNewlines)
                let named = !humanLabel.isEmpty && !isSymbolLikeLabel(humanLabel)
                    && !(humanLabel.contains(".") && !humanLabel.contains(" "))
                let noOpKey = "noop:\(titleStr)|\(key)"
                if isButton && !isToggle && named
                    && !isSelectionOrValueControl(target)
                    && !isInsideSelectionContainer(target)
                    && !isSystemHandoffControl(humanLabel)
                    && app.state == .runningForeground && !reportedIssueKeys.contains(noOpKey) {
                    let post1 = readUITree(app)
                    if !post1.isEmpty, contentSignature(post1) == preContentSig {
                        // Confirm it's genuinely inert, not just a delayed update.
                        Thread.sleep(forTimeInterval: 0.6)
                        let post2 = readUITree(app)
                        if app.state == .runningForeground, !post2.isEmpty, contentSignature(post2) == preContentSig {
                            reportedIssueKeys.insert(noOpKey)
                            let issueTitle = "Control may be unresponsive: '\(humanLabel)'"
                            let issueDesc = "Tapping '\(humanLabel)' on '\(titleStr)' produced no visible change (no navigation, content, or state change)."
                            issues.append((type: "unresponsive_element", severity: "low", title: issueTitle, desc: issueDesc))
                            print("OCQA_ISSUE:{\"type\":\"unresponsive_element\",\"severity\":\"low\",\"title\":\"\(escapeJSON(issueTitle))\",\"screen\":\"\(escapedTitle)\",\"control\":\"\(escapeJSON(humanLabel))\",\"step\":\(actionCount)}")
                        }
                    }
                }
            }

            // ---- App left foreground / crash detection ----
            // Check both .exists and .state — external links may cause either to fail
            let appInForeground = app.state == .runningForeground
            if !appInForeground || !app.exists {
                print("OCQA_STATE:app_left_foreground step=\(actionCount) state=\(app.state.rawValue)")
                app.activate()
                Thread.sleep(forTimeInterval: 3.0)
                if app.state != .runningForeground {
                    issues.append((type: "crash", severity: "critical",
                                   title: "App not recoverable",
                                   desc: "App left foreground after: \(actionDesc)"))
                    print("OCQA_ISSUE:{\"type\":\"crash\",\"severity\":\"critical\",\"title\":\"App not recoverable\",\"action\":\"\(escapedTarget)\",\"step\":\(actionCount)}")
                    break
                }
                print("OCQA_STATE:app_reactivated step=\(actionCount)")
                emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
                continue
            }

            // ---- Track transition ----
            stateTransitions.append((from: stateHash, to: "deferred", action: actionDesc))
            print("OCQA_TRANSITION:{\"from\":\"\(escapedTitle)\",\"fromHash\":\"\(stateHash)\",\"to\":\"pending\",\"action\":\"\(escapedTarget)\"}")

            emitProgress(action: actionCount, maxActions: maxActions, states: visitedStates.count)
        }

        let uniqueScreens = screenTitles.values
        let screenList = Array(Set(uniqueScreens)).sorted().joined(separator: ",")
        didEmitComplete = true
        print("OCQA_COMPLETE:{\"actions\":\(actionCount),\"states\":\(visitedStates.count),\"issues\":\(issues.count),\"screens\":\"\(screenList)\"}")

        let finalScreenshot = app.screenshot()
        let finalAttachment = XCTAttachment(screenshot: finalScreenshot)
        finalAttachment.name = "final_state"
        finalAttachment.lifetime = .keepAlways
        add(finalAttachment)
    }

    // MARK: - Helpers

    private struct SimpleElement {
        let type: String
        let identifier: String
        let label: String
        let value: String
        let isSelected: Bool
        let frame: CGRect
        let isEnabled: Bool
        let isHittable: Bool
        let xcElement: XCUIElement?
    }

    private func readUITree(_ app: XCUIApplication) -> [SimpleElement] {
        // Check app is accessible before attempting snapshot
        guard app.state == .runningForeground else { return [] }
        // Try snapshot-based read first — single IPC call, ~100x faster
        var elements: [SimpleElement]
        if let snapshotElements = readViaSnapshot(app), !snapshotElements.isEmpty {
            elements = snapshotElements
        } else {
            // Fallback to element-by-element read (pre-Xcode 15 or snapshot failure)
            guard app.state == .runningForeground else { return [] }
            elements = readElementByElement(app)
        }
        // Augment with accessible web content from any WKWebView containers
        elements += extractWebViewElements(app, existingCount: elements.count)

        // The system keyboard is not part of the app's surface. With it in the tree, every form
        // screen's hash flips between keyboard-up/keyboard-down variants — read as a false
        // "navigation loop" (period 2) that aborted exploration mid-form — and its keys inflate
        // the distinct-state count. Drop keyboard-region elements (keeping text fields, which can
        // legitimately sit near the keyboard's top edge); the keyboard itself remains observable
        // via app.keyboards for the settled flag and dismissal logic.
        let kb = app.keyboards.firstMatch
        if kb.exists {
            let kbFrame = kb.frame
            if kbFrame.height > 0 {
                elements = elements.filter { isTextField($0.type) || $0.frame.midY < kbFrame.minY }
            }
        }
        return elements
    }

    /// Extract accessible links/buttons/text from embedded WKWebView containers.
    /// WKWebViews expose a limited accessibility subtree; we harvest what's available.
    private func extractWebViewElements(_ app: XCUIApplication, existingCount: Int) -> [SimpleElement] {
        guard existingCount < 150 else { return [] } // skip if tree already dense
        let safeScreen = screenBounds.width > 0 ? screenBounds : CGRect(x: 0, y: 0, width: 390, height: 844)

        // SNAPSHOT-based harvest — one IPC per webview. The previous per-element version resolved
        // every link/button property with a live query (8+ round-trips per link, each with an idle
        // wait); on a Wikipedia article that was ~40s of "Find the X Link" per few actions and made
        // WebView-heavy apps time out their budget. Property reads on a snapshot are free.
        let firstWV = app.webViews.firstMatch
        guard firstWV.exists else { return [] }

        // Web content loads asynchronously — when we first land on a web screen the accessibility
        // tree may be empty. Give it a moment to populate before harvesting.
        var rootSnap = try? firstWV.snapshot()
        if (rootSnap?.children.isEmpty ?? true) {
            _ = firstWV.links.firstMatch.waitForExistence(timeout: 2.5)
            rootSnap = try? firstWV.snapshot()
        }
        guard let root = rootSnap else { return [] }

        var webElements: [SimpleElement] = []
        var links = 0, buttons = 0, fields = 0, secures = 0, texts = 0

        func harvest(_ snap: XCUIElementSnapshot) {
            guard webElements.count < 60 else { return }
            let frame = snap.frame
            let visible = frame.width > 0 && frame.height > 0
                && frame.origin.x.isFinite && frame.origin.y.isFinite
                && safeScreen.contains(CGPoint(x: frame.midX, y: frame.midY))

            var typeName: String?
            switch snap.elementType {
            case .link:            links += 1;   if links <= 30 { typeName = "Link" }
            case .button:          buttons += 1; if buttons <= 20 { typeName = "Button" }
            case .textField:       fields += 1;  if fields <= 10 { typeName = "TextField" }
            case .secureTextField: secures += 1; if secures <= 5 { typeName = "SecureTextField" }
            case .staticText:      texts += 1
            default: break
            }
            if visible, let typeName {
                webElements.append(SimpleElement(
                    type: typeName,
                    identifier: snap.identifier,
                    label: snap.label,
                    value: (snap.value as? String) ?? "",
                    isSelected: snap.isSelected,
                    frame: frame,
                    isEnabled: snap.isEnabled,
                    isHittable: visible && snap.isEnabled,
                    xcElement: nil // taps fall back to coordinates; typing re-resolves live by frame
                ))
            }
            for child in snap.children {
                guard webElements.count < 60 else { return }
                if let c = child as? XCUIElementSnapshot { harvest(c) }
            }
        }
        harvest(root)

        print("OCQA_STATE:webview_probe links=\(links) buttons=\(buttons) staticTexts=\(texts) textFields=\(fields) harvested=\(webElements.count)")
        return webElements
    }

    /// Reads the full UI tree via a single snapshot() call — dramatically faster than
    /// per-element queries since it's one IPC round-trip for the entire hierarchy.
    private func readViaSnapshot(_ app: XCUIApplication) -> [SimpleElement]? {
        guard let snapshot = try? app.snapshot() else { return nil }

        var elements: [SimpleElement] = []
        let limit = 200
        let safeScreen = screenBounds.width > 0 ? screenBounds : CGRect(x: 0, y: 0, width: 500, height: 1000)

        func walk(_ snap: XCUIElementSnapshot) {
            guard elements.count < limit else { return }

            let frame = snap.frame
            if frame.width > 0, frame.height > 0,
               frame.origin.x.isFinite, frame.origin.y.isFinite,
               frame.width.isFinite, frame.height.isFinite {

                let hittable = snap.isEnabled && safeScreen.contains(CGPoint(x: frame.midX, y: frame.midY))
                elements.append(SimpleElement(
                    type: String(describing: snap.elementType),
                    identifier: snap.identifier,
                    label: snap.label ?? "",
                    value: (snap.value as? String) ?? "",
                    isSelected: snap.isSelected,
                    frame: frame,
                    isEnabled: snap.isEnabled,
                    isHittable: hittable,
                    xcElement: nil
                ))
            }

            for child in snap.children {
                guard elements.count < limit else { return }
                if let childSnap = child as? XCUIElementSnapshot {
                    walk(childSnap)
                }
            }
        }

        walk(snapshot)
        return elements
    }

    /// Fallback element-by-element read — slower but works on all Xcode versions.
    private func readElementByElement(_ app: XCUIApplication) -> [SimpleElement] {
        var elements: [SimpleElement] = []
        let query = app.descendants(matching: .any)
        _ = query.firstMatch.waitForExistence(timeout: 5)
        let count = query.count

        let safeScreen = screenBounds.width > 0 ? screenBounds : CGRect(x: 0, y: 0, width: 500, height: 1000)

        for i in 0..<min(count, 150) {
            let el = query.element(boundBy: i)
            guard el.exists else { continue }

            let frame = el.frame
            guard frame.width > 0, frame.height > 0,
                  frame.origin.x.isFinite, frame.origin.y.isFinite,
                  frame.width.isFinite, frame.height.isFinite else { continue }

            let hittable = el.isEnabled && safeScreen.contains(CGPoint(x: frame.midX, y: frame.midY))

            elements.append(SimpleElement(
                type: String(describing: el.elementType),
                identifier: el.identifier,
                label: el.label,
                value: (el.value as? String) ?? "",
                isSelected: el.isSelected,
                frame: frame,
                isEnabled: el.isEnabled,
                isHittable: hittable,
                xcElement: el
            ))
        }
        return elements
    }

    private func actionKey(for element: SimpleElement) -> String {
        let id = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        if !id.isEmpty { return "id:\(id)" }
        let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
        if !label.isEmpty { return "label:\(label)" }

        let bucketX = Int(element.frame.midX / 80)
        let bucketY = Int(element.frame.midY / 72)
        if element.type.contains("Cell") || element.type.contains("rawValue: 75") {
            return "anonCell:\(bucketY)"
        }
        if element.type.contains("Button") || element.type.contains("rawValue: 9") {
            return "anonButton:\(bucketX)x\(bucketY)"
        }
        return "anon:\(bucketX)x\(bucketY):\(element.type)"
    }

    /// Structural fingerprint of a screen.
    /// Identity = (element type, stable identifier if present, interactability, coarse grid position).
    /// Free-text labels are deliberately excluded so cosmetic changes
    /// (greetings, counts, timestamps, badges) don't fork a screen into duplicates.
    /// Acceptance: "Good Evening Luis" and "Good Morning Luis" hash identical.
    private func computeHash(_ elements: [SimpleElement]) -> String {
        let structure = elements.map { el -> String in
            let id = el.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
            let interactable = isInteractable(el.type) ? "1" : "0"
            // 40px grid: stable against minor reflows but still distinguishes layouts.
            let gridX = Int(el.frame.midX / 40)
            let gridY = Int(el.frame.midY / 40)
            return "\(el.type):\(id):\(interactable):\(gridX):\(gridY)"
        }.sorted().joined(separator: "|")
        var hash: UInt64 = 5381
        for byte in structure.utf8 {
            hash = ((hash << 5) &+ hash) &+ UInt64(byte)
        }
        return String(hash, radix: 16)
    }

    /// Affordance fingerprint: a hash of the SET of labels of *content* interactable elements — i.e.
    /// *what you can do* on a screen, EXCLUDING global navigation (tab bar) and the back button
    /// (which appear on nearly every screen). Unlike computeHash (which keys on element
    /// type/identifier/position and so gives a different value to every screen whose nav-title
    /// differs), this collapses structurally-identical sibling screens that offer the same actions
    /// (e.g. a list of detail screens reachable from one hub) while keeping screens whose action set
    /// differs distinct — an error screen's "Retry"/"Warning" or an empty state's "Add Report" keep
    /// those screens separate, so a template-skip built on this never skips a screen that hides a
    /// finding. Returns the content-affordance count too: a screen with ZERO content affordances
    /// (just text/a spinner — e.g. a changelog or a loading screen) is deliberately NOT eligible to
    /// form a template, because its identity lives in its text (which we can't fingerprint) and may
    /// hide a finding. (Empirically validated against real captured UI trees before adopting.)
    private func affordanceFingerprint(_ elements: [SimpleElement]) -> (fingerprint: String, contentCount: Int) {
        var labels = Set<String>()
        for el in elements where isInteractable(el.type) {
            if isNavBackButton(el) || isLikelyGlobalNavigation(el, screenBounds: screenBounds) { continue }
            let label = el.label.trimmingCharacters(in: .whitespacesAndNewlines)
            let id = el.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = (label.isEmpty ? id : label).lowercased()
            if !key.isEmpty { labels.insert(key) }
        }
        let joined = labels.sorted().joined(separator: "|")
        var hash: UInt64 = 5381
        for byte in joined.utf8 {
            hash = ((hash << 5) &+ hash) &+ UInt64(byte)
        }
        return (String(hash, radix: 16), labels.count)
    }

    /// Dismiss any launch-time sheet/modal (e.g. a "Get Started" welcome sheet) then walk back to the
    /// navigation root and reset to the first tab if the app has a tab bar. Used at the start of
    /// autonomous exploration so wandering/coverage logic always starts from a stable, canonical
    /// screen rather than a one-time onboarding modal. NOT used by flow replay — a Flow's own first
    /// step (e.g. `tap: Continue`) is expected to dismiss a launch sheet if the recording/grounding
    /// captured one; the caller emits an OCQA_STATE for the true initial screen before calling this,
    /// so exploration/grounding never swallows a launch-time sheet without a trace.
    private func navigateToRootScreen(actionCount: inout Int) {
        // First dismiss any sheets. Every dismissal that actually changes the screen is emitted as
        // a real OCQA_ACTION so the coverage graph gets a genuine launch-screen → root edge — without
        // it the launch screen is an island: the Flows visual editor can't script past it, and a
        // flow authored from the (only-connected) post-dismiss root fails on fresh replay, which
        // launches to the undismissed sheet.
        for _ in 0..<3 {
            let preElements = readUITree(app)
            let preTitle = detectTitle(preElements)
            // Conservative dismiss controls first (unambiguous close semantics, safe anywhere).
            // Primary-CTA labels (Continue/Get Started/…) are only tried when a modal is actually
            // occluding the app's own chrome — on a plain root screen a "Continue" is a normal
            // navigation (e.g. a wizard) and must be left to exploration proper, not the preamble.
            var candidates = ["Close", "Cancel", "Done", "Dismiss"]
            if isLikelySheetPresented() {
                candidates += ["Continue", "Get Started", "Not Now", "Skip", "OK", "Maybe Later"]
            }
            var tappedLabel: String? = nil
            for label in candidates {
                let btn = app.buttons[label]
                if btn.exists && btn.isHittable {
                    btn.tap()
                    Thread.sleep(forTimeInterval: 0.5)
                    tappedLabel = label
                    break
                }
            }
            if tappedLabel == nil {
                // Try swiping down to dismiss sheet
                let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
                let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
                start.press(forDuration: 0.1, thenDragTo: end)
                Thread.sleep(forTimeInterval: 0.5)
            }
            let postElements = readUITree(app)
            let postTitle = detectTitle(postElements)
            if postTitle == preTitle { break } // didn't change — no more sheets
            // The screen changed: record the dismissal as a normal action so the transition is a
            // real, replayable edge (tap) or at least a visible one (swipe) in the coverage graph.
            actionCount += 1
            if let label = tappedLabel {
                print("OCQA_ACTION:{\"type\":\"tap\",\"target\":\"\(escapeJSON(label))\",\"reason\":\"launch_sheet_dismiss\",\"step\":\(actionCount),\"screen\":\"\(escapeJSON(preTitle ?? "Unknown"))\",\"narrative\":\"\(escapeJSON("Dismissing the launch screen via '\(label)'."))\"}")
            } else {
                print("OCQA_ACTION:{\"type\":\"swipe\",\"direction\":\"down\",\"reason\":\"launch_sheet_dismiss\",\"step\":\(actionCount),\"screen\":\"\(escapeJSON(preTitle ?? "Unknown"))\",\"narrative\":\"\(escapeJSON("Swiping down to dismiss the launch sheet."))\"}")
            }
        }
        // Then go back through navigation stack
        for _ in 0..<10 {
            let navBack = app.navigationBars.buttons.firstMatch
            if navBack.exists && navBack.isHittable {
                navBack.tap()
                Thread.sleep(forTimeInterval: 0.5)
            } else {
                break
            }
        }
        // If a visible tab bar exists, reset to the first tab. Avoid blind taps for non-tab apps.
        let rootElements = readUITree(app)
        let rootInteractable = rootElements.filter { $0.isEnabled && $0.isHittable && isInteractable($0.type) }
        if hasVisibleGlobalNavigation(rootInteractable, screenBounds: screenBounds) {
            tapTab(atRotationIndex: 0)
            Thread.sleep(forTimeInterval: 0.5)
        }
        print("OCQA_STATE:navigated_to_root")
    }

    /// True when a modal overlay is likely covering the app's own chrome: a tab bar or navigation
    /// bar that EXISTS but is not hittable is occluded by a presented sheet/fullscreen cover. On a
    /// plain root screen (wizard step, form) all chrome is hittable, so this stays false and the
    /// preamble won't tap navigation-y CTAs like "Continue" that aren't dismissals there.
    private func isLikelySheetPresented() -> Bool {
        let tabBar = app.tabBars.firstMatch
        if tabBar.exists && !tabBar.isHittable { return true }
        for bar in app.navigationBars.allElementsBoundByIndex where bar.exists && !bar.isHittable {
            return true
        }
        return false
    }

    /// The frontmost navigation bar's title, or nil. When sheets stack multiple bars, prefer the
    /// last (frontmost) one. This is the canonical XCUITest way to identify a screen — far more
    /// reliable than scraping static text, which picks up section headers and list rows.
    private func navigationBarTitle() -> String? {
        let bars = app.navigationBars.allElementsBoundByIndex.filter { $0.exists }
        guard !bars.isEmpty else { return nil }
        // Frontmost first: a nav bar behind a presented sheet is not hittable, so a hittable bar
        // (the sheet's own) wins. This is what makes a composer/detail sheet read as its real
        // title (e.g. "New Task") instead of the screen underneath it ("Todo List").
        let ordered = bars.sorted { ($0.isHittable ? 1 : 0) > ($1.isHittable ? 1 : 0) }
        for bar in ordered {
            if let title = titleFromBar(bar) { return title }
        }
        return nil
    }

    private func titleFromBar(_ bar: XCUIElement) -> String? {
        guard bar.exists else { return nil }
        let id = bar.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        if !id.isEmpty, isLikelyTitleText(id) { return id }
        // SwiftUI sometimes leaves the bar's identifier empty and renders the title as a
        // static-text child instead.
        let child = bar.staticTexts.allElementsBoundByIndex
            .first { $0.exists && !$0.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if let child {
            let lbl = normalizeVisibleText(child.label)
            if !lbl.isEmpty, isLikelyTitleText(lbl) { return lbl }
        }
        return nil
    }

    /// Content fingerprint including labels + values — unlike computeHash (which deliberately
    /// ignores free text), this changes when a control updates a value (counter, toggle, inline
    /// text). Used to tell a genuinely dead button ("nothing happened") from one that only changed
    /// a value.
    private func contentSignature(_ elements: [SimpleElement]) -> String {
        elements.map { "\($0.type)|\($0.identifier)|\($0.label)|\($0.value)" }.sorted().joined(separator: "~")
    }

    /// Machine identifiers sometimes leak into a11y titles — mangled runtime type names
    /// ("_TtGC7SwiftUI32NavigationStackHosting", "_UIContextMenuActionsOnlyView") and raw hex
    /// asset/state ids ("5aadc347c4d963a0") — never a real screen title, and they read as broken
    /// output on every finding/coverage row they touch.
    private func isMangledTypeName(_ s: String) -> Bool {
        if s.hasPrefix("_") { return true }
        if !s.contains(" ") && (s.contains("SwiftUI") || s.contains("Hosting") || s.contains("ViewController")) { return true }
        // Long all-hex token (an image/state id) with no spaces.
        if s.count >= 12, !s.contains(" "), s.allSatisfy({ $0.isHexDigit }) { return true }
        // Module.Class identifiers ("Wikipedia.SinglePageWebView") — dotted CamelCase with no
        // spaces. Titles like "Node.js" survive (component after the dot starts lowercase).
        if !s.contains(" "),
           s.range(of: "^[A-Za-z][A-Za-z0-9]*\\.[A-Z][A-Za-z0-9.]*$", options: .regularExpression) != nil {
            return true
        }
        return false
    }

    private func detectTitle(_ elements: [SimpleElement]) -> String? {
        // Most reliable signal: the SwiftUI navigation-bar title (queried live).
        if let navTitle = navigationBarTitle(), !isMangledTypeName(navTitle) { return navTitle }

        // NavigationBar = rawValue: 74 (snapshot fallback)
        if let navTitle = elements.first(where: { $0.type.contains("rawValue: 74") || $0.type.contains("NavigationBar") }) {
            if !navTitle.identifier.isEmpty, !isMangledTypeName(navTitle.identifier) { return navTitle.identifier }
            if !navTitle.label.isEmpty, !isMangledTypeName(navTitle.label) { return navTitle.label }
        }

        let screenHeight = screenBounds.height > 0 ? screenBounds.height : 900
        let screenWidth = screenBounds.width > 0 ? screenBounds.width : 390
        let centerX = screenWidth / 2

        let staticTexts = elements
            .filter { isStaticTextType($0.type) }
            .map { ($0, normalizeVisibleText($0.label)) }
            .filter { !$0.1.isEmpty && isLikelyTitleText($0.1) }

        // Prefer centered, prominent text in upper ~65% of screen.
        let centeredCandidates = staticTexts
            .filter { item in
                let el = item.0
                return el.frame.minY < screenHeight * 0.65
                    && abs(el.frame.midX - centerX) <= screenWidth * 0.22
                    && el.frame.width >= screenWidth * 0.22
                    && el.frame.height <= 64
            }
            .sorted { lhs, rhs in
                let l = lhs.0
                let r = rhs.0
                if abs(l.frame.midX - centerX) != abs(r.frame.midX - centerX) {
                    return abs(l.frame.midX - centerX) < abs(r.frame.midX - centerX)
                }
                if l.frame.minY != r.frame.minY {
                    return l.frame.minY < r.frame.minY
                }
                return (l.frame.width * l.frame.height) > (r.frame.width * r.frame.height)
            }

        if let best = centeredCandidates.first?.1 {
            return best
        }

        // Fallback to upper text region with broader threshold.
        let topCandidates = staticTexts
            .filter { $0.0.frame.minY < screenHeight * 0.45 }
            .sorted { lhs, rhs in
                let l = lhs.0
                let r = rhs.0
                let lArea = l.frame.width * l.frame.height
                let rArea = r.frame.width * r.frame.height
                if lArea != rArea { return lArea > rArea }
                return abs(l.frame.midX - centerX) < abs(r.frame.midX - centerX)
            }

        if let top = topCandidates.first?.1 {
            return top
        }

        // Final fallback for tabbed root screens where no good header text is visible.
        if let tabTitle = selectedTabTitle(), !tabTitle.isEmpty {
            return tabTitle
        }

        // Last resort: the topmost meaningful on-screen text. For custom SwiftUI screens that
        // expose no nav bar or centered header, this beats labelling everything "Unknown".
        if let firstText = collectVisibleTexts(elements, limit: 1).first {
            return firstText
        }

        return nil
    }

    private func isInteractable(_ type: String) -> Bool {
        let interactableRawValues = [9, 39, 40, 42, 43, 49, 50, 53, 54, 56, 75]
        for rv in interactableRawValues {
            if type.contains("rawValue: \(rv)") { return true }
        }
        let types = ["Button", "TextField", "SecureTextField", "Link", "Cell",
                     "Switch", "Slider", "Tab", "MenuItem", "SegmentedControl",
                     "Picker", "Toggle", "Stepper", "DatePicker"]
        return types.contains(where: { type.contains($0) })
    }

    private func isTextField(_ type: String) -> Bool {
        return type.contains("TextField") || type.contains("SecureTextField") ||
               type.contains("rawValue: 49") || type.contains("rawValue: 50")
    }

    /// Secure (password) field. The runtime reports the type as "rawValue: 50", NOT the friendly
    /// "SecureTextField" string — checking only the latter missed password fields, which broke
    /// password masking, auth-vs-form classification, and login screen-role detection.
    private func isSecureTextField(_ type: String) -> Bool {
        return type.contains("SecureTextField") || type.contains("rawValue: 50")
    }

    /// Checks if an element is likely an external link that will leave the app
    private func isExternalLink(_ element: SimpleElement) -> Bool {
        let text = (element.identifier + " " + element.label).lowercased()
        let externalPrefixes = ["open in ", "download on ", "get it on ", "available on ", "order on ", "buy on "]
        if externalPrefixes.contains(where: { text.contains($0) }) { return true }
        // Legal / help / "learn more" links open web content (in-app browser or Safari) that is
        // out of QA scope AND a hang trap: the external page may never reach idle, so the NEXT
        // XCUITest query blocks to its 60s timeout and ABORTS the whole run (observed on Wikipedia
        // onboarding: tapping "Privacy policy" ended the run). Match whole words so app content
        // like a "Terms" tab isn't wrongly skipped.
        let externalWordSets: [[String]] = [
            ["privacy", "policy"], ["terms", "of", "service"], ["terms", "of", "use"],
            ["terms", "and", "conditions"], ["cookie", "policy"], ["learn", "more", "about"],
        ]
        let words = Set(text.split(whereSeparator: { !$0.isLetter }).map(String.init))
        return externalWordSets.contains { $0.allSatisfy(words.contains) }
    }

    /// The leading navigation-bar back button (top-left). It shouldn't be a primary exploration
    /// candidate — otherwise the explorer leaves a screen before exploring/scrolling it. Going back
    /// is still handled explicitly as a recovery action (tryGoBack) once the screen is exhausted.
    private func isNavBackButton(_ element: SimpleElement) -> Bool {
        guard element.type.contains("Button") || element.type.contains("rawValue: 9") else { return false }
        let h = screenBounds.height > 0 ? screenBounds.height : 900
        let w = screenBounds.width > 0 ? screenBounds.width : 390
        return element.frame.midY < h * 0.12 && element.frame.midX < w * 0.22
    }

    private func isLikelyGlobalNavigation(_ element: SimpleElement, screenBounds: CGRect) -> Bool {
        let screenHeight = screenBounds.height > 0 ? screenBounds.height : 1000
        let bottomZoneThreshold = screenHeight * 0.88
        let inBottomZone = element.frame.midY >= bottomZoneThreshold

        // Tab bar elements (rawValue: 53 = TabBar, 54 = Tab)
        if element.type.contains("rawValue: 53") || element.type.contains("rawValue: 54") ||
           element.type.contains("TabBar") || element.type.contains("Tab") {
            return true
        }

        // Only treat bottom-zone elements as global nav if they also match nav tokens
        if inBottomZone {
            let navTokens = ["home", "profile", "account", "settings", "menu", "more", "dashboard", "tasks", "inbox", "search", "activity", "explore"]
            let text = (element.identifier + " " + element.label).lowercased()
            return navTokens.contains { text.contains($0) }
        }

        return false
    }

    private func selectedTabTitle() -> String? {
        let selectedPred = NSPredicate(format: "isSelected == 1")
        let selected = app.tabBars.buttons.matching(selectedPred).allElementsBoundByIndex
            .first { $0.exists && !$0.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if let selected {
            return selected.label.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let allTabs = app.tabBars.buttons.allElementsBoundByIndex
            .filter { $0.exists && $0.isHittable && !$0.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if allTabs.count >= 2 {
            return allTabs.first?.label.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    private func tapTab(atRotationIndex tabIdx: Int) {
        let allTabs = app.tabBars.buttons.allElementsBoundByIndex
            .filter { $0.exists && $0.isHittable }
            .sorted { $0.frame.midX < $1.frame.midX }

        if !allTabs.isEmpty {
            let safeIdx = max(0, min(tabIdx, allTabs.count - 1))
            allTabs[safeIdx].tap()
            return
        }

        // Fallback for tab bars that don't expose buttons reliably in this runtime.
        let tabBarY = screenBounds.height > 0 ? screenBounds.height - 30 : 820.0
        let screenW = screenBounds.width > 0 ? screenBounds.width : 402.0
        let tabPositions: [CGFloat] = [0.12, 0.31, 0.5, 0.69, 0.88]
        let safeIdx = max(0, min(tabIdx, tabPositions.count - 1))
        let xPos = screenW * tabPositions[safeIdx]
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: xPos, dy: tabBarY)).tap()
    }

    // MARK: - Directed (targeted) exploration

    /// Beeline from the current (root) screen to `target` as fast as possible by tapping each
    /// control label in `route` (learned from prior runs). Emits the same OCQA markers as normal
    /// exploration so the path is recorded and narrated ("Heading to X: tapping Y").
    @discardableResult
    private func beelineToTarget(target: String, route: [String], actionCount: inout Int, maxActions: Int) -> Bool {
        print("OCQA_STATE:directed_start target=\(escapeJSON(target)) route_len=\(route.count)")
        if currentTitleMatches(target) {
            print("OCQA_STATE:directed_reached target=\(escapeJSON(target)) step=\(actionCount)")
            return true
        }
        for label in route {
            if actionCount >= maxActions { break }
            let elements = readUITree(app)
            let titleStr = detectTitle(elements) ?? "Unknown"
            let escapedTitle = escapeJSON(titleStr)
            let inputs = detectInputDescriptors(in: elements)
            let interactable = elements.filter { $0.isEnabled && isInteractable($0.type) }
            let role = classifyScreenRole(title: titleStr, elements: elements, inputs: inputs, interactable: interactable)
            let summary = describeScreen(title: titleStr, role: role, elements: elements, inputs: inputs, interactable: interactable)
            print("OCQA_STATE:{\"screen\":\"\(escapedTitle)\",\"hash\":\"\(computeHash(elements))\",\"elements\":\(elements.count),\"action\":\(actionCount),\"role\":\"\(escapeJSON(role))\",\"summary\":\"\(escapeJSON(summary))\",\"inputs\":[]}")

            let tapped = tapControlByLabel(label)
            actionCount += 1
            let narrative = "Heading to \(target): tapping \(label)."
            print("OCQA_ACTION:{\"type\":\"tap\",\"target\":\"\(escapeJSON(label))\",\"reason\":\"directed_route\",\"step\":\(actionCount),\"screen\":\"\(escapedTitle)\",\"narrative\":\"\(escapeJSON(narrative))\"}")
            if !tapped {
                print("OCQA_STATE:directed_step_missed label=\(escapeJSON(label)) step=\(actionCount)")
            }
            waitForAnimationsToSettle()
            emitProgress(action: actionCount, maxActions: maxActions, states: 0)
            if currentTitleMatches(target) {
                print("OCQA_STATE:directed_reached target=\(escapeJSON(target)) step=\(actionCount)")
                return true
            }
        }
        let reached = currentTitleMatches(target)
        print("OCQA_STATE:directed_\(reached ? "reached" : "not_reached") target=\(escapeJSON(target)) step=\(actionCount)")
        return reached
    }

    private func currentTitleMatches(_ target: String) -> Bool {
        guard !target.isEmpty else { return false }
        let current = detectTitle(readUITree(app)) ?? ""
        return current.caseInsensitiveCompare(target) == .orderedSame
    }

    /// Tap a control identified by its visible label/title. Tries fast element queries first, then a
    /// case-insensitive contains match, then a coordinate tap on the matching snapshot element.
    @discardableResult
    private func tapControlByLabel(_ label: String) -> Bool {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        for query in [app.buttons, app.cells, app.links, app.staticTexts] {
            let el = query[trimmed]
            if el.exists && el.isHittable { el.tap(); return true }
        }
        let predicate = NSPredicate(format: "label CONTAINS[c] %@", trimmed)
        let match = app.descendants(matching: .any).matching(predicate).firstMatch
        if match.exists && match.isHittable { match.tap(); return true }
        // Fall back to the flat snapshot (coordinate tap on the closest label match).
        if let hit = readUITree(app).first(where: {
            $0.isHittable && isInteractable($0.type)
                && ($0.label.caseInsensitiveCompare(trimmed) == .orderedSame
                    || $0.label.localizedCaseInsensitiveContains(trimmed))
        }) {
            app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: hit.frame.midX, dy: hit.frame.midY)).tap()
            return true
        }
        return false
    }

    private func hasVisibleGlobalNavigation(_ elements: [SimpleElement], screenBounds: CGRect) -> Bool {
        elements.filter { isLikelyGlobalNavigation($0, screenBounds: screenBounds) }.count >= 2
    }

    private func isAnonymousControl(_ element: SimpleElement) -> Bool {
        element.identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && element.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func isLikelyExploratoryNavigation(_ element: SimpleElement) -> Bool {
        if isTextField(element.type) { return false }
        if isLikelySubmitControl(element) { return true }
        if isAnonymousControl(element) { return false }

        let text = (element.identifier + " " + element.label).lowercased()
        let mutationTokens = [
            "delete", "remove", "reset", "increment", "decrement", "mark complete",
            "mark incomplete", "toggle", "enable", "disable", "archive"
        ]
        if mutationTokens.contains(where: { text.contains($0) }) {
            return false
        }

        if element.type.contains("Cell") || element.type.contains("rawValue: 75") {
            return true
        }
        if element.type.contains("Link") || element.type.contains("rawValue: 39") {
            return true
        }
        if element.type.contains("Button") || element.type.contains("rawValue: 9") {
            return true
        }
        return false
    }

    private func prioritizeElements(
        _ elements: [SimpleElement],
        actionCounts: [String: Int],
        elementScreenPresence: [String: Set<String>],
        persistentThreshold: Int,
        screenBounds: CGRect
    ) -> [SimpleElement] {
        let bottomBarY = screenBounds.height > 0 ? screenBounds.height * 0.88 : 850.0

        return elements.sorted { a, b in
            let keyA = actionKey(for: a)
            let keyB = actionKey(for: b)

            let persistA = (elementScreenPresence[keyA]?.count ?? 0) >= persistentThreshold
            let persistB = (elementScreenPresence[keyB]?.count ?? 0) >= persistentThreshold
            if persistA != persistB { return !persistA }

            let navA = isLikelyExploratoryNavigation(a)
            let navB = isLikelyExploratoryNavigation(b)
            if navA != navB { return navA }

            let countA = actionCounts[keyA] ?? 0
            let countB = actionCounts[keyB] ?? 0
            if countA != countB { return countA < countB }

            let anonymousA = isAnonymousControl(a)
            let anonymousB = isAnonymousControl(b)
            if anonymousA != anonymousB { return !anonymousA }

            let inBarA = a.frame.midY > bottomBarY
            let inBarB = b.frame.midY > bottomBarY
            if inBarA != inBarB { return !inBarA }

            let submitA = isLikelyPrimarySubmitControl(a)
            let submitB = isLikelyPrimarySubmitControl(b)
            if submitA != submitB { return submitA }

            let pa = baseTypePriority(a.type)
            let pb = baseTypePriority(b.type)
            return pa > pb
        }
    }

    private func baseTypePriority(_ type: String) -> Int {
        if type.contains("Cell") || type.contains("rawValue: 75") { return 5 }
        if type.contains("Link") || type.contains("rawValue: 39") { return 4 }
        if type.contains("Button") || type.contains("rawValue: 9") { return 4 }
        if type.contains("SegmentedControl") || type.contains("Picker") { return 3 }
        if type.contains("TextField") || type.contains("rawValue: 49") || type.contains("rawValue: 50") { return 2 }
        if type.contains("Switch") || type.contains("Toggle") || type.contains("rawValue: 40") { return 1 }
        return 0
    }

    private func isLikelySubmitControl(_ element: SimpleElement) -> Bool {
        let text = (element.label + " " + element.identifier).lowercased()
        let submitTokens = [
            "continue", "next", "submit", "sign up", "create account",
            "register", "finish", "done", "save", "log in", "login", "sign in"
        ]
        let negativeTokens = [
            "with apple", "with google", "with facebook", "forgot", "help",
            "terms", "privacy", "learn more", "cancel", "back"
        ]
        guard submitTokens.contains(where: { text.contains($0) }) else { return false }
        return !negativeTokens.contains(where: { text.contains($0) })
    }

    /// Stricter than isLikelySubmitControl — used only to decide whether a "stayed on the same
    /// screen" outcome is a real failed submit/sign-in. Excludes ambiguous tokens like "done"/"next"
    /// that are commonly filter segments or toolbar buttons (which caused false positives).
    private func isStrongSubmitControl(_ element: SimpleElement) -> Bool {
        let text = (element.label + " " + element.identifier).lowercased()
        let strong = ["sign in", "sign-in", "log in", "login", "signin",
                      "sign up", "create account", "register", "submit", "continue", "save"]
        let negative = ["with apple", "with google", "with facebook", "forgot", "cancel", "back", "skip"]
        guard strong.contains(where: { text.contains($0) }) else { return false }
        return !negative.contains(where: { text.contains($0) })
    }

    /// A text field we haven't put a value into yet. The typed-keys guard is the loop-safety:
    /// once typed into on this screen (even if the value never shows in the a11y tree — custom
    /// fields), a field counts as filled, so form-completion steering always terminates. The set is
    /// screen-scoped because anonymous action keys (position buckets) collide across screens.
    private func fieldLooksUnfilled(_ element: SimpleElement, screen: String, typedKeys: Set<String>) -> Bool {
        guard !typedKeys.contains("\(screen)|\(actionKey(for: element))") else { return false }
        let value = element.value.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return true }
        // A filled SecureField renders its value as bullets; any other non-empty value on a
        // never-typed secure field is its placeholder showing through (common under the keyboard,
        // where placeholderValue isn't resolvable) — treat as unfilled. (Live consequence: the
        // signup submit was tapped before Confirm Password → "Passwords do not match.")
        if isSecureTextField(element.type) && !value.contains("•") { return true }
        // An empty field often reports its placeholder as the value.
        let placeholder = element.xcElement?.placeholderValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !placeholder.isEmpty && value == placeholder
    }

    /// Dismiss-style controls (Close/Cancel/X) that discard a form in progress. Deprioritized —
    /// never excluded — while unfilled fields remain, so they stay available as an escape hatch.
    private func isDismissControl(_ element: SimpleElement) -> Bool {
        let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let id = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let tokens: Set<String> = ["close", "cancel", "dismiss", "x", "xmark"]
        return tokens.contains(label) || tokens.contains(id) || id.hasPrefix("xmark.")
    }

    /// Controls whose effect happens in SYSTEM UI presented by another process — OAuth sign-in
    /// (ASAuthorizationController / ASWebAuthenticationSession) and Apple Pay sheets. Those never
    /// register in this app's accessibility tree, so "no visible change after tapping" is the
    /// EXPECTED outcome of a working control, not evidence of a dead one. Excluded from
    /// unresponsive-element detection (first real-app run flagged "Continue with Apple/Google").
    private func isSystemHandoffControl(_ label: String) -> Bool {
        let l = label.lowercased()
        if l.contains("apple pay") { return true }
        let verbs = ["continue with", "sign in with", "sign up with", "log in with", "login with"]
        let providers = ["apple", "google", "facebook", "twitter", "github", "microsoft", "amazon", "linkedin", "x"]
        for v in verbs where l.hasPrefix(v) {
            let rest = l.dropFirst(v.count).trimmingCharacters(in: .whitespaces)
            // Whole-word provider match ("apple", "apple id") — not a prefix, so e.g.
            // "continue with xfinity" is NOT treated as the "x" provider.
            let firstWord = rest.split(separator: " ").first.map(String.init) ?? rest
            if providers.contains(firstWord) { return true }
        }
        return false
    }

    /// Selection/value controls (segmented-control segments, stepper +/- buttons) legitimately
    /// produce no change when already-selected or at a boundary, so they must be excluded from
    /// "dead control" detection to avoid false positives.
    private func isSelectionOrValueControl(_ element: SimpleElement) -> Bool {
        if element.isSelected { return true }
        let name = (element.label + " " + element.identifier).lowercased()
        if name.contains("increment") || name.contains("decrement") { return true }
        // Reversible state-toggle buttons: their effect is a value/state flip that SwiftUI Forms
        // don't always reflect promptly in the accessibility tree, causing no-op false positives.
        let toggleVerbs = ["mark complete", "mark incomplete", "mark done", "mark as", "reopen",
                           "toggle", "favorite", "unfavorite", "follow", "unfollow", "like",
                           "show more", "show less", "read more", "expand", "collapse"]
        return toggleVerbs.contains { name.contains($0) }
    }

    /// True if the control sits inside a segmented control or picker — selecting a segment whose
    /// filtered result happens to look identical is not a "dead control". Uses live queries (only
    /// called when we're about to flag, so the cost is negligible).
    private func isInsideSelectionContainer(_ element: SimpleElement) -> Bool {
        let center = CGPoint(x: element.frame.midX, y: element.frame.midY)
        for container in app.segmentedControls.allElementsBoundByIndex where container.exists {
            if container.frame.contains(center) { return true }
        }
        for container in app.pickers.allElementsBoundByIndex where container.exists {
            if container.frame.contains(center) { return true }
        }
        // Calendar / date-picker cells ("Monday, June 1", "Month") select a value rather than
        // navigate — a tap legitimately changes nothing the value-blind hash can see, so they
        // must not be flagged as dead controls (observed: 4 FPs on one booking screen).
        for container in app.datePickers.allElementsBoundByIndex where container.exists {
            if container.frame.contains(center) { return true }
        }
        return false
    }

    private func isLikelyDismissControl(_ element: SimpleElement) -> Bool {
        let text = (element.label + " " + element.identifier).lowercased()
        let dismissTokens = ["done", "close", "cancel", "dismiss", "back", "skip", "not now"]
        let negative = ["delete", "remove", "reset", "logout"]
        guard dismissTokens.contains(where: { text.contains($0) }) else { return false }
        guard !negative.contains(where: { text.contains($0) }) else { return false }
        return element.type.contains("Button") || element.type.contains("rawValue: 9")
    }

    private func isLikelyPrimarySubmitControl(_ element: SimpleElement) -> Bool {
        guard isLikelySubmitControl(element) else { return false }
        guard element.type.contains("Button") || element.type.contains("rawValue: 9") else { return false }

        let screenHeight = screenBounds.height > 0 ? screenBounds.height : 1000
        // Primary CTA buttons are often lower half and wide.
        let lowerHalf = element.frame.midY > screenHeight * 0.45
        let wideEnough = element.frame.width > 120
        return lowerHalf || wideEnough
    }

    private func shouldDismissKeyboardForSubmit(elements: [SimpleElement]) -> Bool {
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists, keyboard.frame.height > 0 else { return false }
        let keyboardTop = keyboard.frame.minY

        return elements.contains { el in
            guard isLikelySubmitControl(el) else { return false }
            // If submit control is overlapped by keyboard, dismiss keyboard first.
            return el.frame.maxY >= keyboardTop - 8
        }
    }

    private func resolveTextElement(for element: SimpleElement, in app: XCUIApplication) -> XCUIElement? {
        if !element.identifier.isEmpty {
            let tf = app.textFields[element.identifier]
            if tf.exists { return tf }
            let stf = app.secureTextFields[element.identifier]
            if stf.exists { return stf }
        }

        let allTextFields = app.textFields.allElementsBoundByIndex + app.secureTextFields.allElementsBoundByIndex
        let tapped = CGPoint(x: element.frame.midX, y: element.frame.midY)
        return allTextFields
            .filter { $0.exists && $0.frame.width > 0 }
            .min(by: {
                let d1 = abs($0.frame.midX - tapped.x) + abs($0.frame.midY - tapped.y)
                let d2 = abs($1.frame.midX - tapped.x) + abs($1.frame.midY - tapped.y)
                return d1 < d2
            })
    }

    private func elementNeedsInput(_ element: SimpleElement, in app: XCUIApplication) -> Bool {
        guard isTextField(element.type) else { return false }
        guard let resolved = resolveTextElement(for: element, in: app), resolved.exists else { return true }

        guard let current = resolved.value as? String else { return true }
        let value = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return true }

        let placeholder = (resolved.placeholderValue ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let lower = value.lowercased()
        if !placeholder.isEmpty && lower == placeholder { return true }
        if lower == "optional" { return true }
        if lower.contains("enter ") && lower.contains("password") { return true }

        return false
    }

    private func performSmartAction(
        on element: SimpleElement,
        in app: XCUIApplication,
        screenTitle: String,
        inputOverrides: [String: String],
        elementTapCount: Int = 0,
        screenElements: [SimpleElement] = [],
        screenRole: String = ""
    ) -> String {
        let frame = element.frame
        guard frame.width > 0, frame.height > 0 else {
            return "skip_invalid_frame"
        }

        let coord = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: frame.midX, dy: frame.midY))

        if isTextField(element.type) {
            // Resolve the real XCUIElement so XCUITest can scroll it into view before tapping.
            // Coordinate taps cannot scroll and get fooled when the keyboard occludes lower
            // fields — that's why multi-field forms (e.g. Create Account) only filled the top
            // two fields. Tapping the resolved element auto-scrolls it above the keyboard.
            let resolvedField: XCUIElement? = {
                if let xc = element.xcElement, xc.exists { return xc }
                return resolveTextElement(for: element, in: app)
            }()

            if let field = resolvedField, field.exists {
                // If a keyboard from a previous field is occluding this one, drop it first so
                // the tap lands on the field rather than a key, then XCUITest scrolls it up.
                if app.keyboards.firstMatch.exists && !field.isHittable {
                    dismissKeyboardIfNeeded()
                    Thread.sleep(forTimeInterval: 0.25)
                }
                field.tap()
            } else {
                coord.tap()
            }
            Thread.sleep(forTimeInterval: 0.4)

            // Check if keyboard appeared — if not, the field didn't gain focus
            let keyboard = app.keyboards.firstMatch
            guard keyboard.waitForExistence(timeout: 1.5) else {
                let name = element.identifier.isEmpty ? element.label : element.identifier
                return "tap(\(name))_no_keyboard"
            }

            // Bare SwiftUI TextFields often expose NO label/identifier of their own — their meaning
            // lives in a nearby static text ("Email", "Full Name"). Use the same inference the
            // input-descriptor path uses, so the default value matches the field's purpose
            // (email → a real address) instead of a generic "test" that any validation rejects.
            let ownHint = (element.identifier + element.label).trimmingCharacters(in: .whitespacesAndNewlines)
            let inferredLabel = ownHint.isEmpty ? (inferFieldLabel(for: element, in: screenElements) ?? "") : ""
            let effectiveLabel = element.label.isEmpty ? inferredLabel : element.label
            let hint = (element.identifier + " " + element.label + " " + inferredLabel).lowercased()
            let isSecure = isSecureTextField(element.type) || hint.contains("password") || hint.contains("passcode")
            let testText: String
            var isOverride = false
            if let overrideValue = resolveInputOverride(screenTitle: screenTitle, element: element, overrides: inputOverrides), !overrideValue.isEmpty {
                testText = overrideValue
                isOverride = true
            } else {
                testText = defaultInputValue(label: effectiveLabel, identifier: element.identifier,
                                             secure: isSecure, screenRole: screenRole)
            }
            lastTypedWasOverride = isOverride
            lastTypedSecure = isSecure

            // Explicit, parseable marker of exactly what value was entered (masked if secure).
            let fieldName = element.identifier.isEmpty ? effectiveLabel : element.identifier
            let displayValue = isSecure ? String(repeating: "•", count: min(8, max(4, testText.count))) : testText
            print("OCQA_INPUT:{\"field\":\"\(escapeJSON(fieldName))\",\"value\":\"\(escapeJSON(displayValue))\",\"source\":\"\(isOverride ? "user_override" : "auto")\",\"secure\":\(isSecure),\"screen\":\"\(escapeJSON(screenTitle))\"}")
            if let field = resolvedField, field.exists {
                replaceText(on: field, with: testText)
            } else if let xcEl = element.xcElement, xcEl.exists {
                replaceText(on: xcEl, with: testText)
            } else if let resolved = resolveTextElement(for: element, in: app) {
                resolved.tap()
                Thread.sleep(forTimeInterval: 0.3)
                if keyboard.exists {
                    replaceText(on: resolved, with: testText)
                }
            }

            // The typed text is VISIBLE on screen — but does the field expose it to accessibility?
            // If its a11y value still reads empty (or just the placeholder), VoiceOver and any
            // accessibility-driven tooling see nothing: a real a11y defect, found live on a real
            // app's login form (custom-styled fields). Secure fields are exempt — masking is
            // intentional. One report per screen.
            if !isSecure, !testText.isEmpty, !valueHiddenReported.contains(screenTitle) {
                Thread.sleep(forTimeInterval: 0.2)
                let checkEl = (resolvedField?.exists == true) ? resolvedField : resolveTextElement(for: element, in: app)
                if let checkEl, checkEl.exists {
                    let v = ((checkEl.value as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let ph = (checkEl.placeholderValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if v.isEmpty || v == ph {
                        valueHiddenReported.insert(screenTitle)
                        let issueTitle = "Field content invisible to accessibility: \(screenTitle)"
                        print("OCQA_ISSUE:{\"type\":\"a11y_value_hidden\",\"severity\":\"low\",\"title\":\"\(escapeJSON(issueTitle))\",\"screen\":\"\(escapeJSON(screenTitle))\",\"desc\":\"Text typed into a field on '\(escapeJSON(screenTitle))' is visible on screen but the field's accessibility value reads empty — invisible to VoiceOver and accessibility tooling.\"}")
                    }
                }
            }

            // Try to advance focus to the next field or dismiss keyboard where supported.
            if keyboard.exists {
                for key in ["Next", "Done", "Go", "Return", "Continue"] {
                    let keyButton = keyboard.buttons[key]
                    if keyButton.exists && keyButton.isHittable {
                        keyButton.tap()
                        Thread.sleep(forTimeInterval: 0.2)
                        break
                    }
                }
            }
            let name = element.identifier.isEmpty ? element.label : element.identifier
            return "type(\(name), \"\(testText)\")"
        }

        // Long-press for cells and images (context menus, quick actions)
        // Only long-press after we've tapped this element at least twice without nav change
        let longPressTypes = ["Cell", "Image"]
        if longPressTypes.contains(element.type) && elementTapCount >= 2 {
            coord.press(forDuration: 1.2)
            let name = element.identifier.isEmpty ? element.label : element.identifier
            return "long_press(\(name))"
        }



        coord.tap()
        return "tap(\(element.identifier.isEmpty ? element.label : element.identifier))"
    }

    /// Attempt a swipe-left or swipe-right gesture on the given element (carousel/onboarding).
    private func performSwipeLateral(on element: SimpleElement, in app: XCUIApplication, direction: String) -> String {
        let frame = element.frame
        let startX: CGFloat = direction == "left" ? frame.maxX - 10 : frame.minX + 10
        let endX: CGFloat = direction == "left" ? frame.minX + 10 : frame.maxX - 10
        let midY = frame.midY
        let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: startX, dy: midY))
        let end = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: endX, dy: midY))
        start.press(forDuration: 0.05, thenDragTo: end)
        let name = element.identifier.isEmpty ? element.label : element.identifier
        return "swipe_\(direction)(\(name))"
    }

    /// Full-width leftward swipe across the screen middle — advances a paged carousel.
    private func swipeScreenLeft() {
        let midY = screenBounds.height > 0 ? screenBounds.height / 2 : 400
        let w = screenBounds.width > 0 ? screenBounds.width : 390
        let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: w * 0.85, dy: midY))
        let end = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: w * 0.15, dy: midY))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    /// Attempt an edge-swipe from the left edge (drawer/hamburger reveal).
    private func performEdgeSwipeLeft(in app: XCUIApplication) -> String {
        let midY = screenBounds.height > 0 ? screenBounds.height / 2 : 400
        let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 5, dy: midY))
        let end = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: screenBounds.width * 0.6, dy: midY))
        start.press(forDuration: 0.05, thenDragTo: end)
        return "edge_swipe_right"
    }

    private func tryGoBack() -> Bool {
        // Try navigation bar back button
        let backButtons = app.navigationBars.buttons
        if backButtons.count > 0 {
            let first = backButtons.firstMatch
            if first.exists && first.isHittable {
                first.tap()
                Thread.sleep(forTimeInterval: 0.5)
                return true
            }
        }
        // Try common dismiss buttons (expanded set)
        for label in ["Close", "Cancel", "Done", "Dismiss", "Back", "X", "close"] {
            let btn = app.buttons[label]
            if btn.exists && btn.isHittable {
                btn.tap()
                Thread.sleep(forTimeInterval: 0.5)
                return true
            }
        }
        // Try swipe-down to dismiss sheets/modals
        let swipeStart = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        let swipeEnd = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
        swipeStart.press(forDuration: 0.1, thenDragTo: swipeEnd)
        Thread.sleep(forTimeInterval: 0.5)
        return false // can't know if swipe worked — caller should verify
    }

    private func performScroll(in app: XCUIApplication, upward: Bool) -> String {
        let startY: CGFloat = upward ? 0.78 : 0.28
        let endY: CGFloat = upward ? 0.30 : 0.78
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: startY))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: endY))
        start.press(forDuration: 0.05, thenDragTo: end)
        return upward ? "scroll_up" : "scroll_down"
    }

    private func performCoordinateTap(in app: XCUIApplication, at point: CGPoint, label: String) -> String {
        let coord = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: point.x, dy: point.y))
        coord.tap()
        return "tap(\(label))"
    }

    /// Wait for UI element count to stabilize (animations settled, content loaded).
    /// Polls every 200ms; exits early when count is stable for 2 consecutive reads or timeout reached.
    @discardableResult
    private func waitForUIStability(timeout: TimeInterval = 2.0) -> Int {
        let deadline = Date().addingTimeInterval(timeout)
        var previousCount = -1
        var stableCount = 0
        while Date() < deadline {
            // If the app died (e.g. it crashed on the action we just performed), stop polling
            // immediately. Querying a non-running app throws an XCTest failure that would abort the
            // whole run — instead we return and let the main loop's crash detection report it.
            guard app.state == .runningForeground else { return previousCount }
            let count = app.descendants(matching: .any).count
            if count == previousCount {
                stableCount += 1
                if stableCount >= 2 { return count }
            } else {
                stableCount = 0
            }
            previousCount = count
            Thread.sleep(forTimeInterval: 0.2)
        }
        return previousCount
    }

    private func waitForAnimationsToSettle() {
        waitForUIStability(timeout: 1.2)
    }

    /// Wait for the result of a form/login submission: poll until the screen changes (success
    /// navigation or inline error) and no activity indicator/"loading" spinner remains, up to
    /// `timeout`. Avoids racing ahead while a network request is still in flight.
    private func waitForSubmitResult(previousHash: String, timeout: TimeInterval = 8.0) {
        let deadline = Date().addingTimeInterval(timeout)
        var settledAfterChange = false
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
            // Treat a visible spinner or progress indicator as "still working".
            let busy = app.activityIndicators.firstMatch.exists
                || app.progressIndicators.firstMatch.exists
            let elements = readUITree(app)
            if elements.isEmpty { continue }
            let newHash = computeHash(elements)
            if newHash != previousHash {
                // Screen changed — let it settle one more beat, then stop waiting.
                if !busy {
                    if settledAfterChange { return }
                    settledAfterChange = true
                }
            } else if busy {
                settledAfterChange = false
            }
        }
    }

    /// Frame of the on-screen keyboard, or .zero if none. Used to keep keyboard keys out of the
    /// tappable-candidate pool.
    private func keyboardFrame() -> CGRect {
        let kb = app.keyboards.firstMatch
        return kb.exists ? kb.frame : .zero
    }

    /// True when the screen is in a "settled" resting state — no on-screen keyboard and no open
    /// transient overlay (menu / dropdown / popover / sheet / picker wheel). A screenshot taken while
    /// one of these is up is inherently ambiguous to a visual reviewer (the keyboard "covers" the
    /// form, an open menu "overlaps" content) and is the dominant source of vision false positives, so
    /// the post-run vision pass prefers settled captures. Emitted as `settled` on OCQA_STATE.
    private func isScreenSettled() -> Bool {
        if app.keyboards.firstMatch.exists { return false }
        if app.sheets.firstMatch.exists { return false }
        if app.popovers.firstMatch.exists { return false }
        if app.menus.firstMatch.exists { return false }
        if app.pickerWheels.firstMatch.exists { return false }
        return true
    }

    /// True if the current screen is scrollable (ScrollView / List-Form table / collection), so
    /// below-the-fold content can be revealed by scrolling.
    private func isScrollableScreen() -> Bool {
        app.scrollViews.firstMatch.exists || app.tables.firstMatch.exists || app.collectionViews.firstMatch.exists
    }

    private func dismissKeyboardIfNeeded() {
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists && keyboard.frame.height > 0 else { return }
        // The return key's label varies by iOS version and submitLabel (Done/Return/Go/Next,
        // upper- or lowercase) — match case-insensitively via the label list.
        for key in ["Done", "Return", "Go", "Next", "done", "return", "go", "next"] {
            let keyButton = keyboard.buttons[key]
            if keyButton.exists && keyButton.isHittable {
                keyButton.tap()
                Thread.sleep(forTimeInterval: 0.25)
                if !app.keyboards.firstMatch.exists { return }
                break // key existed but the keyboard stayed (focus advanced) — fall through
            }
        }
        // Send a literal return to the focused field. Unlike tapping "just above the keyboard"
        // (which can land on ANOTHER text field and keep the keyboard up — observed on a real
        // signup sheet), this reaches the first responder; with submitLabel done/go it also ends
        // editing. MUST verify something actually has focus first: typeText without a first
        // responder throws an event-synthesis exception that ABORTS THE ENTIRE TEST even with
        // continueAfterFailure=true (observed: a system Markup sheet reported a keyboard with no
        // focused field, ending a real-app run at 17/70 actions).
        if app.keyboards.firstMatch.exists {
            let focused = app.descendants(matching: .any)
                .matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
            if focused.exists {
                focused.typeText("\n")
                Thread.sleep(forTimeInterval: 0.25)
            }
        }
    }

    private func escapeJSON(_ str: String) -> String {
        return str
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "'")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\t", with: " ")
    }

    private func normalizeKey(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    private func inputFieldKey(for element: SimpleElement) -> String {
        let id = normalizeKey(element.identifier)
        if !id.isEmpty {
            return "id:\(id)"
        }

        let label = normalizeKey(element.label)
        if !label.isEmpty {
            return "label:\(label)"
        }

        return "coord:\(Int(element.frame.midX))x\(Int(element.frame.midY))"
    }

    private func resolveInputOverride(
        screenTitle: String,
        element: SimpleElement,
        overrides: [String: String]
    ) -> String? {
        let screen = normalizeKey(screenTitle)
        let fieldKey = inputFieldKey(for: element)

        let scopedKey = "screen:\(screen)|\(fieldKey)"
        if let value = overrides[scopedKey], !value.isEmpty {
            return value
        }
        if let value = overrides[fieldKey], !value.isEmpty {
            return value
        }
        return nil
    }

    /// The value the harness auto-types into a field when there's no user override. Extracted so
    /// the interactive prompt can display the same default the harness would actually use.
    private func defaultInputValue(label: String, identifier: String, secure: Bool, screenRole: String = "") -> String {
        let hint = (identifier + " " + label).lowercased()
        if hint.contains("email") || hint.contains("e-mail") {
            return resolve("OCQA_TEST_EMAIL", fallback: "test@example.com")
        } else if secure {
            // Any secure field gets the configured password — even when it exposes no
            // "password" hint (common: a bare SecureTextField with no identifier/placeholder).
            return resolve("OCQA_TEST_PASSWORD", fallback: "TestPass123!")
        } else if hint.contains("phone") || hint.contains("mobile") {
            return "5551234567"
        } else if hint.contains("name") || hint.contains("first") || hint.contains("last") {
            return "Test User"
        } else if hint.contains("zip") || hint.contains("postal") {
            return "90210"
        } else if hint.contains("weight") {
            return "170"
        } else if hint.contains("height") {
            return "68"
        } else if hint.contains("age") || hint.contains("years") {
            return "30"
        } else if hint.contains("(lbs") || hint.contains("(kg") || hint.contains("(cm") || hint.contains("(in)") {
            // Unit-suffixed numeric fields ("Current Weight (lbs)") reject text outright.
            return "50"
        } else if hint.contains("search") {
            return "test"
        } else if screenRole == "login" || screenRole == "signup" {
            // An un-hinted plain field on a credentials screen is almost always the email/username
            // — "test" fails server-side validation everywhere, an address passes both. (Real-app
            // run: a signup email field whose nearest static text was the screen TITLE got "test",
            // so the account could never be created.)
            return resolve("OCQA_TEST_EMAIL", fallback: "test@example.com")
        } else {
            return "test"
        }
    }

    /// True when neither a screen-scoped nor a global override exists for this field key.
    private func hasNoOverride(key: String, screen: String, in overrides: [String: String]) -> Bool {
        let scoped = "screen:\(normalizeKey(screen))|\(key)"
        return (overrides[scoped]?.isEmpty ?? true) && (overrides[key]?.isEmpty ?? true)
    }

    /// Pauses exploration and blocks until the host writes field values to `responsePath` (or the
    /// fallback timeout elapses). Submitted values are merged into `overrides` (screen-scoped) so
    /// the normal typing path picks them up via `resolveInputOverride`. Never hangs: on timeout it
    /// falls back to auto-defaults and disables further prompting for the rest of the run.
    /// Returns the resolved action ("submit" / "defaults" / "skip" / "dont_ask" / "timeout") so
    /// callers (e.g. the login preamble) can branch on it.
    @discardableResult
    private func awaitInteractiveInput(
        requestId: String,
        screenTitle: String,
        descriptors: [InputDescriptor],
        responsePath: String,
        waitTimeout: Double,
        overrides: inout [String: String],
        totalWaitSeconds: inout Double,
        dontAskAgain: inout Bool,
        interactiveEnabled: inout Bool
    ) -> String {
        // Clear any stale response left over from a previous request.
        try? FileManager.default.removeItem(atPath: responsePath)

        let fieldsJson = descriptors.map { d -> String in
            // Secure fields never carry a default over stdout (it would log the auto-password).
            let def = d.secure ? "" : defaultInputValue(label: d.label, identifier: d.key, secure: d.secure)
            return "{\"key\":\"\(escapeJSON(d.key))\",\"label\":\"\(escapeJSON(d.label))\",\"secure\":\(d.secure ? "true" : "false"),\"placeholder\":\"\(escapeJSON(d.placeholder))\",\"default\":\"\(escapeJSON(def))\"}"
        }.joined(separator: ",")
        print("OCQA_AWAIT_INPUT:{\"requestId\":\"\(requestId)\",\"screen\":\"\(escapeJSON(screenTitle))\",\"fields\":[\(fieldsJson)]}")

        let start = Date()
        var resolvedAction = "timeout"
        while Date().timeIntervalSince(start) < waitTimeout {
            Thread.sleep(forTimeInterval: 0.5)
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: responsePath)),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            // Only honor a response that targets the current request; drop stale ones.
            guard (obj["requestId"] as? String) == requestId else {
                try? FileManager.default.removeItem(atPath: responsePath)
                continue
            }
            let action = (obj["action"] as? String) ?? "defaults"
            if action == "submit", let values = obj["values"] as? [String: String] {
                let screen = normalizeKey(screenTitle)
                for (key, value) in values where !value.isEmpty {
                    overrides["screen:\(screen)|\(key)"] = value
                }
            } else if action == "dont_ask" {
                dontAskAgain = true
            }
            resolvedAction = action
            try? FileManager.default.removeItem(atPath: responsePath)
            break
        }
        if resolvedAction == "timeout" {
            // Host never answered — assume the UI is gone and stop prompting for the rest of the run.
            interactiveEnabled = false
        }
        totalWaitSeconds += Date().timeIntervalSince(start)
        print("OCQA_INPUT_RESOLVED:{\"requestId\":\"\(requestId)\",\"action\":\"\(resolvedAction)\"}")
        return resolvedAction
    }

    /// In-loop vision escalation. Screenshots the current screen, asks the host (via
    /// OCQA_VISION_QUERY) for the single best next action, and executes the reply. The model call
    /// happens HOST-side; the harness only requests and acts. Returns true if it performed an action
    /// (caller should `continue`), false on "none"/timeout (caller falls through to its bail path).
    private func visionEscalate(
        app: XCUIApplication,
        screenTitle: String,
        reason: String,
        actionCount: inout Int,
        usedCount: inout Int,
        responsePath: String,
        imageDir: String,
        waitTimeout: Double
    ) -> Bool {
        usedCount += 1
        let requestId = UUID().uuidString

        // Capture the screen to a host-readable PNG (the sim shares the host filesystem).
        let dir = imageDir.isEmpty ? NSTemporaryDirectory() : imageDir
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let imagePath = (dir as NSString).appendingPathComponent("vision-\(requestId).png")
        let pngWritten = (try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: imagePath))) != nil
        guard pngWritten else { return false }

        print("OCQA_VISION_QUERY:{\"requestId\":\"\(requestId)\",\"screen\":\"\(escapeJSON(screenTitle))\",\"image\":\"\(escapeJSON(imagePath))\",\"reason\":\"\(reason)\",\"step\":\(actionCount)}")

        let decision = awaitVisionDecision(requestId: requestId, responsePath: responsePath, waitTimeout: waitTimeout)
        let esc = escapeJSON(screenTitle)

        func logAction(_ type: String, _ narrative: String) {
            actionCount += 1
            print("OCQA_ACTION:{\"type\":\"\(type)\",\"reason\":\"vision_escalation\",\"step\":\(actionCount),\"screen\":\"\(esc)\",\"narrative\":\"\(escapeJSON(narrative))\"}")
        }

        switch decision.action {
        case "tap":
            let x = min(max(decision.x, 0.0), 1.0)
            let y = min(max(decision.y, 0.0), 1.0)
            app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap()
            logAction("tap", "AI vision suggested tapping here to get unstuck.")
            Thread.sleep(forTimeInterval: 0.7)
            return true
        case "swipe_up":
            app.swipeUp()
            logAction("swipe", "AI vision suggested swiping up to reveal more content.")
            Thread.sleep(forTimeInterval: 0.5)
            return true
        case "swipe_down":
            app.swipeDown()
            logAction("swipe", "AI vision suggested swiping down.")
            Thread.sleep(forTimeInterval: 0.5)
            return true
        case "back":
            _ = tryGoBack()
            logAction("navigate", "AI vision suggested leaving this dead-end screen.")
            return true
        default:
            return false // "none" / timeout — nothing actionable; caller falls through.
        }
    }

    private struct VisionDecision { let action: String; let x: CGFloat; let y: CGFloat }

    /// Polls `responsePath` for the host's vision decision (same file-channel shape as interactive
    /// input). On timeout returns a "none" decision so the caller falls back to its bail path.
    private func awaitVisionDecision(requestId: String, responsePath: String, waitTimeout: Double) -> VisionDecision {
        try? FileManager.default.removeItem(atPath: responsePath)
        let start = Date()
        while Date().timeIntervalSince(start) < waitTimeout {
            Thread.sleep(forTimeInterval: 0.4)
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: responsePath)),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (obj["requestId"] as? String) == requestId else { continue }
            let action = (obj["action"] as? String) ?? "none"
            let x = CGFloat((obj["x"] as? Double) ?? 0.5)
            let y = CGFloat((obj["y"] as? Double) ?? 0.5)
            try? FileManager.default.removeItem(atPath: responsePath)
            print("OCQA_VISION_RESOLVED:{\"requestId\":\"\(requestId)\",\"action\":\"\(action)\"}")
            return VisionDecision(action: action, x: x, y: y)
        }
        print("OCQA_VISION_RESOLVED:{\"requestId\":\"\(requestId)\",\"action\":\"timeout\"}")
        return VisionDecision(action: "none", x: 0.5, y: 0.5)
    }

    private func detectInputDescriptors(in elements: [SimpleElement]) -> [InputDescriptor] {
        var seenKeys = Set<String>()
        var descriptors: [InputDescriptor] = []

        for element in elements where isTextField(element.type) {
            let key = inputFieldKey(for: element)
            if seenKeys.contains(key) { continue }
            seenKeys.insert(key)

            let inferredLabel = inferFieldLabel(for: element, in: elements)
            let rawLabel = normalizeVisibleText(element.label)
            let rawId = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
            let placeholder = element.xcElement?.placeholderValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let fallback = "Field \(descriptors.count + 1)"
            // A field's OWN accessibility label/placeholder is authoritative; only fall back to a
            // nearby static text (inferred) when the field exposes neither. Avoids mislabeling e.g.
            // a web search box as the link sitting above it.
            let ownLabel = !rawLabel.isEmpty ? rawLabel : placeholder
            let displayLabel = !ownLabel.isEmpty ? ownLabel : (inferredLabel ?? (!rawId.isEmpty ? rawId : fallback))
            let secure = isSecureTextField(element.type) || rawId.lowercased().contains("password")

            descriptors.append(InputDescriptor(
                key: key,
                label: displayLabel,
                secure: secure,
                placeholder: placeholder
            ))
        }

        return descriptors
    }

    private func inferFieldLabel(for field: SimpleElement, in elements: [SimpleElement]) -> String? {
        let screenWidth = screenBounds.width > 0 ? screenBounds.width : 390
        let candidates = elements
            .filter { isStaticTextType($0.type) }
            .map { ($0, normalizeVisibleText($0.label)) }
            .filter { !$0.1.isEmpty && isLikelyFieldLabel($0.1) }

        var best: (label: String, score: CGFloat)?

        for (candidate, text) in candidates {
            let verticalGap = field.frame.minY - candidate.frame.maxY
            if verticalGap < -4 || verticalGap > 120 {
                continue
            }

            let overlap = max(0, min(field.frame.maxX, candidate.frame.maxX) - max(field.frame.minX, candidate.frame.minX))
            let minWidth = min(field.frame.width, candidate.frame.width)
            let overlapRatio = minWidth > 0 ? overlap / minWidth : 0
            let centerDelta = abs(field.frame.midX - candidate.frame.midX)

            if overlapRatio < 0.2 && centerDelta > field.frame.width * 0.8 {
                continue
            }

            var score = verticalGap + centerDelta * 0.08
            if candidate.frame.width > screenWidth * 0.55 {
                score += 40
            }

            if best == nil || score < best!.score {
                best = (text, score)
            }
        }

        return best?.label
    }

    private func isStaticTextType(_ type: String) -> Bool {
        type.contains("rawValue: 48") || type.contains("StaticText")
    }

    private func normalizeVisibleText(_ raw: String) -> String {
        raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
    }

    private func isLikelyTitleText(_ text: String) -> Bool {
        let lower = text.lowercased()
        if text.count < 2 || text.count > 60 { return false }
        if lower.contains("powered by") { return false }
        if lower == "optional" { return false }
        if lower.contains("@") { return false }
        // React Native / Expo DEBUG overlays (RCTDevLoadingView, dev menu) are not app screens.
        if lower.contains("connect to metro") || lower.contains("metro to develop")
            || lower.contains("reload") && lower.contains("javascript") { return false }
        // Feed content leaking as a "title": timestamps/metadata start with punctuation or a
        // symbol ("⸱ 3h"), and machine ids are never titles (observed on a content-feed app).
        if let first = text.unicodeScalars.first, !CharacterSet.alphanumerics.contains(first) { return false }
        if isMangledTypeName(text) { return false }
        return true
    }

    private func isLikelyFieldLabel(_ text: String) -> Bool {
        let lower = text.lowercased()
        if text.count < 2 || text.count > 40 { return false }
        if lower.contains("welcome") || lower.contains("create account") || lower.contains("sign in") { return false }
        if lower.contains("powered by") { return false }
        return true
    }

    // MARK: - Narration

    /// True for accessibility labels that are really SF Symbol identifiers (e.g. "hand.wave.fill")
    /// rather than human words — these leak when an icon control has no title, and read as noise.
    private func isSymbolLikeLabel(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return false }
        // Private-use-area glyphs (SF Symbols rendered as text, e.g. "􀮷􀮷􀮷") — an icon, not a
        // human label (observed flagged as a "dead control" on a content-feed app).
        let puaScalars = t.unicodeScalars.filter {
            (0xE000...0xF8FF).contains($0.value) || (0xF0000...0xFFFFD).contains($0.value) || (0x100000...0x10FFFD).contains($0.value)
        }.count
        if puaScalars * 2 >= t.unicodeScalars.count { return true }
        guard !t.contains(" "), t.contains(".") else { return false }
        return t.range(of: "^[a-z0-9]+(\\.[a-z0-9]+)+$", options: .regularExpression) != nil
    }

    /// Ordered, de-duplicated, human-meaningful on-screen text, top-to-bottom. This is the
    /// actual wording a user reads — the single richest deterministic signal about a screen.
    /// A fuller text inventory for the vision reviewer's accessibility context — the FULL a11y label
    /// of each static-text element (up to 120 chars, so long subtitles that VISUALLY truncate are
    /// still captured in full), sorted top-to-bottom, bounded. Distinct from collectVisibleTexts
    /// (capped at 60 for narration): the point here is to let the vision model confirm that text it
    /// sees cut off actually exists in full (i.e. is only scrolled off-screen, not clipped).
    private func visionTextInventory(_ elements: [SimpleElement], limit: Int = 30) -> [String] {
        var seen = Set<String>()
        var result: [(text: String, y: CGFloat)] = []
        for el in elements where isStaticTextType(el.type) {
            let text = normalizeVisibleText(el.label)
            guard text.count >= 2, text.count <= 120 else { continue }
            let lower = text.lowercased()
            if lower == "optional" { continue }
            if !text.contains(where: { $0.isLetter || $0.isNumber }) { continue }
            if seen.contains(lower) { continue }
            seen.insert(lower)
            result.append((text, el.frame.minY))
        }
        return Array(result.sorted { $0.y < $1.y }.map { $0.text }.prefix(limit))
    }

    private func collectVisibleTexts(_ elements: [SimpleElement], limit: Int = 10) -> [String] {
        var seen = Set<String>()
        var result: [(text: String, y: CGFloat)] = []
        for el in elements where isStaticTextType(el.type) {
            let text = normalizeVisibleText(el.label)
            guard text.count >= 2, text.count <= 60 else { continue }
            let lower = text.lowercased()
            if lower == "optional" { continue }
            // Skip pure punctuation / separators with no letters or digits.
            if !text.contains(where: { $0.isLetter || $0.isNumber }) { continue }
            if seen.contains(lower) { continue }
            seen.insert(lower)
            result.append((text, el.frame.minY))
        }
        return Array(result.sorted { $0.y < $1.y }.map { $0.text }.prefix(limit))
    }

    /// Returns the first visible error/failure message on screen, or nil. Curated, high-precision
    /// phrases only — empty states ("No posts yet") are deliberately NOT errors.
    private func detectErrorSurface(_ elements: [SimpleElement]) -> String? {
        let errorPhrases = [
            "something went wrong", "an error occurred", "an error has occurred", "an unexpected error",
            "failed to load", "couldn't load", "could not load", "unable to load", "unable to connect",
            "no internet", "no connection", "not connected", "you're offline", "you are offline",
            "connection lost", "connection error", "network error",
            "request failed", "request timed out", "server error", "internal server error",
            "please try again", "try again later",
            // Validation / auth failures surfaced to the user (found live: a raw Firebase
            // "credential is malformed or has expired" and a "Passwords do not match." both
            // slipped past the network-centric list above).
            "do not match", "does not match", "malformed",
            "invalid email", "invalid password", "incorrect password", "incorrect email",
            "already in use", "authentication failed", "auth failed"
        ]
        for el in elements where isStaticTextType(el.type) {
            let text = normalizeVisibleText(el.label)
            let lower = text.lowercased()
            guard lower.count >= 4, lower.count <= 140 else { continue }
            if errorPhrases.contains(where: { lower.contains($0) }) {
                return text
            }
        }
        return nil
    }

    /// Human description of an unlabeled control by kind + position, e.g. "an unlabeled row
    /// near the top" — so the chat still says something useful instead of "an element".
    private func describeAnonymous(_ element: SimpleElement) -> String {
        let kind: String
        if element.type.contains("Cell") || element.type.contains("rawValue: 75") { kind = "row" }
        else if element.type.contains("Switch") || element.type.contains("Toggle") || element.type.contains("rawValue: 40") { kind = "toggle" }
        else if element.type.contains("Link") || element.type.contains("rawValue: 39") { kind = "link" }
        else if element.type.contains("Button") || element.type.contains("rawValue: 9") { kind = "button" }
        else if element.type.contains("Image") { kind = "image" }
        else if isTextField(element.type) { kind = "field" }
        else { kind = "control" }

        let h = screenBounds.height > 0 ? screenBounds.height : 900
        let w = screenBounds.width > 0 ? screenBounds.width : 390
        let vy = element.frame.midY / h
        let vx = element.frame.midX / w
        let vBand = vy < 0.33 ? "top" : (vy < 0.66 ? "middle" : "bottom")
        let hBand = vx < 0.33 ? "-left" : (vx < 0.66 ? "" : "-right")
        return "an unlabeled \(kind) at the \(vBand)\(hBand) of the screen"
    }

    /// Human caption for the harness's recovery / navigation actions — the ones that aren't a
    /// direct tap/type on a labeled control. Without these the chat falls back to raw targets
    /// like "tab_bar_pos_0", which tell the user nothing.
    private func recoveryNarrative(_ kind: String, screen: String, to dest: String? = nil) -> String {
        let here = screen.isEmpty || screen == "Unknown" ? "this screen" : "the \(screen) screen"
        let there: String = {
            if let d = dest, !d.isEmpty, d != "Unknown" { return "the \(d) screen" }
            return "the previous screen"
        }()
        switch kind {
        case "tab_rotation", "tab_rotation_warmup":
            return "Switching to another tab to explore a different section of the app."
        case "keyboard_dismiss":
            return "Dismissing the keyboard to reach the button underneath it."
        case "dead_end_tab_escape", "blind_tab_escape":
            return "Nothing left to interact with on \(here) — tapping the tab bar to find new screens."
        case "back_dead_end", "back_exhausted":
            return "Finished with \(here) — going back to \(there)."
        case "back_same_title":
            return "Going back from \(here) to look for unexplored areas."
        case "back_failed":
            return "Tried to go back from \(here) but stayed put — looking for another way out."
        case "swipe_back":
            return "Swiping back from \(here) to \(there)."
        case "scroll_reveal":
            return "Scrolling to reveal more content on \(here)."
        case "scroll_back":
            return "Scrolling back up on \(here)."
        case "center_probe":
            return "Probing an unlabeled area of \(here) for hidden controls."
        case "carousel_probe":
            return "Swiping sideways on \(here) in case it's a carousel."
        case "drawer_probe":
            return "Edge-swiping on \(here) to check for a side menu."
        case "swipe_dismiss":
            return "Swiping down to dismiss a sheet on \(here)."
        default:
            return "Exploring \(here)."
        }
    }

    /// Emit a "navigation trap" finding when exploration genuinely can't leave a screen by any
    /// means — a real "user could get stuck here" problem. De-duped per screen.
    private func emitNavigationTrap(titleStr: String, escapedTitle: String, step: Int,
                                   reported: inout Set<String>,
                                   issues: inout [(type: String, severity: String, title: String, desc: String)]) {
        let key = "trap:\(titleStr)"
        guard !reported.contains(key) else { return }
        reported.insert(key)
        let title = "Stuck on '\(titleStr)' — no way forward or back"
        issues.append((type: "navigation_trap", severity: "medium", title: title,
                       desc: "Exploration could not navigate away from '\(titleStr)' by any means (no controls, can't go back, can't dismiss) — users may get trapped here."))
        print("OCQA_ISSUE:{\"type\":\"navigation_trap\",\"severity\":\"medium\",\"title\":\"\(escapeJSON(title))\",\"screen\":\"\(escapedTitle)\",\"step\":\(step)}")
    }

    private func classifyScreenRole(
        title: String,
        elements: [SimpleElement],
        inputs: [InputDescriptor],
        interactable: [SimpleElement]
    ) -> String {
        let titleLower = title.lowercased()
        let buttonLabels = interactable
            .filter { $0.type.contains("Button") || $0.type.contains("rawValue: 9") }
            .map { ($0.label + " " + $0.identifier).lowercased() }
        let allText = (buttonLabels + [titleLower]).joined(separator: " ")
        let hasSecure = inputs.contains(where: { $0.secure })
        let hasEmail = inputs.contains { $0.label.lowercased().contains("email") || $0.placeholder.lowercased().contains("email") || $0.key.contains("email") }

        if hasSecure && (hasEmail || allText.contains("sign in") || allText.contains("log in") || allText.contains("login")) {
            return "login"
        }
        if hasSecure && (allText.contains("sign up") || allText.contains("create account") || allText.contains("register")) {
            return "signup"
        }
        if titleLower.contains("settings") || allText.contains("preferences") {
            return "settings"
        }
        if titleLower.contains("profile") || allText.contains("edit profile") {
            return "profile"
        }
        if titleLower.contains("welcome") || allText.contains("get started") || allText.contains("continue") && inputs.isEmpty && interactable.count <= 4 {
            return "onboarding"
        }
        let cellCount = elements.filter { $0.type.contains("Cell") || $0.type.contains("rawValue: 75") }.count
        if cellCount >= 4 {
            return "list"
        }
        if !inputs.isEmpty {
            return "form"
        }
        if cellCount >= 1 {
            return "detail"
        }
        return "screen"
    }

    private func describeScreen(
        title: String,
        role: String,
        elements: [SimpleElement],
        inputs: [InputDescriptor],
        interactable: [SimpleElement]
    ) -> String {
        let safeTitle = title.isEmpty || title == "Unknown" ? "this screen" : "the \(title) screen"
        let buttons = interactable
            .filter { $0.type.contains("Button") || $0.type.contains("rawValue: 9") }
            .compactMap { btn -> String? in
                let raw = btn.label.isEmpty ? btn.identifier : btn.label
                let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty, trimmed.count <= 30, !isSymbolLikeLabel(trimmed) else { return nil }
                return trimmed
            }
        let dedupedButtons = Array(NSOrderedSet(array: buttons)) as? [String] ?? []
        let primaryButtons = Array(dedupedButtons.prefix(4))
        let cellCount = elements.filter { $0.type.contains("Cell") || $0.type.contains("rawValue: 75") }.count
        let fieldNames = inputs.prefix(4).map { $0.label }

        var pieces: [String] = []
        switch role {
        case "login":
            pieces.append("Looking at \(safeTitle), which asks for credentials.")
        case "signup":
            pieces.append("Looking at \(safeTitle), a sign-up form.")
        case "settings":
            pieces.append("Looking at \(safeTitle), exposing app preferences.")
        case "profile":
            pieces.append("Looking at \(safeTitle), showing the user's profile.")
        case "onboarding":
            pieces.append("Looking at \(safeTitle), an onboarding step.")
        case "list":
            pieces.append("Looking at \(safeTitle), a list of \(cellCount) items.")
        case "form":
            pieces.append("Looking at \(safeTitle), a form to fill out.")
        case "detail":
            pieces.append("Looking at \(safeTitle), a detail view.")
        default:
            pieces.append("Looking at \(safeTitle).")
        }

        // The actual words on screen — exclude text already echoed as the title, a field
        // label, or a button label so we don't repeat ourselves.
        var exclude = Set<String>([title.lowercased()])
        fieldNames.forEach { exclude.insert($0.lowercased()) }
        dedupedButtons.forEach { exclude.insert($0.lowercased()) }
        let content = collectVisibleTexts(elements).filter { !exclude.contains($0.lowercased()) }
        if !content.isEmpty {
            let shown = content.prefix(5).map { "“\($0)”" }.joined(separator: ", ")
            pieces.append("On screen: \(shown).")
        }

        if !fieldNames.isEmpty {
            pieces.append("Fields: \(fieldNames.joined(separator: ", ")).")
        }
        if !primaryButtons.isEmpty {
            pieces.append("Actions: \(primaryButtons.joined(separator: ", ")).")
        }

        // Switch / toggle states (on/off) — deterministic via the element's value, and
        // genuinely useful QA signal.
        let toggles = interactable
            .filter { $0.type.contains("Switch") || $0.type.contains("Toggle") || $0.type.contains("rawValue: 40") }
            .compactMap { sw -> String? in
                let name = (sw.label.isEmpty ? sw.identifier : sw.label).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty, name.count <= 30 else { return nil }
                switch sw.value {
                case "1": return "\(name) (on)"
                case "0": return "\(name) (off)"
                default: return name
                }
            }
        if !toggles.isEmpty {
            pieces.append("Toggles: \(toggles.prefix(3).joined(separator: ", ")).")
        }

        if cellCount > 0 && role != "list" {
            pieces.append("\(cellCount) tappable rows.")
        }

        return pieces.joined(separator: " ")
    }

    private func narrate(
        action: String,
        target: SimpleElement,
        screenTitle: String,
        actionDesc: String
    ) -> String {
        // Treat SF Symbol identifiers as "no name" so we describe the control by kind/position
        // instead of saying e.g. "Tapping the hand.wave.fill button" or "the chevron.forward control".
        let rawLabel = target.label.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawIdentifier = target.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = isSymbolLikeLabel(rawLabel) ? "" : rawLabel
        let identifier = isSymbolLikeLabel(rawIdentifier) ? "" : rawIdentifier
        let hasName = (!label.isEmpty && label.count <= 40) || (!identifier.isEmpty && identifier.count <= 40)
        let displayName = (!label.isEmpty && label.count <= 40) ? label : identifier
        let screen = screenTitle.isEmpty || screenTitle == "Unknown" ? "the current screen" : "the \(screenTitle) screen"

        let elementKind: String
        if target.type.contains("Switch") || target.type.contains("Toggle") || target.type.contains("rawValue: 40") {
            elementKind = "toggle"
        } else if target.type.contains("Button") || target.type.contains("rawValue: 9") {
            elementKind = "button"
        } else if target.type.contains("Link") || target.type.contains("rawValue: 39") {
            elementKind = "link"
        } else if target.type.contains("Cell") || target.type.contains("rawValue: 75") {
            elementKind = "row"
        } else if target.type.contains("Tab") || target.type.contains("rawValue: 54") {
            elementKind = "tab"
        } else if isTextField(target.type) {
            elementKind = "field"
        } else if target.type.contains("Image") || target.type.contains("rawValue: 43") {
            elementKind = "image"
        } else {
            elementKind = "control"
        }

        if action == "type" {
            // Extract typed value if present in actionDesc like type(name, "value")
            let typed: String = {
                if let range = actionDesc.range(of: "\""),
                   let endRange = actionDesc.range(of: "\"", options: .backwards),
                   range.lowerBound < endRange.lowerBound {
                    return String(actionDesc[actionDesc.index(after: range.lowerBound)..<endRange.lowerBound])
                }
                return ""
            }()
            let suffix = lastTypedWasOverride ? " (your saved value)" : ""
            let into = hasName ? "the \(displayName) field" : describeAnonymous(target)
            if typed.isEmpty {
                return "Typing into \(into) on \(screen)."
            }
            // Mask secure values so passwords never appear in the chat transcript
            let shown = lastTypedSecure ? String(repeating: "•", count: min(8, max(4, typed.count))) : typed
            return "Typing “\(shown)”\(suffix) into \(into) on \(screen)."
        }

        // For toggles, surface the state we're flipping from when we have it.
        if elementKind == "toggle", hasName {
            switch target.value {
            case "1": return "Turning off the \(displayName) toggle on \(screen)."
            case "0": return "Turning on the \(displayName) toggle on \(screen)."
            default: break
            }
        }

        if hasName {
            return "Tapping the \(displayName) \(elementKind) on \(screen)."
        }
        return "Tapping \(describeAnonymous(target)) on \(screen)."
    }

    /// Friendly role for the raw XCUIElementType so a client can tell a password box (secureField)
    /// from an email box (textField) without decoding rawValue numbers.
    private func elementRole(_ type: String) -> String {
        if type.contains("rawValue: 9)") { return "button" }
        if type.contains("rawValue: 49)") { return "textField" }
        if type.contains("rawValue: 50)") { return "secureField" }
        if type.contains("rawValue: 48)") { return "text" }
        if type.contains("rawValue: 75)") { return "cell" }
        if type.contains("rawValue: 12)") { return "image" }
        if type.contains("rawValue: 10)") { return "link" }
        if type.contains("rawValue: 41)") { return "switch" }
        return "other"
    }

    private func emitUITree(_ state: (title: String?, elements: [SimpleElement])) {
        var json = "{\"screenTitle\":\"\(escapeJSON(state.title ?? "Unknown"))\",\"elements\":["
        let arr = state.elements.prefix(100).map { el in
            // Every string field must be escaped — apps with multi-line labels ("Active\nClients")
            // otherwise inject raw newlines/quotes and make the whole tree invalid JSON → 0 elements.
            "{\"type\":\"\(el.type)\",\"role\":\"\(elementRole(el.type))\",\"id\":\"\(escapeJSON(el.identifier))\",\"label\":\"\(escapeJSON(el.label))\",\"enabled\":\(el.isEnabled),\"hittable\":\(el.isHittable),\"x\":\(Int(el.frame.midX)),\"y\":\(Int(el.frame.midY)),\"w\":\(Int(el.frame.width)),\"h\":\(Int(el.frame.height))}"
        }
        json += arr.joined(separator: ",")
        json += "]}"
        print("OCQA_UITREE_START")
        print(json)
        print("OCQA_UITREE_END")
    }

    private func buildAppState(elements: [SimpleElement]) -> (title: String?, elements: [SimpleElement]) {
        return (detectTitle(elements), elements)
    }

    private func emitProgress(action: Int, maxActions: Int, states: Int) {
        print("OCQA_PROGRESS:{\"action\":\(action),\"max\":\(maxActions),\"states\":\(states)}")
    }

    // Replace existing field contents to avoid repeatedly appending test text.
    private func replaceText(on element: XCUIElement, with text: String) {
        element.tap()

        if let existing = element.value as? String,
           !existing.isEmpty,
           existing.lowercased() != "optional" {
            let deleteString = String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count)
            element.typeText(deleteString)
        }

        element.typeText(text)
    }
}
