//
//  AppDelegate.swift
//  TT Gate
//
//  NO SceneDelegate, AND NO SwiftUI. Both are iOS 13. This app exists for iOS 12.5.7 — the
//  last release for the iPad Air 1 and mini 2/3 — so the window is created here, by hand,
//  the way it was before scenes. On a newer iPad this path still works unchanged; UIKit did
//  not remove it.
//

import UIKit

@UIApplicationMain
final class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = GateViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    /// Returning to the foreground must not leave a dead preview on the wall.
    ///
    /// iOS tears a capture session down when the app is backgrounded. The web layer restarts
    /// it, because it owns the decision about which camera — but it only knows to do so if it
    /// is told the page is visible again, which is what reloading `visibilitychange` handling
    /// in the page achieves. Nothing to do here beyond keeping the screen awake.
    func applicationDidBecomeActive(_ application: UIApplication) {
        application.isIdleTimerDisabled = true
    }
}
