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
