import Foundation

/// Item Prospecting (US-1107) — the thrift-aisle "snap it, don't type it" flow.
/// Mirrors `POST /api/flipdesk/scout/prospect`: send 1–2 photos (front + the
/// brand/size tag), the edge IDENTIFIES the item from the photo, resolves its
/// eBay category, and runs the condition-matched value + sell-through pipeline.
///
/// These types decode with a *plain* `JSONDecoder` (the edge returns camelCase
/// keys 1:1) — the same convention as ``ScoutService``/``CompsService``, NOT the
/// snake-casing shared decoder. The request encodes plainly for the same reason.

/// `POST /api/flipdesk/scout/prospect` request body. Images are base64 data URIs.
struct ProspectRequest: Encodable {
    let images: [String]
    /// What the reseller would pay (cents). Optional — unlocks the ROI verdict.
    let costCents: Int?
}

/// `POST /api/flipdesk/scout/prospect` response. When `identified` is false the
/// item couldn't be read off the photo and the comp fields are nil (with a
/// `note`); otherwise the headline numbers live in `stats` + `sellThrough`.
struct ProspectResponse: Decodable {
    let identified: Bool
    let item: ProspectItem
    let category: ProspectCategory?
    let grade: ProspectGrade?
    let stats: ProspectStats?
    let sellThrough: ProspectSellThrough?
    let costCents: Int?
    let decision: ProspectDecision?
    /// Deep link to eBay's SOLD/completed search for this item (browser).
    let ebaySoldSearchUrl: String?
    /// "active" today; "sold" once the Marketplace Insights grant lands.
    let source: String
    let disclaimer: String?
    let note: String?
}

/// The AI's read of the item off the photo (brand from the tag + keywords).
struct ProspectItem: Decodable {
    let brand: String?
    let title: String?
    let keywords: [String]
    let identifyConfidence: Double
}

struct ProspectCategory: Decodable {
    let id: String
    let path: String?
}

struct ProspectGrade: Decodable {
    let value: Double
    let tier: String?
    let confidence: Double
}

/// Comp distribution. `count` = how many comps backed the estimate;
/// `medianCents` = the going rate; low/high bracket the spread. Integer cents.
struct ProspectStats: Decodable {
    let count: Int
    let lowCents: Int?
    let medianCents: Int?
    let highCents: Int?
    let currency: String
    let confidence: Double
    let sufficient: Bool
}

/// Transparent sell-through forecast (heuristic from price position in the comp
/// range until a real velocity feed/Marketplace Insights lands).
struct ProspectSellThrough: Decodable {
    let sellThroughPct: Double
    let daysLow: Int
    let daysHigh: Int
    let label: String // fast | moderate | slow | unknown
    let sampleSize: Int
}

/// Buy / maybe / skip verdict + ROI math (only meaningful once a cost is given).
struct ProspectDecision: Decodable {
    let recommendation: String // buy | maybe | skip
    let estProceedsCents: Int?
    let estMarginCents: Int?
    let roiPct: Double?
    let breakevenCents: Int?
    let reason: String
    let confident: Bool
}

/// `POST /api/flipdesk/scout/buy` request — commits the prospect into inventory
/// at `sourced`. Reuses the existing Scout buy endpoint (no new edge route).
struct ProspectBuyRequest: Encodable {
    let title: String
    let brand: String?
    let size: String?
    let color: String?
    let costCents: Int?
    let targetCents: Int?
    let gradeValue: Double?
    let gradeLabel: String?
    let conditionNotes: String?
}

struct ProspectBuyResponse: Decodable {
    let id: String
    let status: String
}
