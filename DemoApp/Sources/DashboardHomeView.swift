import SwiftUI

private enum DashboardFocus: String, CaseIterable, Identifiable {
    case overview = "Overview"
    case qa = "QA"
    case releases = "Releases"

    var id: String { rawValue }
}

private enum DashboardSheet: Identifiable {
    case checklist
    case summary

    var id: Int {
        switch self {
        case .checklist: return 0
        case .summary: return 1
        }
    }
}

struct DashboardHomeView: View {
    @State private var focus: DashboardFocus = .overview
    @State private var isLoading = true
    @State private var activeSheet: DashboardSheet?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    VStack(spacing: 16) {
                        ProgressView()
                            .controlSize(.large)
                        Text("Syncing release signals...")
                            .font(.headline)
                        Text("Dashboard content appears after a short loading state.")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            Picker("Focus", selection: $focus) {
                                ForEach(DashboardFocus.allCases) { item in
                                    Text(item.rawValue).tag(item)
                                }
                            }
                            .pickerStyle(.segmented)

                            statusCard

                            // Always-visible (not behind the segmented picker) so the explorer
                            // reliably reaches the carousel screen.
                            NavigationLink {
                                WhatsNewView()
                            } label: {
                                dashboardRow(title: "What's New", subtitle: "A swipeable carousel — progress happens by swiping sideways")
                            }

                            // Intentionally dead button: does nothing when tapped. Always visible so
                            // AutoTap reliably reaches it; should surface as an unresponsive-control
                            // finding on the Dashboard screen.
                            Button("Sync Now") {
                                // no-op on purpose
                            }
                            .buttonStyle(.bordered)

                            if focus == .overview {
                                overviewSection
                            } else if focus == .qa {
                                qaSection
                            } else {
                                releaseSection
                            }
                        }
                        .padding()
                    }
                }
            }
            .navigationTitle("Dashboard")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu("More") {
                        Button("Open release checklist") {
                            activeSheet = .checklist
                        }
                        Button("Show summary modal") {
                            activeSheet = .summary
                        }
                    }
                }
            }
            .sheet(item: $activeSheet) { sheet in
                switch sheet {
                case .checklist:
                    dashboardModal(
                        title: "Release Checklist",
                        items: [
                            "Verify screenshot capture",
                            "Confirm markers parsed cleanly",
                            "Spot-check a replay artifact",
                        ]
                    )
                case .summary:
                    dashboardModal(
                        title: "Daily Summary",
                        items: [
                            "2 blockers triaged",
                            "1 regression replay attached",
                            "Coverage score updated conservatively",
                        ]
                    )
                }
            }
            .task {
                guard isLoading else { return }
                try? await Task.sleep(for: .seconds(1.2))
                isLoading = false
            }
        }
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Current Run")
                .font(.headline)
            Text("A slightly chaotic dashboard with mixed navigation styles.")
                .foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Label("3 pending checks", systemImage: "exclamationmark.triangle")
                Label("1 flaky simulator", systemImage: "iphone.slash")
            }
            .font(.subheadline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var overviewSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            NavigationLink {
                CounterView()
            } label: {
                dashboardRow(title: "Counter Playground", subtitle: "Buttons, stepper, and a reset confirmation dialog")
            }

            NavigationLink {
                AboutView()
            } label: {
                dashboardRow(title: "Release Notes", subtitle: "Scrollable detail with disclosure groups and metadata")
            }

            NavigationLink {
                WebContentView()
            } label: {
                dashboardRow(title: "Help Center", subtitle: "Web content (WKWebView) with links, a search field, and a button")
            }

            Button("Open release checklist") {
                activeSheet = .checklist
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var qaSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            dashboardRow(title: "Last screenshot diff", subtitle: "No visual regressions detected in the latest pass")
            dashboardRow(title: "Exploration notes", subtitle: "The explorer should move through tabs, sheets, and detail views")
            Button("Show summary modal") {
                activeSheet = .summary
            }
            .buttonStyle(.bordered)
        }
    }

    private var releaseSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            dashboardRow(title: "May Release", subtitle: "3 changes queued for rollout")
            dashboardRow(title: "Beta Channel", subtitle: "1 experiment behind a local flag")
        }
    }

    private func dashboardRow(title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.headline)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func dashboardModal(title: String, items: [String]) -> some View {
        NavigationStack {
            List(items, id: \.self) { item in
                Label(item, systemImage: "checkmark.circle")
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        activeSheet = nil
                    }
                }
            }
        }
    }
}
