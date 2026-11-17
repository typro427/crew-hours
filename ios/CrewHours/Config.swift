import Foundation

/// The settings you might change before building.
enum Config {
    /// The website the crew app lives on. It must also be listed under WKAppBoundDomains in Config/Info.plist.
    static let host = "mycrewhours.com"

    /// Your company's crew link, e.g. "https://mycrewhours.com/c/deerfield-water-system/".
    /// Fill it in and the app opens straight to your crew's PIN screen; leave it empty and the app asks for it the first time.
    static let defaultCrewLink = ""

    /// Where the crew link is remembered on the phone.
    static let savedLinkKey = "crewLink"

    /// The crew link this phone uses, if it has one.
    static var crewLink: URL? {
        get {
            if let s = UserDefaults.standard.string(forKey: savedLinkKey), let u = URL(string: s) { return u }
            return defaultCrewLink.isEmpty ? nil : normalize(defaultCrewLink)
        }
        set { UserDefaults.standard.set(newValue?.absoluteString, forKey: savedLinkKey) }
    }

    /// Accepts a full link, a link without https://, or just the company's code ("deerfield-water-system").
    /// Returns https://<host>/c/<code>/ or nil if it isn't a crew link.
    static func normalize(_ input: String) -> URL? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.contains("/") && !s.contains(".") {   // just the code
            s = "https://\(host)/c/\(s)/"
        }
        if !s.lowercased().hasPrefix("http") { s = "https://" + s }
        guard let u = URL(string: s), let h = u.host?.lowercased(), h == host || h == "www." + host else { return nil }
        let parts = u.path.split(separator: "/").map(String.init)
        guard parts.count >= 2, parts[0] == "c", parts[1].range(of: "^[a-z0-9-]{2,60}$", options: .regularExpression) != nil else { return nil }
        return URL(string: "https://\(host)/c/\(parts[1])/")
    }
}
