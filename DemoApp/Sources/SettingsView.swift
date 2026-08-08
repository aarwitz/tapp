import Foundation
import SwiftUI

private enum BuildChannel: String, CaseIterable, Identifiable {
    case stable = "Stable"
    case beta = "Beta"
    case nightly = "Nightly"

    var id: String { rawValue }
}

struct SettingsView: View {
    @State private var captureVideo = true
    @State private var notifyOnFailures = true
    @State private var selectedChannel: BuildChannel = .stable
    @State private var showingResetDialog = false

    private var hidesUpdateProfileForSeededBenchmark: Bool {
        ProcessInfo.processInfo.environment["TAPP_SEEDED_FAULT"] == "hide-update-profile"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Automation") {
                    Toggle("Record run video", isOn: $captureVideo)
                    Toggle("Notify on failures", isOn: $notifyOnFailures)

                    Picker("Channel", selection: $selectedChannel) {
                        ForEach(BuildChannel.allCases) { channel in
                            Text(channel.rawValue).tag(channel)
                        }
                    }
                }

                Section("Explore") {
                    // Issue-detection fixtures first so they're reliably reached early.
                    if !hidesUpdateProfileForSeededBenchmark {
                        NavigationLink("Update Profile") {
                            UpdateProfileView()
                        }
                    }
                    NavigationLink("Saved Reports") {
                        SavedReportsView()
                    }
                    NavigationLink("Pinned Items") {
                        PinnedItemsView()
                    }
                    NavigationLink("Draft Reports") {
                        DraftReportsView()
                    }
                    NavigationLink("Queued Tasks") {
                        QueuedTasksView()
                    }
                    NavigationLink("Changelog") {
                        ChangelogView()
                    }
                    NavigationLink("System Status") {
                        ErrorStateView()
                    }
                    NavigationLink("Live Feed") {
                        PerpetualLoadingView()
                    }
                    NavigationLink("Notification Rules") {
                        NotificationRulesView()
                    }
                    NavigationLink("Privacy") {
                        PrivacyView()
                    }
                    NavigationLink("Help Center") {
                        WebContentView()
                    }
                }

                Section("Danger Zone") {
                    Button("Reset Local Cache", role: .destructive) {
                        showingResetDialog = true
                    }
                }
            }
            .navigationTitle("Settings")
            .confirmationDialog("Reset local cache?", isPresented: $showingResetDialog) {
                Button("Reset Cache", role: .destructive) {}
                Button("Cancel", role: .cancel) {}
            }
        }
    }
}

private struct NotificationRulesView: View {
    @State private var quietHours = false
    @State private var alertLevel = 1

    var body: some View {
        Form {
            Toggle("Quiet Hours", isOn: $quietHours)
            Stepper("Alert Level: \(alertLevel)", value: $alertLevel, in: 1...3)
        }
        .navigationTitle("Notification Rules")
    }
}

private struct PrivacyView: View {
    @State private var redactScreenshots = true

    var body: some View {
        Form {
            Toggle("Redact screenshots", isOn: $redactScreenshots)
            Text("These controls are here to create another secondary screen with standard form elements.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .navigationTitle("Privacy")
    }
}
