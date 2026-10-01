import SwiftUI

@main
struct DemoAppApp: App {
    var body: some Scene {
        WindowGroup {
            if ProcessInfo.processInfo.environment["TAPP_DEMO_LOGIN_CASE"] != nil {
                LoginResponseFixture()
            } else if let mode = ProcessInfo.processInfo.environment["TAPP_DEMO_CONTENT_CASE"] {
                ContentResponseFixture(mode: mode)
            } else {
                ContentView()
            }
        }
    }
}
