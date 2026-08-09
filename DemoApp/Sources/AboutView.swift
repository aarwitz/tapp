import SwiftUI

struct AboutView: View {
    @State private var showsArchitecture = true

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
