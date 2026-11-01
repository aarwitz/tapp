// tapp's macOS desktop driver, one process away from the engine.
//
// Android is driven through `adb` and a UIAutomator dump; iOS through XCUITest. macOS has an
// equivalent that needs neither a test bundle nor a rebuild of the application under test: the
// Accessibility API. Any running application exposes a tree of AXUIElements with roles, titles,
// values and actions, which is the same shape the rest of tapp already speaks.
//
// This is deliberately a plain command-line tool rather than a test target, so tapp can be
// pointed at a .app the way it is pointed at an .apk — nothing to link, nothing to re-sign.
//
// It requires the Accessibility permission (System Settings → Privacy & Security →
// Accessibility) for whatever runs it. There is no way to grant that from code and tapp does not
// try: `trusted` reports the truth and the CLI explains the one-time step.
//
// Elements are addressed by their path of child indices from the application element ("0.3.1").
// A path is only valid for the snapshot it came from, so every action re-reads the tree first —
// the same discipline as the Android driver's `snap`.
import ApplicationServices
import AppKit
import Foundation

// MARK: - Attribute reading

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
  guard let value = attribute(element, name) else { return "" }
  if let text = value as? String { return text }
  if let number = value as? NSNumber { return number.stringValue }
  // AXValue of a text area can arrive as an attributed string.
  if let attributed = value as? NSAttributedString { return attributed.string }
  return ""
}

func boolAttribute(_ element: AXUIElement, _ name: String, default fallback: Bool) -> Bool {
  guard let value = attribute(element, name) as? NSNumber else { return fallback }
  return value.boolValue
}

func frame(_ element: AXUIElement) -> [Double] {
  var origin = CGPoint.zero
  var size = CGSize.zero
  if let value = attribute(element, kAXPositionAttribute as String) {
    AXValueGetValue(value as! AXValue, .cgPoint, &origin)
  }
  if let value = attribute(element, kAXSizeAttribute as String) {
    AXValueGetValue(value as! AXValue, .cgSize, &size)
  }
  return [Double(origin.x), Double(origin.y), Double(size.width), Double(size.height)]
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  guard let value = attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] else { return [] }
  return value
}

func actions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
  return list
}

// MARK: - Walking

struct Node: Encodable {
  let path: String
  let role: String
  let subrole: String
  let title: String
  let desc: String
  let value: String
  let identifier: String
  let enabled: Bool
  let focused: Bool
  let frame: [Double]
  let actions: [String]
  var children: [Node]
}

/// Caps exist because a document-shaped application (a long outline, a big table) can expose tens
/// of thousands of elements, and a snapshot that takes a minute is not a snapshot.
let maxNodesDefault = 2500
let maxDepthDefault = 28

final class Walker {
  var visited = 0
  let maxNodes: Int
  let maxDepth: Int
  init(maxNodes: Int, maxDepth: Int) { self.maxNodes = maxNodes; self.maxDepth = maxDepth }

  func walk(_ element: AXUIElement, path: String, depth: Int) -> Node {
    visited += 1
    let box = frame(element)
    var node = Node(
      path: path,
      role: stringAttribute(element, kAXRoleAttribute as String),
      subrole: stringAttribute(element, kAXSubroleAttribute as String),
      title: stringAttribute(element, kAXTitleAttribute as String),
      desc: stringAttribute(element, kAXDescriptionAttribute as String),
      value: String(stringAttribute(element, kAXValueAttribute as String).prefix(400)),
      identifier: stringAttribute(element, kAXIdentifierAttribute as String),
      enabled: boolAttribute(element, kAXEnabledAttribute as String, default: true),
      focused: boolAttribute(element, kAXFocusedAttribute as String, default: false),
      frame: box,
      actions: actions(element),
      children: []
    )
    if depth >= maxDepth || visited >= maxNodes { return node }
    for (index, child) in children(element).enumerated() {
      if visited >= maxNodes { break }
      node.children.append(walk(child, path: path.isEmpty ? "\(index)" : "\(path).\(index)", depth: depth + 1))
    }
    return node
  }
}

func element(at path: String, from root: AXUIElement) -> AXUIElement? {
  if path.isEmpty { return root }
  var current = root
  for component in path.split(separator: ".") {
    guard let index = Int(component) else { return nil }
    let kids = children(current)
    guard index >= 0 && index < kids.count else { return nil }
    current = kids[index]
  }
  return current
}

// MARK: - Output

func emit(_ value: Encodable, pretty: Bool = false) {
  let encoder = JSONEncoder()
  if pretty { encoder.outputFormatting = [.prettyPrinted, .sortedKeys] }
  struct Box<T: Encodable>: Encodable { let v: T }
  guard let data = try? encoder.encode(AnyEncodable(value)) else { fail("could not encode result") }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

struct AnyEncodable: Encodable {
  private let encodeTo: (Encoder) throws -> Void
  init(_ wrapped: Encodable) { encodeTo = wrapped.encode }
  func encode(to encoder: Encoder) throws { try encodeTo(encoder) }
}

func fail(_ message: String) -> Never {
  struct Failure: Encodable { let ok = false; let error: String }
  if let data = try? JSONEncoder().encode(Failure(error: message)) {
    FileHandle.standardError.write(data)
    FileHandle.standardError.write("\n".data(using: .utf8)!)
  }
  exit(1)
}

struct Ok: Encodable { let ok = true; let detail: String }

// MARK: - Arguments

var arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else {
  fail("usage: tapp-mac-ax <trusted|launch|tree|press|setvalue|key|windows|quit> [options]")
}
arguments = Array(arguments.dropFirst())

func option(_ name: String) -> String? {
  guard let index = arguments.firstIndex(of: "--\(name)"), index + 1 < arguments.count else { return nil }
  return arguments[index + 1]
}
func intOption(_ name: String, _ fallback: Int) -> Int { Int(option(name) ?? "") ?? fallback }

func requirePid() -> pid_t {
  guard let raw = option("pid"), let pid = Int32(raw) else { fail("--pid is required") }
  return pid
}

func requireTrusted() {
  guard AXIsProcessTrusted() else {
    fail("This program is not allowed to use the Accessibility API. Grant it in System Settings → Privacy & Security → Accessibility, for the application that runs tapp (your terminal, or the tapp app).")
  }
}

// MARK: - Commands

switch command {
case "trusted":
  struct Trust: Encodable { let trusted: Bool }
  emit(Trust(trusted: AXIsProcessTrusted()))

case "launch":
  // Launching is ordinary AppKit, not Accessibility: no permission needed to start a program.
  guard let bundlePath = option("app") else { fail("--app /path/to/App.app is required") }
  let url = URL(fileURLWithPath: bundlePath)
  guard FileManager.default.fileExists(atPath: url.path) else { fail("No application at \(url.path)") }
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = true
  configuration.createsNewApplicationInstance = false
  let semaphore = DispatchSemaphore(value: 0)
  var launched: NSRunningApplication?
  var launchError: Error?
  NSWorkspace.shared.openApplication(at: url, configuration: configuration) { application, error in
    launched = application; launchError = error; semaphore.signal()
  }
  if semaphore.wait(timeout: .now() + 30) == .timedOut { fail("Timed out launching \(url.lastPathComponent)") }
  if let error = launchError { fail("Could not launch \(url.lastPathComponent): \(error.localizedDescription)") }
  guard let application = launched else { fail("Could not launch \(url.lastPathComponent)") }
  struct Launched: Encodable { let ok = true; let pid: Int32; let bundleId: String; let name: String }
  emit(Launched(pid: application.processIdentifier,
                bundleId: application.bundleIdentifier ?? "",
                name: application.localizedName ?? url.deletingPathExtension().lastPathComponent))

case "tree":
  requireTrusted()
  let pid = requirePid()
  let application = AXUIElementCreateApplication(pid)
  let walker = Walker(maxNodes: intOption("max-nodes", maxNodesDefault), maxDepth: intOption("max-depth", maxDepthDefault))
  struct Tree: Encodable { let ok = true; let pid: Int32; let app: String; let window: String; let truncated: Bool; let nodes: Int; let root: Node }
  let root = walker.walk(application, path: "", depth: 0)
  // The focused window names the screen, the way an h1 names a web page.
  var window = ""
  if let focused = attribute(application, kAXFocusedWindowAttribute as String) {
    window = stringAttribute(focused as! AXUIElement, kAXTitleAttribute as String)
  }
  if window.isEmpty, let windows = attribute(application, kAXWindowsAttribute as String) as? [AXUIElement], let first = windows.first {
    window = stringAttribute(first, kAXTitleAttribute as String)
  }
  let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? ""
  emit(Tree(pid: pid, app: name, window: window, truncated: walker.visited >= walker.maxNodes, nodes: walker.visited, root: root))

case "press":
  requireTrusted()
  let pid = requirePid()
  guard let path = option("path") else { fail("--path is required") }
  let application = AXUIElementCreateApplication(pid)
  guard let target = element(at: path, from: application) else { fail("No element at path \(path)") }
  let available = actions(target)
  let wanted = option("action") ?? (available.contains(kAXPressAction as String) ? kAXPressAction as String : available.first ?? "")
  guard !wanted.isEmpty else { fail("Element at \(path) has no actions") }
  let code = AXUIElementPerformAction(target, wanted as CFString)
  guard code == .success else { fail("\(wanted) on \(path) failed (AXError \(code.rawValue))") }
  emit(Ok(detail: wanted))

case "setvalue":
  requireTrusted()
  let pid = requirePid()
  guard let path = option("path") else { fail("--path is required") }
  let text = option("text") ?? ""
  let application = AXUIElementCreateApplication(pid)
  guard let target = element(at: path, from: application) else { fail("No element at path \(path)") }
  // Focus first: some fields only accept a value while they are the responder, and a field the
  // user can see being filled is what a recording should show.
  AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  let code = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, text as CFTypeRef)
  guard code == .success else { fail("Could not set the value of \(path) (AXError \(code.rawValue))") }
  emit(Ok(detail: "set"))

case "key":
  requireTrusted()
  let pid = requirePid()
  guard let name = option("key") else { fail("--key is required") }
  let codes: [String: CGKeyCode] = ["return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
                                    "left": 123, "right": 124, "down": 125, "up": 126]
  guard let keyCode = codes[name.lowercased()] else { fail("Unknown key '\(name)'. Known: \(codes.keys.sorted().joined(separator: ", "))") }
  guard let source = CGEventSource(stateID: .hidSystemState) else { fail("Could not create an event source") }
  let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
  let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
  down?.postToPid(pid)
  up?.postToPid(pid)
  emit(Ok(detail: name))

case "windows":
  requireTrusted()
  let pid = requirePid()
  let application = AXUIElementCreateApplication(pid)
  struct Window: Encodable { let title: String; let frame: [Double] }
  struct Windows: Encodable { let ok = true; let windows: [Window] }
  let list = (attribute(application, kAXWindowsAttribute as String) as? [AXUIElement] ?? [])
    .map { Window(title: stringAttribute($0, kAXTitleAttribute as String), frame: frame($0)) }
  emit(Windows(windows: list))

case "quit":
  let pid = requirePid()
  guard let application = NSRunningApplication(processIdentifier: pid) else { emit(Ok(detail: "not running")); exit(0) }
  application.terminate()
  emit(Ok(detail: "terminated"))

default:
  fail("Unknown command '\(command)'")
}
