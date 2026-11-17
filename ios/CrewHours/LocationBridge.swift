import CoreLocation
import UIKit

/// The phone's GPS for the crew app's "Start drive". The web page asks for positions the usual way
/// (navigator.geolocation); the app answers from here, and keeps recording with the phone locked
/// (the blue location pill shows while it does). Positions taken while locked are handed to the page
/// when it's opened again, with the time each was taken.
final class LocationBridge: NSObject, CLLocationManagerDelegate {
    /// Sends JavaScript to the page.
    var run: ((String) -> Void)?

    private let manager = CLLocationManager()
    private var watching = Set<Int>()
    private var wantOnce = false
    private var held: [CLLocation] = []          // positions waiting for the page to be active again
    private var started = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 5
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        NotificationCenter.default.addObserver(self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    func handle(_ msg: [String: Any]) {
        switch msg["type"] as? String {
        case "geo.watch":
            if let id = msg["id"] as? Int { watching.insert(id) }
            begin()
        case "geo.clear":
            if let id = msg["id"] as? Int { watching.remove(id) }
            if watching.isEmpty && !wantOnce { stop() }
        case "geo.once":
            wantOnce = true
            begin()
        default: break
        }
    }

    private func begin() {
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()          // starts once they answer (below)
        case .denied, .restricted:
            fail(1, "Location is off for Crew Hours. Turn it on in Settings \u{203A} Crew Hours \u{203A} Location \u{203A} While Using the App.")
        default:
            if !watching.isEmpty && !manager.allowsBackgroundLocationUpdates {
                manager.allowsBackgroundLocationUpdates = true      // keep going with the phone locked during a drive
                manager.showsBackgroundLocationIndicator = true
            }
            guard !started else { return }
            started = true
            manager.startUpdatingLocation()
        }
    }

    private func stop() {
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        started = false
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            if !watching.isEmpty || wantOnce { begin() }
        case .denied, .restricted:
            if !watching.isEmpty || wantOnce { fail(1, "Location is off for Crew Hours. Turn it on in Settings \u{203A} Crew Hours \u{203A} Location.") }
        default: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        held.append(contentsOf: locations)
        if held.count > 20000 { held.removeFirst(held.count - 20000) }
        deliver()
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .denied { fail(1, "Location is off for Crew Hours.") }
        // other errors (no fix yet) are temporary: keep waiting
    }

    @objc private func becameActive() { deliver() }

    /// Hand positions to the page; while the phone is locked they wait here.
    private func deliver() {
        guard UIApplication.shared.applicationState != .background, let run = run, !held.isEmpty else { return }
        let batch = held; held.removeAll()
        let items = batch.map { l -> String in
            let ms = Int(l.timestamp.timeIntervalSince1970 * 1000)
            return String(format: "{lat:%.7f,lon:%.7f,acc:%.1f,alt:%.1f,spd:%.2f,hdg:%.1f,t:%ld}",
                          l.coordinate.latitude, l.coordinate.longitude, l.horizontalAccuracy, l.altitude, max(l.speed, 0), max(l.course, 0), ms)
        }
        run("(function(a){a.forEach(function(p){window.CrewHoursNative&&CrewHoursNative._pos(p);});})([\(items.joined(separator: ","))]);")
        if wantOnce { wantOnce = false; if watching.isEmpty { stop() } }
    }

    private func fail(_ code: Int, _ message: String) {
        let m = message.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        run?("window.CrewHoursNative&&CrewHoursNative._err(\(code),'\(m)');")
        wantOnce = false
    }
}
