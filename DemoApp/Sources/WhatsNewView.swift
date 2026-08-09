import SwiftUI

/// A horizontally-paged carousel (swipe between pages). Exists so the Tapp harness's
/// carousel/lateral-swipe exploration path gets exercised against a known target — a screen
/// with almost nothing to tap, where progress only happens by swiping sideways.
struct WhatsNewView: View {
    private struct Page: Identifiable {
        let id = UUID()
        let title: String
        let detail: String
        let symbol: String
    }

    private let pages: [Page] = [
        Page(title: "Faster Runs", detail: "Exploration moves through the app more quickly.", symbol: "bolt.fill"),
        Page(title: "WebView Support", detail: "Tapp now reads content inside web views.", symbol: "globe"),
        Page(title: "Clearer Narration", detail: "Every screen and tap is described in plain language.", symbol: "text.bubble.fill"),
        Page(title: "You're All Set", detail: "Swipe through to see what changed this release.", symbol: "checkmark.seal.fill"),
    ]

    @State private var selection = 0

    var body: some View {
        TabView(selection: $selection) {
            ForEach(Array(pages.enumerated()), id: \.element.id) { index, page in
                VStack(spacing: 18) {
                    Image(systemName: page.symbol)
                        .font(.system(size: 64))
                        .foregroundStyle(.tint)
                    Text(page.title)
                        .font(.title.bold())
                    Text(page.detail)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
                .tag(index)
            }
        }
        .tabViewStyle(.page)
        .indexViewStyle(.page(backgroundDisplayMode: .always))
        .navigationTitle("What's New")
        .navigationBarTitleDisplayMode(.inline)
    }
}
