import CoreLocation
import UIKit
import Security

/// Guard shack geofence. The crew app tells the phone where the shack is (only for guards who have
/// "clock in and out at the guard shack" switched on). iPhone then watches that circle itself, even with the
/// app closed, and the app tells Crew Hours "arrived" or "left"; the guard's time sheet clocks them in or out.
final class FenceMonitor: NSObject, CLLocationManagerDelegate {
    static let shared = FenceMonitor()
    private let manager = CLLocationManager()
    private let regionId = "crewhours.guardshack"
    private let defaultsKey = "fence.config"          // { lat, lon, radius, url } (the sign-in is kept in the Keychain)

    override init() {
        super.init()
        manager.delegate = self
    }

    /// Called at launch so iPhone can hand over an arrival or departure that woke the app.
    func wake() { _ = manager }

    // MARK: from the crew app

    func set(_ msg: [String: Any]) {
        guard let lat = msg["lat"] as? Double, let lon = msg["lon"] as? Double,
              let url = msg["url"] as? String, let token = msg["token"] as? String else { return }
        let radius = min(max((msg["radius"] as? Double) ?? 100, 50), 1000)
        UserDefaults.standard.set(["lat": lat, "lon": lon, "radius": radius, "url": url], forKey: defaultsKey)
        Keychain.set(token, for: "fence.token")
        // Watching a place with the app closed needs "Always" location. iPhone asks in two steps: While Using first.
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
        default: break
        }
        startWatching()
    }

    func clear() {
        for r in manager.monitoredRegions where r.identifier == regionId { manager.stopMonitoring(for: r) }
        UserDefaults.standard.removeObject(forKey: defaultsKey)
        Keychain.set(nil, for: "fence.token")
    }

    private func startWatching() {
        guard let c = UserDefaults.standard.dictionary(forKey: defaultsKey),
              let lat = c["lat"] as? Double, let lon = c["lon"] as? Double, let radius = c["radius"] as? Double,
              CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: lat, longitude: lon),
                                      radius: min(radius, manager.maximumRegionMonitoringDistance), identifier: regionId)
        region.notifyOnEntry = true
        region.notifyOnExit = true
        if let old = manager.monitoredRegions.first(where: { $0.identifier == regionId }) as? CLCircularRegion,
           old.center.latitude == lat, old.center.longitude == lon, old.radius == region.radius { return }   // already watching it
        manager.startMonitoring(for: region)
    }

    // MARK: iPhone's answers

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard UserDefaults.standard.dictionary(forKey: defaultsKey) != nil else { return }
        if manager.authorizationStatus == .authorizedWhenInUse { manager.requestAlwaysAuthorization() }
        if manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse { startWatching() }
    }

    func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        if region.identifier == regionId { report("enter") }
    }

    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        if region.identifier == regionId { report("exit") }
    }

    func locationManager(_ manager: CLLocationManager, didStartMonitoringFor region: CLRegion) {
        manager.requestState(for: region)          // already standing in it when it was set up: counts as arriving
    }

    func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
        if region.identifier == regionId && state == .inside && !UserDefaults.standard.bool(forKey: "fence.sentInside") {
            UserDefaults.standard.set(true, forKey: "fence.sentInside")
            report("enter")
        }
    }

    /// Tell Crew Hours. With no signal it tries again a few times; the time sent is when it happened.
    private func report(_ event: String, at: Date = Date(), attempt: Int = 0) {
        if event == "exit" { UserDefaults.standard.set(false, forKey: "fence.sentInside") }
        guard let c = UserDefaults.standard.dictionary(forKey: defaultsKey), let s = c["url"] as? String, let url = URL(string: s),
              let token = Keychain.get("fence.token") else { return }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "x-ch")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let iso = ISO8601DateFormatter().string(from: at)
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["event": event, "at": iso])
        // a little time to finish sending if iPhone woke the app in the background just for this
        let bg = BackgroundTask()
        bg.id = UIApplication.shared.beginBackgroundTask { bg.end() }
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse).map { $0.statusCode < 500 } ?? false
            DispatchQueue.main.async {
                if !ok && attempt < 5 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + Double(30 * (attempt + 1))) { self.report(event, at: at, attempt: attempt + 1) }
                }
                bg.end()
            }
        }.resume()
    }
}

/// iPhone's "let me finish this in the background" ticket, ended once.
final class BackgroundTask: @unchecked Sendable {
    var id: UIBackgroundTaskIdentifier = .invalid
    func end() {
        DispatchQueue.main.async {
            guard self.id != .invalid else { return }
            UIApplication.shared.endBackgroundTask(self.id)
            self.id = .invalid
        }
    }
}

/// The guard's sign-in for the shack reports, kept in the Keychain rather than in plain settings.
enum Keychain {
    static func set(_ value: String?, for key: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
        guard let v = value, let data = v.data(using: .utf8) else { return }
        var add = q
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
    static func get(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
}
