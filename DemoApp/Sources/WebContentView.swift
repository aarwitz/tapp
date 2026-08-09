import SwiftUI
import WebKit

/// A WKWebView-backed screen. Exists so the Tapp harness's WebView accessibility extraction
/// (links/buttons/fields inside a web container) gets exercised against a known target.
/// Loads local HTML so there's no network dependency.
struct WebContentView: View {
    var body: some View {
        WebView()
            .navigationTitle("Help Center")
            .ignoresSafeArea(edges: .bottom)
    }
}

private struct WebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView()
        web.isOpaque = true
        web.loadHTMLString(Self.html, baseURL: nil)
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static let html = """
    <!doctype html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font: -apple-system; padding: 24px; line-height: 1.5; color: #111; }
        h1 { font-size: 26px; }
        a { display: block; margin: 14px 0; font-size: 18px; color: #0a84ff; text-decoration: none; }
        input { font-size: 17px; padding: 10px; width: 80%; margin-top: 12px; }
        button { font-size: 18px; padding: 12px 18px; margin-top: 16px; background: #0a84ff; color: white; border: none; border-radius: 8px; }
      </style>
    </head>
    <body>
      <h1>Help Center</h1>
      <p>Frequently asked questions about Tapp.</p>
      <a href="#getting-started">Getting Started Guide</a>
      <a href="#troubleshooting">Troubleshooting</a>
      <a href="#contact">Contact Support</a>
      <input type="text" placeholder="Search help articles" aria-label="Search help articles" />
      <button onclick="document.getElementById('msg').innerText='Thanks for your feedback!'">Send Feedback</button>
      <p id="msg"></p>
    </body>
    </html>
    """
}
