import Foundation

/// ScoutAI — the "grade what you don't own" deal finder. Mirrors the web
/// `use-scout` hook + `flipdesk-scout` edge route: a keyword/brand search
/// returns live eBay listings, each privately shadow-graded from its own
/// photos and ranked by condition-adjusted margin so underpriced gems rise
/// to the top.
///
/// These types decode with a *plain* `JSONDecoder` (the edge returns
/// camelCase keys, matching the property names 1:1) — NOT the shared
/// `.convertFromSnakeCase` decoder. The request likewise encodes with a
/// plain encoder so `categoryId` stays camelCase, which is what the edge
/// route reads.

/// `POST /api/flipdesk/scout` request body.
struct ScoutScanRequest: Encodable {
    let categoryId: String
    let q: String?
    let brand: String?
    let limit: Int
}

/// `POST /api/flipdesk/scout` response. `candidates` is empty (with a `note`)
/// when nothing matched; otherwise `disclaimer` is present.
struct ScoutScanResponse: Decodable {
    let scanned: Int
    let candidates: [ScoutCandidate]
    let disclaimer: String?
    let note: String?
}

/// One ranked candidate listing with its private shadow grade + arbitrage math.
/// Money fields are integer cents (as the edge sends them); the view divides
/// by 100 for display.
struct ScoutCandidate: Decodable, Identifiable, Equatable {
    let itemId: String
    let title: String
    let imageUrl: String?
    let itemWebUrl: String?
    let askingCents: Int?
    let shadowGrade: Double?
    let gradeConfidence: Double
    let valueLowCents: Int?
    let valueMedianCents: Int?
    let valueHighCents: Int?
    /// Net-of-fees estimated profit vs asking (cents); nil when not computable.
    let estMarginCents: Int?
    /// `estMarginCents / askingCents`.
    let estMarginPct: Double?
    let underpriced: Bool
    /// A real buy signal: sufficient comps + confident grade + positive margin.
    let actionable: Bool
    let reason: String
    /// US-2850: what the value behind this row actually is. The server has sent
    /// it since that story and the row dropped it, so a measured number and an
    /// unadjusted median looked identical on the phone.
    let valueBasis: ValueBasis?
    /// US-3097: the link to open.
    ///
    /// Nil today. US-3082 puts eBay's `itemAffiliateWebUrl` here, and decoding
    /// it NOW means the affiliate link starts flowing the day the server sends
    /// it, with no App Store release in between. `outboundURL` picks between
    /// this and `itemWebUrl`; nothing in the UI reads either directly.
    let url: String?

    var id: String { itemId }

    /// The URL a tap should open — affiliate when the server has one.
    var outboundURL: URL? {
        EbayOutboundURL.resolve(url: url, fallback: itemWebUrl)
    }
}
