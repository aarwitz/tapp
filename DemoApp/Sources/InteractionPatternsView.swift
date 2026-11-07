import SwiftUI
import UIKit

// Deterministic fixture for prefilled credentials and a cursor placed mid-value (#28).
struct LoginResponseFixture: View {
    @State private var email = "a.previously.saved.address.with.a.long.suffix@example.test"
    @State private var password = "previous-password"
    @State private var signedIn = false
    @State private var failed = false

    private func submit() {
        signedIn = email == "qa@tapp.test" && password == "test-secret"
        failed = !signedIn
    }

    var body: some View {
        VStack(spacing: 20) {
            if signedIn {
                Text("Authenticated fixture").accessibilityIdentifier("login-success")
            } else {
                Text("Prefilled sign in").font(.title)
                MidCursorEmailField(text: $email).frame(height: 44)
                SecureField("Password", text: $password)
                    .accessibilityIdentifier("Password")
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(submit)
                Button("Sign In", action: submit)
                if failed { Text("Invalid fixture credentials").accessibilityIdentifier("login-failed") }
            }
        }.padding(30)
    }
}

private struct MidCursorEmailField: UIViewRepresentable {
    @Binding var text: String
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.placeholder = "Email"
        field.accessibilityIdentifier = "Email"
        field.borderStyle = .roundedRect
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        return field
    }
    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        if field.text != text { field.text = text }
    }
    class Coordinator: NSObject, UITextFieldDelegate {
        var parent: MidCursorEmailField
        init(_ parent: MidCursorEmailField) { self.parent = parent }
        @objc func changed(_ field: UITextField) { parent.text = field.text ?? "" }
        func textFieldDidBeginEditing(_ field: UITextField) {
            DispatchQueue.main.async {
                if let middle = field.position(from: field.beginningOfDocument, offset: (field.text?.utf16.count ?? 0) / 2) {
                    field.selectedTextRange = field.textRange(from: middle, to: middle)
                }
            }
        }
    }
}

/// One date control with a stable tree shape. The launch environment selects the observable
/// response so exploration can distinguish content/selection changes from a truly inert button.
struct ContentResponseFixture: View {
    let mode: String
    @State private var selected = false
    @State private var day = "THU, OCT 1"

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Button("FR, 2") {
                    switch mode {
                    case "immediate": day = "FRI, OCT 2"
                    case "delayed":
                        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { day = "FRI, OCT 2" }
                    case "selected": selected = true
                    default: break // Deliberately dead: the detector must still find this.
                    }
                }
                .accessibilityIdentifier("choose-date")
                .accessibilityAddTraits(selected ? .isSelected : [])
                Text("TIMES — \(day)")
                Text(day == "THU, OCT 1" ? "09:00 · 10:00" : "11:00 · 12:00")
            }
            .navigationTitle("Date Response")
        }
    }
}

// MARK: - Context Menu List

/// List whose cells navigate on tap AND expose a .contextMenu on long-press.
/// Exercises that the harness traverses NavigationLink cells correctly when
/// .contextMenu is attached — no false "dead control" positives from the menu
/// options, since tapping a menu item dismisses the overlay (content changes).
struct PinnedItemsView: View {
    let items = [
        "Design Review", "Sprint Retrospective",
        "QA Sign-off", "Release Notes", "Bug Triage",
    ]

    var body: some View {
        List(items, id: \.self) { item in
            NavigationLink {
                PinnedItemDetailView(name: item)
            } label: {
                Label(item, systemImage: "pin")
            }
            .contextMenu {
                Button("Rename") { }
                Button("Duplicate") { }
                Button("Delete", role: .destructive) { }
            }
        }
        .navigationTitle("Pinned Items")
    }
}

private struct PinnedItemDetailView: View {
    let name: String

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "pin.circle.fill")
                .font(.system(size: 52))
                .foregroundStyle(.teal)
            Text(name)
                .font(.title2.bold())
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Edit Mode List

/// Standard SwiftUI EditButton list — exercises mode-switching UI where tapping
/// "Edit" transforms the candidate pool (per-row delete circles appear) and
/// "Done" restores it. Tests that the harness handles the mode toggle correctly
/// and doesn't false-positive on delete circles (which do change content).
struct DraftReportsView: View {
    @State private var items = [
        "Performance Regression — v2.4.1",
        "Network Timeout on Cold Start",
        "Accessibility Audit — Settings Flow",
        "Memory Leak in Image Cache",
        "Crash on Background Fetch",
        "Login Flow Visual Glitch",
    ]

    var body: some View {
        List {
            ForEach(items, id: \.self) { item in
                Text(item)
                    .font(.subheadline)
            }
            .onDelete { indices in
                items.remove(atOffsets: indices)
            }
        }
        .navigationTitle("Draft Reports")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                EditButton()
            }
        }
    }
}

// MARK: - Swipe Actions List

/// List whose rows expose actions ONLY via swipe — no NavigationLink, no tap
/// handler. The harness is tap-based and cannot trigger swipe actions, so every
/// tap leaves the screen unchanged. This correctly surfaces as unresponsive_element:
/// a real accessibility gap for motor-impaired users who rely on tap interaction.
struct QueuedTasksView: View {
    @State private var items = [
        "Verify push notification payload",
        "Regression test — dark mode",
        "Confirm analytics event firing",
        "Spot-check localization strings",
        "Validate offline cache behavior",
    ]

    var body: some View {
        List {
            ForEach(items, id: \.self) { item in
                // Button wrapper is required for XCUITest hittability — a bare VStack
                // inside a List isn't registered as interactive by the accessibility layer.
                // The action is intentionally no-op; the only real interaction is swipe,
                // which is the accessibility gap this screen is designed to surface.
                Button(action: {}) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item)
                            .font(.subheadline)
                        Text("Swipe to complete or flag")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button("Done", role: .destructive) {
                        items.removeAll { $0 == item }
                    }
                    Button("Defer") { }
                        .tint(.orange)
                }
                .swipeActions(edge: .leading) {
                    Button("Flag") { }
                        .tint(.blue)
                }
            }
        }
        .navigationTitle("Queued Tasks")
    }
}

/// Two shapes that cost real recording takes, kept here so the harness can be measured against
/// them without building somebody's product (TM-496).
///
/// 1. A field whose ONLY text is its placeholder: no accessibility identifier, no label. This is
///    the ordinary SwiftUI `TextField("…", text:)` that most screens are made of, and a flow has
///    to be able to type into one without the app being changed to suit the test.
/// 2. A field with a drawer pulled over it. Tapping it does nothing, focus never arrives, and the
///    useful error is not "it never took focus" but what is sitting on top of it.
struct PlaceholderFieldsView: View {
    @State private var ask = ""
    @State private var note = ""
    @State private var drawerOpen = false
    @State private var sheetOpen = false
    @State private var longer = ""

    var body: some View {
        ZStack(alignment: .top) {
            Form {
                Section("No identifier, no label") {
                    // Deliberately bare: the placeholder is the only way to name this field.
                    TextField("Ask anything…", text: $ask)
                        .textFieldStyle(.roundedBorder)
                    Text("Asked: \(ask)")
                        .accessibilityIdentifier("ask-echo")
                }
                Section("Growing field, no identifier") {
                    // `axis: .vertical` is the shape a chat composer actually uses, and XCUITest
                    // exposes it as a TEXT VIEW rather than a text field — a different element
                    // type with its own placeholder behaviour. The horizontal case above does
                    // not stand in for it.
                    TextField("Say something longer…", text: $longer, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                    Text("Said: \(longer)")
                        .accessibilityIdentifier("longer-echo")
                }
                Section("Covered by a drawer") {
                    TextField("Write a note…", text: $note)
                        .textFieldStyle(.roundedBorder)
                    Text("Noted: \(note)")
                        .accessibilityIdentifier("note-echo")
                    Button(drawerOpen ? "Close history" : "Open history") { drawerOpen.toggle() }
                        .accessibilityIdentifier("toggle-history")
                    // A real sheet, which unlike a material drawer DOES have accessibility
                    // identity — the case a focus failure can actually name.
                    Button("Open details") { sheetOpen = true }
                        .accessibilityIdentifier("toggle-sheet")
                }
            }
            if drawerOpen {
                // An opaque panel over the form, the way a chat history drawer sits over its
                // composer. Nothing underneath is hittable while it is up.
                VStack(alignment: .leading, spacing: 8) {
                    Text("Recent history").font(.headline)
                    ForEach(["Yesterday", "Last week", "Last month"], id: \.self) { entry in
                        Text(entry).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding()
                .background(.regularMaterial)
                .accessibilityIdentifier("history-drawer")
            }
        }
        .navigationTitle("Placeholder Fields")
        .sheet(isPresented: $sheetOpen) {
            VStack(spacing: 12) {
                Text("Delivery details").font(.headline)
                Text("This sheet sits over the note field.")
                Button("Close") { sheetOpen = false }
            }
            .padding()
        }
    }
}


/// Two fields that answer to the same name in different ways, on a screen short enough that
/// neither needs scrolling to reach. The one earlier on screen carries it as its LABEL; the one
/// after carries it as its IDENTIFIER, and the identifier must win (TM-496).
struct NamePrecedenceView: View {
    @State private var byLabel = ""
    @State private var byIdentifier = ""

    var body: some View {
        Form {
            TextField("Label box", text: $byLabel)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Reference")
            Text("Label box got: \(byLabel)")
                .accessibilityIdentifier("label-box-echo")
            TextField("Identifier box", text: $byIdentifier)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("Reference")
            Text("Identifier box got: \(byIdentifier)")
                .accessibilityIdentifier("identifier-box-echo")
        }
        .navigationTitle("Name Precedence")
    }
}
