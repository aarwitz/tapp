import SwiftUI

@main
struct DemoAppApp: App {
    var body: some Scene {
        WindowGroup {
            if let mode = ProcessInfo.processInfo.environment["TAPP_DEMO_CONTENT_CASE"] {
                ContentResponseFixture(mode: mode)
            } else {
                ContentView()
            }
        }
    }
}
