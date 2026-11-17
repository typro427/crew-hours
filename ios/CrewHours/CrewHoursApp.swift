import SwiftUI

@main
struct CrewHoursApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
        }
    }
}

/// Which screen shows: the crew link setup, or the crew app.
final class AppState: ObservableObject {
    @Published var link: URL? = Config.crewLink

    func save(_ url: URL) {
        Config.crewLink = url
        link = url
    }

    func forget() {
        UserDefaults.standard.removeObject(forKey: Config.savedLinkKey)
        link = nil
    }
}

struct RootView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        if let link = state.link {
            CrewWebScreen(start: link)
                .ignoresSafeArea(.container, edges: .bottom)
        } else {
            SetupView()
        }
    }
}
