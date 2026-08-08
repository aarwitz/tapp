import SwiftUI

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
