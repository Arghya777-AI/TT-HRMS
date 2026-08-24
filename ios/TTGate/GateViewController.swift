//
//  GateViewController.swift
//  TT Gate — the shell: a camera, a web view, and the bridge between them.
//
//  LAYERING, AND WHY IT IS THIS WAY ROUND
//  --------------------------------------
//      ┌─────────────────────────────┐
//      │  WKWebView   (transparent)  │  the entire gate UI, from tt-hrms.vercel.app/kiosk
//      ├─────────────────────────────┤
//      │  AVCaptureVideoPreviewLayer │  the live camera, composited by the GPU
//      └─────────────────────────────┘
//
//  The preview sits underneath and the web view is transparent where its viewfinder is —
//  `Viewfinder.tsx` renders `bg-transparent` and no <video> when it detects this shell. That
//  is what makes the camera visible at zero bridge cost: the pixels the HUMAN sees never
//  enter JavaScript. Only the frames RECOGNITION needs cross the bridge, one at a time, when
//  asked. Streaming every frame into JS would spend most of its effort on pixels whose only
//  job was to be looked at.
//
//  WHY THE UI IS NOT NATIVE
//  ------------------------
//  Because the descriptor must not change. The enrolled templates are face-api.js ResNet-34
//  vectors; reimplementing the screen natively would eventually mean reimplementing the
//  pipeline, and a different model — or the same model with a differently-aligned crop —
//  matches nobody. One codebase computes descriptors, and it is the one that enrolled
//  everybody. This shell contributes a camera and a window without a URL bar.
//

import UIKit
import WebKit

final class GateViewController: UIViewController {

    /// Where the gate lives. Overridable at build time so a staging deploy can be tested
    /// without editing source.
    private static var gateURL: URL {
        if let configured = Bundle.main.object(forInfoDictionaryKey: "TTGateURL") as? String,
           let url = URL(string: configured), !configured.isEmpty {
            return url
        }
        return URL(string: "https://tt-hrms.vercel.app/kiosk")!
    }

    /// Bumped when the message vocabulary changes. `nativeBridge.ts` refuses a shell whose
    /// version is below its own minimum, so this and MIN_SHELL_VERSION move together.
    private static let bridgeVersion = 1

    private let camera = CameraController()
    private let sound = SoundController()
    private var webView: WKWebView!

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        // The preview goes in first so it is behind everything added after it.
        camera.previewLayer.frame = view.bounds
        view.layer.addSublayer(camera.previewLayer)

        webView = makeWebView()
        view.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])

        webView.load(URLRequest(url: GateViewController.gateURL))
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        camera.previewLayer.frame = view.bounds
        // Pushed from here, on the main thread, because `grabFrame` needs it on a background
        // queue where UIKit cannot be read. See CameraController.setInterfaceOrientation.
        camera.setInterfaceOrientation(UIApplication.shared.statusBarOrientation)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // A gate must not sleep. It is on a wall with nobody to wake it, and a sleeping
        // terminal is one that silently stops recording attendance.
        UIApplication.shared.isIdleTimerDisabled = true
    }

    override var prefersStatusBarHidden: Bool { return true }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        return .all
    }

    // MARK: - Web view

    private func makeWebView() -> WKWebView {
        let controller = WKUserContentController()
        controller.add(self, name: "ttGate")

        /*
          Injected at documentStart, so it exists before the gate's own scripts run.
          `isNativeShell()` is the first thing the page asks, and a shell announced too late
          would leave the app trying to use `getUserMedia` — which on iOS 12 is the one thing
          that cannot work.
        */
        let announce = """
        window.TTGateNative = {
          version: \(GateViewController.bridgeVersion),
          platform: "ios",
          osVersion: "\(UIDevice.current.systemVersion)"
        };
        """
        controller.addUserScript(
            WKUserScript(source: announce, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self

        /*
          Transparent, all three of these. `isOpaque = false` alone is not enough — UIKit
          still paints the backgrounds — and any one of them left opaque hides the camera
          preview completely, which presents as a dead camera rather than as a styling bug.
        */
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear

        // A gate is a fixed installation. Bouncing and zooming are how a wall-mounted screen
        // ends up scrolled halfway off itself with nobody to put it back.
        web.scrollView.bounces = false
        web.scrollView.isScrollEnabled = false
        return web
    }

    // MARK: - Bridge replies

    private func reply(type: String, value: String) {
        let script = "window.__ttGateControl && window.__ttGateControl({type:\"\(type)\",value:\"\(value)\"})"
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    private func deliver(frame: (dataURL: String, width: Int, height: Int)?) {
        /*
          A miss must still be answered. `nativeGrabFrame` has a two-second timeout, and
          letting it expire would stall the scan loop for two seconds on every frame the
          camera had not produced yet — the session takes a moment to deliver its first one.
          An empty string is the "nothing yet" answer, which JS treats as no face this frame.
        */
        guard let frame = frame else {
            evaluateFrame(dataURL: "", width: 0, height: 0)
            return
        }
        evaluateFrame(dataURL: frame.dataURL, width: frame.width, height: frame.height)
    }

    private func evaluateFrame(dataURL: String, width: Int, height: Int) {
        // The data URL is base64 — no quotes, no backslashes, nothing that needs escaping —
        // so string interpolation into a JS call is safe here specifically.
        let script = "window.__ttGateFrame && window.__ttGateFrame(\"\(dataURL)\",\(width),\(height))"
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }
}

// MARK: - Messages from the page

extension GateViewController: WKScriptMessageHandler {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
              let op = body["op"] as? String else { return }

        switch op {
        case "cameraPermission":
            let status = CameraController.authorisation()
            reply(type: "cameraPermission", value: status == .authorized ? "granted"
                : (status == .notDetermined ? "unknown" : "denied"))

        case "startCamera":
            let facing = CameraController.Facing(rawValue: (body["facing"] as? String) ?? "back") ?? .back
            camera.start(facing: facing) { [weak self] ok in
                self?.reply(type: "cameraPermission", value: ok ? "granted" : "denied")
            }

        case "stopCamera":
            camera.stop()

        case "playSound":
            /*
              The web layer decides WHEN and WHICH; the shell decides HOW. Native audio is not
              subject to the autoplay rule that keeps Web Audio mute on an untouched
              wall-mounted terminal, and its session ignores a muted device — neither of which
              the page can do anything about from inside a WebView.
            */
            let kind = (body["kind"] as? String) ?? "recorded"
            sound.play(kind: kind)

        case "grabFrame":
            // Off the main thread: the JPEG encode is the most expensive thing this shell
            // does, and doing it on the main thread would visibly stutter the preview.
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self = self else { return }
                self.deliver(frame: self.camera.grabFrame())
            }

        default:
            break
        }
    }
}

// MARK: - Navigation

extension GateViewController: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        show(error: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        show(error: error)
    }

    /// The gate could not be loaded — say so, and offer the one action that helps.
    ///
    /// A wall-mounted terminal showing a blank white web view is the failure this whole
    /// project has already been bitten by once. It gets words.
    private func show(error: Error) {
        let alert = UIAlertController(
            title: "Cannot reach the gate",
            message: "\(error.localizedDescription)\n\n\(GateViewController.gateURL.absoluteString)",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Try again", style: .default) { [weak self] _ in
            guard let self = self else { return }
            self.webView.load(URLRequest(url: GateViewController.gateURL))
        })
        present(alert, animated: true)
    }
}
