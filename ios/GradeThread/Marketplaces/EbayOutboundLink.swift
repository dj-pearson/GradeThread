import SwiftUI
import UIKit

/// US-3097 — the ONE way this app hands a seller to eBay.
///
/// Two things were wrong with the old call sites, and they are related.
///
/// **The link opened in the wrong place.** Scout rows and the Prospect
/// sold-comps links were SwiftUI `Link`s, which resolve through
/// `openURL` and land in an in-app browser view. iOS hands an `ebay.com`
/// universal link to the installed eBay app only when the open goes through
/// `UIApplication.open` — so a seller standing in a thrift store, signed in to
/// the eBay app, was dropped into a signed-out web page and had to sign in
/// again before they could buy. That is the whole feature, lost to a view
/// modifier.
///
/// **The URL was built in three places.** Once GradeThread's eBay Partner
/// Network attribution lands (US-3082), the edge returns an affiliate URL in a
/// `url` field and every surface has to use it or the commission is not
/// credited. A per-surface `Link(destination:)` is three places for that to be
/// forgotten. This helper is the single door, and `EbayOutboundURL.resolve`
/// prefers `url` over `itemWebUrl` TODAY, so when the server starts sending the
/// affiliate form the phone follows with no client release.
///
/// **No `ebay://` scheme, and no `LSApplicationQueriesSchemes` entry.** A custom
/// scheme is neither needed nor wanted here: `open` on an `https://www.ebay.com`
/// link already reaches the app through eBay's own universal-link association,
/// and it degrades to Safari when the app is not installed. Declaring a scheme
/// would add a queryable app to the privacy manifest surface for nothing.
enum EbayOutboundURL {
    /// Prefer the server's `url` (affiliate once US-3082 ships), fall back to
    /// the plain listing URL.
    ///
    /// Pure and `static` so the precedence is unit-testable without a UI.
    /// Returns nil rather than a placeholder: a link that goes nowhere is worse
    /// than no link, because the seller taps it.
    static func resolve(url: String?, fallback: String?) -> URL? {
        for candidate in [url, fallback] {
            guard let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !trimmed.isEmpty,
                  let parsed = URL(string: trimmed),
                  let scheme = parsed.scheme?.lowercased(),
                  scheme == "https"
            else { continue }
            return parsed
        }
        return nil
    }

    /// True when the resolved URL carries eBay Partner Network attribution.
    ///
    /// Read off the query rather than off which field it came from: the edge is
    /// free to put an affiliate URL in either, and a flag that trusts the field
    /// name would report the wrong thing the day that changes.
    static func isAffiliate(_ url: URL) -> Bool {
        guard let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
            return false
        }
        return query.contains { $0.name == "campid" || $0.name == "mkcid" }
    }
}

/// A button that opens an eBay listing in the eBay app when it is installed.
///
/// Deliberately a `Button` over `UIApplication.open` rather than a `Link`. See
/// the note on ``EbayOutboundURL`` for why that distinction decides whether the
/// seller can buy the item they are holding.
struct EbayOutboundLink<Label: View>: View {
    /// The affiliate URL when the server sends one, else the listing URL.
    let url: URL
    /// Where the tap came from, for the telemetry event. A short stable id.
    let surface: String
    @ViewBuilder let label: () -> Label

    var body: some View {
        Button {
            AppRouter.haptic()
            Telemetry.event(
                TelemetryEvent.scoutOutboundOpen,
                props: [
                    "platform": "ios",
                    "surface": surface,
                    // Whether EPN attribution was on the link that was opened.
                    // This is what lets an eBay Partner Network click report be
                    // reconciled against opens the app actually performed —
                    // without it, a commission gap and a broken link look the
                    // same from here. No user identifier beyond the session key
                    // Telemetry already attaches.
                    "affiliate": EbayOutboundURL.isAffiliate(url),
                ]
            )
            UIApplication.shared.open(url)
        } label: {
            label()
        }
    }
}
