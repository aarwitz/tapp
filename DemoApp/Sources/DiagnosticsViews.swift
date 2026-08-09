import SwiftUI

/// Always-on error surface with a dead Retry button — exercises both error-surface detection
/// and dead-control detection on an error screen.
struct ErrorStateView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 48))
                .foregroundStyle(.orange)
            Text("Something went wrong")
                .font(.title2.bold())
            Text("We couldn't load this content. Please try again.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Button("Retry") {
                // no-op: exercises dead-control detection on an error screen
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("System Status")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Perpetual loading state that never resolves — exercises Tapp's stuck-loading/hang detection.
/// (Contrast with the Dashboard, whose spinner resolves after ~1.2s and must NOT be flagged.)
struct PerpetualLoadingView: View {
    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text("Loading live feed…")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("Live Feed")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Form that always produces a simulated server error on submit — exercises error-surface
/// detection in a FORM context (inline validation message that only appears after a submit,
/// not a full-screen static error).
struct UpdateProfileView: View {
    @State private var email = ""
    @State private var displayName = ""
    @State private var submitted = false

    var body: some View {
        Form {
            Section("Account") {
                TextField("Email address", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .autocorrectionDisabled()
                TextField("Display name", text: $displayName)
            }
            Section {
                Button("Save Changes") {
                    submitted = true
                }
                .frame(maxWidth: .infinity)
            }
            if submitted {
                Section {
                    Text("Something went wrong saving your profile. Please try again.")
                        .foregroundStyle(.red)
                        .font(.footnote)
                }
            }
        }
        .navigationTitle("Update Profile")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Empty state with a dead "Add Report" CTA — exercises dead-control detection when the only
/// visible button on screen does nothing (common empty-state pattern in real apps).
struct SavedReportsView: View {
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 52))
                .foregroundStyle(.secondary)
            Text("No saved reports yet.")
                .font(.headline)
            Text("Reports you save during a QA run will appear here.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button("Add Report") {
                // no-op: exercises dead-control detection in an empty-state context
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("Saved Reports")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A long scrollable screen with an error surface well BELOW the fold — exercises Tapp's
/// scroll-to-discover for ISSUE detection: the error is only readable (and thus only detectable)
/// after the explorer scrolls down to reveal it.
struct ChangelogView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(1...25, id: \.self) { i in
                    Text("Build 1.\(i).0 — routine fixes and improvements for release \(i).")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Text("Couldn't load older releases. Please try again.")
                    .font(.headline)
                    .foregroundStyle(.red)
                    .padding(.top, 16)
            }
            .padding()
        }
        .navigationTitle("Changelog")
        .navigationBarTitleDisplayMode(.inline)
    }
}
