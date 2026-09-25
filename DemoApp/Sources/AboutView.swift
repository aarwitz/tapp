import SwiftUI

struct AboutView: View {
    @State private var showsArchitecture = true
    // The iOS share sheet is a SYSTEM-owned surface that renders inside the app process: its
    // tree belongs to iOS and the extensions it hosts, not to this app. The corpus carries it
    // so the explorer's catalogue-and-back-out behaviour stays regression-tested.
    @State private var showsShareSheet = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Label("Tapp Demo App", systemImage: "iphone.gen3")
                    .font(.title2.bold())
                    .accessibilityAddTraits(.isHeader)

                Text("This is a minimal SwiftUI app used to test the Tapp autonomous QA harness against a known, simple target.")
                    .foregroundStyle(.secondary)

                Divider()

                Group {
                    infoRow("Bundle ID", value: "io.github.aarwitz.tapp.demoapp")
                    infoRow("Version", value: "1.0.0")
                    infoRow("Screens", value: "Home, Tasks, Settings, Counter, About")
                }

                DisclosureGroup("Architecture Notes", isExpanded: $showsArchitecture) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("The app mixes tabs, delayed loading states, sheets, forms, and nested navigation to simulate patterns common in random App Store apps.")
                        Text("It is intentionally more confusing than a happy-path demo so the exploration harness has to make better tradeoffs.")
                    }
                    .padding(.top, 8)
                }
            }
            .padding()
        }
        .navigationTitle("About")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Share") { showsShareSheet = true }
                    .accessibilityIdentifier("share-demo-app")
            }
        }
        .sheet(isPresented: $showsShareSheet) {
            ShareSheet(items: ["Tapp Demo App"])
        }
    }

    private func infoRow(_ label: String, value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 90, alignment: .leading)
            Text(value)
                .bold()
        }
    }
}

/// UIActivityViewController is deliberately unwrapped rather than SwiftUI's ShareLink: the
/// explorer must meet the real `UIActivityContentView` the field report hit.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
