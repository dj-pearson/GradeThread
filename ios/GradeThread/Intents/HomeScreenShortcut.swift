import UIKit

/// US-3101 — the three home-screen quick actions, as a type rather than three
/// string comparisons in a delegate method.
///
/// The strings live in `Info.plist` under `UIApplicationShortcutItems` and are
/// matched here. A typo in either place is a shortcut that silently does
/// nothing, which is why `ShortcutItemTests` reads the plist and asserts the two
/// lists agree — the kind of break that no compiler catches and no crash
/// reports.
enum HomeScreenShortcut: String, CaseIterable {
    case prospect = "com.gradethread.app.shortcut.prospect"
    case addItem = "com.gradethread.app.shortcut.addItem"
    case scout = "com.gradethread.app.shortcut.scout"

    /// Where each one lands.
    var route: DeepLinkRoute {
        switch self {
        case .prospect: return .prospect
        case .addItem: return .addItem
        case .scout: return .scout
        }
    }

    /// Pure, so the mapping is testable without a UIApplication.
    static func route(forType type: String) -> DeepLinkRoute? {
        HomeScreenShortcut(rawValue: type)?.route
    }

    /// Handle one shortcut tap.
    ///
    /// Posts through ``DeepLinkRouter``, the same bus a push tap and an App
    /// Intent use, which is what makes the COLD-LAUNCH case work for free: the
    /// router holds the route until the SwiftUI layer subscribes, and
    /// ContentView drains it in `.task` (US-1410). A shortcut handled by
    /// reaching into view state instead would be dropped on a cold launch,
    /// which is the launch a shortcut most often causes.
    @discardableResult
    static func handle(_ item: UIApplicationShortcutItem) -> Bool {
        guard let route = route(forType: item.type) else { return false }
        // BOTH, in this order. `post` serves the warm case (the app was already
        // running and ContentView is subscribed); `persistPending` serves the
        // cold one, which is the common case for a quick action — nobody
        // long-presses the icon of an app that is already open in front of them.
        // ContentView's `.task` drains the token, and the warm path clears it,
        // so exactly one of the two ever fires.
        DeepLinkRouter.post(route)
        DeepLinkRouter.persistPending(route)
        return true
    }
}
