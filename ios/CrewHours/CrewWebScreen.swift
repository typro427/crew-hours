import SwiftUI
import WebKit
import SafariServices

/// The crew app itself, in a web view, with the phone's GPS, notifications and camera wired in.
struct CrewWebScreen: View {
    let start: URL
    @EnvironmentObject var state: AppState
    @State private var offline = false
    @State private var reloadTick = 0

    var body: some View {
        ZStack {
            Color("Background").ignoresSafeArea()
            CrewWebView(start: start, offline: $offline, reloadTick: reloadTick, onSetup: { state.forget() })
            if offline {
                VStack(spacing: 14) {
                    Image(systemName: "wifi.slash").font(.system(size: 42)).foregroundStyle(.secondary)
                    Text("No connection").font(.title2.bold())
                    Text("Crew Hours needs signal the first time it opens. After that it works offline and sends what you saved when signal comes back.")
                        .multilineTextAlignment(.center).foregroundStyle(.secondary)
                    Button("Try again") { offline = false; reloadTick += 1 }
                        .buttonStyle(.borderedProminent).tint(Color("AccentColor")).foregroundStyle(.black)
                }
                .padding(32)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color("Background"))
            }
        }
    }
}

struct CrewWebView: UIViewRepresentable {
    let start: URL
    @Binding var offline: Bool
    let reloadTick: Int
    let onSetup: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let c = context.coordinator
        let config = WKWebViewConfiguration()
        config.limitsNavigationsToAppBoundDomains = true      // lets the crew app's offline mode (service worker) work here
        config.allowsInlineMediaPlayback = true
        config.websiteDataStore = .default()
        config.applicationNameForUserAgent = "CrewHoursApp/\(Bridge.version)"   // the site can tell it's the app
        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: Bridge.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.add(WeakHandler(c), name: "native")
        config.userContentController = ucc

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = c
        web.uiDelegate = c
        web.allowsBackForwardNavigationGestures = false
        web.isOpaque = false
        web.backgroundColor = UIColor(named: "Background")
        web.scrollView.contentInsetAdjustmentBehavior = .automatic
        if #available(iOS 16.4, *) { web.isInspectable = true }   // Safari > Develop, for debugging builds
        let refresh = UIRefreshControl()
        refresh.addTarget(c, action: #selector(Coordinator.pulled(_:)), for: .valueChanged)
        web.scrollView.refreshControl = refresh
        c.web = web
        c.location.run = { [weak web] js in web?.evaluateJavaScript(js, completionHandler: nil) }
        web.load(URLRequest(url: AppDelegate.pendingURL ?? start))
        AppDelegate.pendingURL = nil
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        if context.coordinator.lastTick != reloadTick {
            context.coordinator.lastTick = reloadTick
            if web.url == nil { web.load(URLRequest(url: start)) } else { web.reload() }
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let parent: CrewWebView
        weak var web: WKWebView?
        let location = LocationBridge()
        var lastTick = 0

        init(_ parent: CrewWebView) {
            self.parent = parent
            super.init()
            NotificationCenter.default.addObserver(self, selector: #selector(pushResult(_:)), name: AppDelegate.pushResult, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(openURL(_:)), name: AppDelegate.openURL, object: nil)
        }

        @objc func pulled(_ sender: UIRefreshControl) {
            web?.reload()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { sender.endRefreshing() }
        }

        // MARK: messages from the page (window.CrewHoursNative.post)
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let msg = message.body as? [String: Any], let type = msg["type"] as? String else { return }
            switch type {
            case "push.status": AppDelegate.pushStatus()
            case "push.enable": AppDelegate.pushEnable()
            case "setup": DispatchQueue.main.async { self.parent.onSetup() }
            default: if type.hasPrefix("geo.") { location.handle(msg) }
            }
        }

        @objc func pushResult(_ n: Notification) {
            guard let info = n.userInfo,
                  let data = try? JSONSerialization.data(withJSONObject: info),
                  let json = String(data: data, encoding: .utf8) else { return }
            web?.evaluateJavaScript("window.CrewHoursNative&&CrewHoursNative._push(\(json));", completionHandler: nil)
        }

        @objc func openURL(_ n: Notification) {
            guard let url = n.object as? URL, let web = web else { return }
            AppDelegate.pendingURL = nil
            if let cur = web.url, cur.host == url.host, cur.path == url.path, let frag = url.fragment {
                web.evaluateJavaScript("location.hash='\(frag.replacingOccurrences(of: "'", with: ""))';", completionHandler: nil)   // same page: just change tab
            } else if url.host?.hasSuffix(Config.host) == true {
                web.load(URLRequest(url: url))
            }
        }

        // MARK: navigation: the crew site stays in the app; anything else opens in Safari
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            if ["tel", "mailto", "sms", "maps"].contains(url.scheme ?? "") {
                UIApplication.shared.open(url); return decisionHandler(.cancel)
            }
            let inApp = url.host?.lowercased().hasSuffix(Config.host) == true || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data"
            if !inApp && action.targetFrame?.isMainFrame != false {
                openOutside(url); return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            // a download (Excel, PDF to save): open it in Safari, which can save or share it
            let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
            if response.isForMainFrame, (!response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment")), let url = response.response.url {
                openOutside(url); return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            DispatchQueue.main.async { self.parent.offline = false }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let e = error as NSError
            if e.code == NSURLErrorCancelled || e.code == 102 { return }      // 102: a link we sent to Safari instead
            if webView.url == nil || e.domain == NSURLErrorDomain { DispatchQueue.main.async { self.parent.offline = true } }
        }

        /// The web content process stopped (low memory): load it again.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

        /// Links that open a new window (target=_blank).
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url {
                if url.host?.lowercased().hasSuffix(Config.host) == true { webView.load(action.request) } else { openOutside(url) }
            }
            return nil
        }

        private func openOutside(_ url: URL) {
            guard ["http", "https"].contains(url.scheme ?? "") else { UIApplication.shared.open(url); return }
            let sf = SFSafariViewController(url: url)
            top()?.present(sf, animated: true)
        }

        // MARK: alert / confirm / prompt from the page
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            present(a, else: completionHandler)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            present(a, else: { completionHandler(false) })
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
            let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            a.addTextField { $0.text = defaultText }
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
            present(a, else: { completionHandler(nil) })
        }

        /// Camera / microphone for the page: allowed for the crew site only (the phone still asks the first time).
        @available(iOS 15.0, *)
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(origin.host.hasSuffix(Config.host) ? .grant : .deny)
        }

        private func present(_ vc: UIViewController, else fallback: @escaping () -> Void) {
            if let t = top() { t.present(vc, animated: true) } else { fallback() }
        }

        private func top() -> UIViewController? {
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
                ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            var v = scene?.windows.first { $0.isKeyWindow }?.rootViewController
            while let p = v?.presentedViewController { v = p }
            return v
        }
    }
}

/// WKUserContentController keeps its handlers alive; this keeps it from keeping the coordinator alive too.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}
