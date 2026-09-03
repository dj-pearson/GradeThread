import Foundation

/// Deep-link destinations the home-screen widget opens on tap (US-752).
///
/// The widget runs in its own process and can only hand the app a URL (via
/// `.widgetURL` / `Link`), so it builds one of these and the app parses it
/// back in `onOpenURL`. Both targets compile this file (project.yml lists
/// `Shared/` under the app and the widget extension), so the URL contract
/// lives in exactly one place instead of being string-duplicated.
///
/// The custom scheme (`com.gradethread.app`) is shared with the OAuth /
/// auth-callback flow, so widget links use a dedicated `widget` host that the
/// auth-callback matcher (`AuthStore.isAcceptableAuthCallback`, host ==
/// `auth-callback`) deliberately ignores — a widget tap can never be mistaken
/// for an auth redirect, and vice-versa.
public enum WidgetDeepLink: String, CaseIterable, Sendable {
    /// Active-listings metric → the Marketplaces hub.
    case marketplaces
    /// Sold-today + payout metrics → the Money/Sales surface.
    case money
    /// US-3101: the sourcing camera, from the Lock Screen widget.
    ///
    /// The only widget destination that is an ACTION rather than a number. It
    /// exists because the moment a reseller needs Prospect is the moment they
    /// are holding a garment in a shop, and every path to it went through
    /// unlocking, finding the app, and finding a grid icon inside it.
    case prospect

    private static let scheme = "com.gradethread.app"
    static let host = "widget"

    /// The URL the widget attaches to a tappable region:
    /// `com.gradethread.app://widget/<destination>`.
    public var url: URL {
        URL(string: "\(Self.scheme)://\(Self.host)/\(rawValue)")!
    }

    /// Parses a tapped URL back to a widget destination. Returns nil for any
    /// URL that isn't one of ours (auth callbacks, OAuth redirects, unknown
    /// paths), so the caller can fall through to its other URL handlers.
    public static func from(url: URL) -> WidgetDeepLink? {
        guard url.scheme?.lowercased() == scheme,
              url.host?.lowercased() == host else { return nil }
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return WidgetDeepLink(rawValue: path)
    }
}
