import SwiftUI

struct ContentView: View {
    @State private var selectedTab = 0
    @State private var showingWelcome = true

    var body: some View {
        TabView(selection: $selectedTab) {
            DashboardHomeView()
                .tabItem {
                    Label("Home", systemImage: "house.fill")
                }
                .tag(0)

            TodoView()
                .tabItem {
                    Label("Tasks", systemImage: "checklist")
                }
                .tag(1)

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gearshape.fill")
                }
                .tag(2)
        }
        .sheet(isPresented: $showingWelcome) {
            WelcomeSheet(selectedTab: $selectedTab, showingWelcome: $showingWelcome)
        }
    }
}

private struct WelcomeSheet: View {
    @Binding var selectedTab: Int
    @Binding var showingWelcome: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Label("Welcome to Demo App", systemImage: "sparkles.rectangle.stack")
                    .font(.title2.bold())

                Text("This version is intentionally a bit messy: tabs, delayed content, sheets, forms, nested detail views, and destructive actions.")
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 12) {
                    Label("Home has a delayed dashboard and modal checklists.", systemImage: "house")
                    Label("Tasks has searchable lists, a composer sheet, and nested detail state.", systemImage: "checklist")
                    Label("Settings has forms, toggles, dialogs, and secondary screens.", systemImage: "gearshape")
                }
                .font(.subheadline)

                Spacer()

                Button("Continue") {
                    showingWelcome = false
                }
                .buttonStyle(.borderedProminent)

                Button("Jump to Tasks") {
                    selectedTab = 1
                    showingWelcome = false
                }
                .buttonStyle(.bordered)

                Button("Not Now") {
                    showingWelcome = false
                }
                .foregroundStyle(.secondary)
            }
            .padding()
            .navigationTitle("Get Started")
        }
    }
}
