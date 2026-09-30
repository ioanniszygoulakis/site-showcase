// Site Showcase.app: a native window around the local tool.
// On launch it starts `node server.js` in the project folder (unless it's already running), shows the UI
// in a WebKit view, and stops the server again on quit.
import Cocoa
import WebKit

let port = 4321
let appURL = URL(string: "http://localhost:\(port)/")!
let projectPath = Bundle.main.object(forInfoDictionaryKey: "SSProjectPath") as? String ?? ""
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Site Showcase.log")
let panelColor = NSColor(srgbRed: 0x15 / 255.0, green: 0x15 / 255.0, blue: 0x19 / 255.0, alpha: 1)

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?   // only set when this app started the server, so we never kill one we don't own
    var pollTimer: Timer?
    var toldSetup = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.isElementFullscreenEnabled = true
        web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground") // no white flash while loading

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Site Showcase"
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = panelColor
        window.minSize = NSSize(width: 980, height: 640)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("SiteShowcaseMain")
        window.makeKeyAndOrderFront(nil)

        showStatus("Starting…")
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        let s = server
        server = nil // so the termination handler doesn't report it as a crash
        s?.terminate()
        s?.waitUntilExit()
    }

    // MARK: Server

    func startServer() {
        isServerUp { up in
            if up { self.web.load(URLRequest(url: appURL)); return }
            guard FileManager.default.fileExists(atPath: projectPath + "/server.js") else {
                return self.showStatus("Can’t find the Site Showcase folder at \(projectPath). Rebuild the app with macos/build-app.sh after moving it.", error: true)
            }
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
            let log = try? FileHandle(forWritingTo: logURL)
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            // Login shell so Homebrew's node/ffmpeg are on PATH; first run installs dependencies.
            p.arguments = ["-lc", """
                export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
                cd "$SS_DIR" || exit 1
                if [ ! -d node_modules ]; then npm install && npx playwright install chromium || exit 1; fi
                exec node server.js
                """]
            var env = ProcessInfo.processInfo.environment
            env["SS_DIR"] = projectPath
            env["NO_OPEN"] = "1"
            p.environment = env
            p.standardOutput = log
            p.standardError = log
            p.terminationHandler = { proc in
                DispatchQueue.main.async {
                    guard self.server === proc else { return }
                    self.server = nil
                    self.showStatus("The Site Showcase server stopped. Details are in ~/Library/Logs/Site Showcase.log", error: true)
                }
            }
            do {
                try p.run()
                self.server = p
            } catch {
                return self.showStatus("Couldn’t start the server: \(error.localizedDescription)", error: true)
            }
            self.waitForServer(deadline: Date().addingTimeInterval(600))
        }
    }

    func waitForServer(deadline: Date) {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { timer in
            self.isServerUp { up in
                if up {
                    timer.invalidate()
                    self.web.load(URLRequest(url: appURL))
                } else if Date() > deadline {
                    timer.invalidate()
                    self.showStatus("The server didn’t start. Details are in ~/Library/Logs/Site Showcase.log", error: true)
                } else if !self.toldSetup, self.server != nil, !FileManager.default.fileExists(atPath: projectPath + "/node_modules") {
                    self.toldSetup = true
                    self.showStatus("Setting up for the first time. This takes a minute or two…")
                }
            }
        }
    }

    func isServerUp(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: appURL)
        req.timeoutInterval = 0.35
        URLSession.shared.dataTask(with: req) { _, res, _ in
            let ok = (res as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func showStatus(_ text: String, error: Bool = false) {
        let logo = Bundle.main.url(forResource: "logo", withExtension: "png").flatMap { try? Data(contentsOf: $0) }
        let icon = logo.map { "data:image/png;base64," + $0.base64EncodedString() } ?? ""
        let safe = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        web.loadHTMLString("""
            <html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#151519;color:#ececf0;
            font:15px -apple-system,sans-serif;text-align:center">
            <div><img src="\(icon)" width="112" height="112" style="display:block;margin:0 auto 18px">
            <div style="max-width:440px;color:\(error ? "#ff8474" : "#8f8f9b")">\(safe)</div></div></body></html>
            """, baseURL: nil)
    }

    // MARK: Web view behaviour

    // Links that open a new window go to the default browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    // <a download> links save to ~/Downloads.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var dest = dir.appendingPathComponent(suggestedFilename)
        let base = dest.deletingPathExtension().lastPathComponent, ext = dest.pathExtension
        var n = 2
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = dir.appendingPathComponent("\(base) \(n)").appendingPathExtension(ext)
            n += 1
        }
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = download.progress.fileURL {
            DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: url.path)
        }
    }

    // MARK: Menu

    @objc func openOutputFolder() {
        let out = URL(fileURLWithPath: projectPath).appendingPathComponent("output")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        NSWorkspace.shared.open(out)
    }

    @objc func reloadPage() { web.load(URLRequest(url: appURL)) }

    func buildMenu() {
        let main = NSMenu()
        func submenu(_ title: String, _ items: [NSMenuItem]) {
            let item = NSMenuItem()
            let menu = NSMenu(title: title)
            items.forEach(menu.addItem)
            item.submenu = menu
            main.addItem(item)
        }
        func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        submenu("Site Showcase", [
            item("About Site Showcase", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            item("Hide Site Showcase", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            .separator(),
            item("Quit Site Showcase", #selector(NSApplication.terminate(_:)), "q"),
        ])
        submenu("File", [
            item("Open Output Folder", #selector(openOutputFolder), "o", [.command, .shift]),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        submenu("View", [
            item("Reload", #selector(reloadPage), "r"),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:)), ""),
        ])
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
