import UIKit
import UserNotifications

/// Apple push notifications: asking permission, the phone's push token, and opening the right tab when one is tapped.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let pushResult = Notification.Name("CrewHoursPushResult")      // userInfo: the dictionary sent to the page
    static let openURL = Notification.Name("CrewHoursOpenURL")            // object: URL from a tapped notification

    /// A notification tapped before the app was open: opened once the crew app has loaded.
    static var pendingURL: URL?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        FenceMonitor.shared.wake()          // a guard arriving at or leaving the shack can wake the app
        return true
    }

    // MARK: asked for by the crew app

    /// What the phone's notification setting is; registers for a token if they're allowed.
    static func pushStatus() {
        UNUserNotificationCenter.current().getNotificationSettings { s in
            switch s.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }   // the token comes back below
            case .denied:
                post(["status": "denied"])
            default:
                post(["status": "notDetermined"])
            }
        }
    }

    /// Ask to allow notifications, then register.
    static func pushEnable() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { ok, err in
            if ok { DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() } }
            else { post(["status": "denied", "error": err?.localizedDescription ?? ""]) }
        }
    }

    private static func post(_ info: [String: Any]) {
        DispatchQueue.main.async { NotificationCenter.default.post(name: pushResult, object: nil, userInfo: info) }
    }

    // MARK: Apple's answers

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        let sandbox = true      // a build run straight from Xcode
        #else
        let sandbox = false     // TestFlight and the App Store
        #endif
        AppDelegate.post(["status": "granted", "token": token, "sandbox": sandbox])
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        AppDelegate.post(["status": "error", "error": "Notifications couldn't be set up on this phone: \(error.localizedDescription)"])
    }

    /// Show notifications even while the app is open.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    /// Tapped: open the tab it's about (Tasks, Water...).
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let s = response.notification.request.content.userInfo["url"] as? String, let url = URL(string: s) {
            AppDelegate.pendingURL = url
            NotificationCenter.default.post(name: AppDelegate.openURL, object: url)
        }
        completionHandler()
    }
}
