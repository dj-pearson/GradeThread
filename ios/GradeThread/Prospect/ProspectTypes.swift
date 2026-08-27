import Foundation

/// Item Prospecting (US-1107) — the thrift-aisle "snap it, don't type it" flow.
/// Mirrors `POST /api/flipdesk/scout/prospect`: send 1–2 photos (front + the
/// brand/size tag), the edge IDENTIFIES the item from the photo, resolves its
/// eBay category, and runs the condition-matched value + sell-through pipeline.
///
/// These types decode with a *plain* `JSONDecoder` (the edge returns camelCase
/// keys 1:1) — the same convention as ``ScoutService``/``CompsService``, NOT the
/// snake-casing shared decoder. The request encodes plainly for the same reason.

/// What a submitted photo SHOWS. Sent as `imageRoles`, parallel to `images`, and
/// it is the ONLY thing that decides who identifies the item server-side.
///
/// US-2923: this is why the capture screen has named slots rather than a generic
/// strip of two. Guessing the role from a photo's POSITION was the tempting
/// shortcut and it is the wrong one: a seller who photographs only the care
/// label would have had it labelled `front`, and US-2758 measured a care label
/// returning a midi dress, joggers and a mini skirt with no expressed doubt.
enum ProspectPhotoRole: String, Codable, CaseIterable {
    /// The garment itself. The case eBay visual search measured best on.
    case front
    /// The brand or size tag. Text on the garment beats a similarity match.
    case tag

    var label: String {
        switch self {
        case .front: return String(localized: "Item photo")
        case .tag: return String(localized: "Brand tag")
        }
    }

    var hint: String {
        switch self {
        case .front: return String(localized: "The whole garment, flat or on a hanger")
        case .tag: return String(localized: "The brand or size label, close up")
        }
    }

    var systemImage: String {
        switch self {
        case .front: return "tshirt"
        case .tag: return "tag"
        }
    }
}

/// `POST /api/flipdesk/scout/prospect` request body. Images are base64 data URIs.
///
/// Carries BOTH shapes the route accepts: an ordinary scan (photos plus roles)
/// and a US-2923 re-pull (a corrected title, no photos). One struct because it
/// is one endpoint and one response shape; ``repull(title:brand:gradeValue:gradeTier:costCents:)``
/// is what makes the second unambiguous at the call site.
struct ProspectRequest: Encodable {
    let images: [String]
    /// Parallel to `images`. Empty on a re-pull, which submits no photos.
    let imageRoles: [String]
    /// What the reseller would pay (cents). Optional — unlocks the ROI verdict.
    let costCents: Int?
    /// US-1861: present ONLY while the Thrift Radar contribution switch is on.
    /// The server uses it to derive a coarse area cell and discards it in the
    /// same request; there is no column for it. Both must be sent or neither —
    /// a half fix is refused server-side rather than guessed at.
    let lat: Double?
    let lng: Double?
    /// US-2923: the seller's corrected title. Its PRESENCE is what makes this a
    /// re-pull, so it is nil on every ordinary scan.
    let titleOverride: String?
    let brandOverride: String?
    /// Carried across from the run being corrected, never recomputed.
    let gradeValue: Double?
    let gradeTier: String?

    init(images: [String], roles: [ProspectPhotoRole], costCents: Int?, fix: RadarFix? = nil) {
        self.init(
            images: images,
            imageRoles: roles.map { $0.rawValue },
            costCents: costCents,
            lat: fix?.latitude,
            lng: fix?.longitude,
            titleOverride: nil,
            brandOverride: nil,
            gradeValue: nil,
            gradeTier: nil
        )
    }

    /// A US-2923 re-pull: the seller typed the right title, so the server
    /// identifies nothing and grades nothing.
    ///
    /// No photos, and no Thrift Radar fix either — a re-pull corrects a scan
    /// already recorded rather than making a new one, and sending a coordinate
    /// would ask to double-count one garment in the shared map.
    static func repull(
        title: String,
        brand: String?,
        gradeValue: Double?,
        gradeTier: String?,
        costCents: Int?
    ) -> ProspectRequest {
        ProspectRequest(
            images: [],
            imageRoles: [],
            costCents: costCents,
            lat: nil,
            lng: nil,
            titleOverride: title,
            brandOverride: brand,
            gradeValue: gradeValue,
            gradeTier: gradeTier
        )
    }

    private init(
        images: [String],
        imageRoles: [String],
        costCents: Int?,
        lat: Double?,
        lng: Double?,
        titleOverride: String?,
        brandOverride: String?,
        gradeValue: Double?,
        gradeTier: String?
    ) {
        self.images = images
        self.imageRoles = imageRoles
        self.costCents = costCents
        self.lat = lat
        self.lng = lng
        self.titleOverride = titleOverride
        self.brandOverride = brandOverride
        self.gradeValue = gradeValue
        self.gradeTier = gradeTier
    }
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
    /// US-2763 AC5, decoded here as of US-2923: HOW the title was arrived at —
    /// "barcode", "tag", "visual" or "seller".
    ///
    /// The server has always sent this and the app has always dropped it, which
    /// left the seller unable to tell "we read this off the tag" from "it looks
    /// like these" — the one thing that says whether a title is worth
    /// correcting. Optional, so an older server and the not-identified response
    /// both still decode.
    let identitySource: String?
    /// May the title be trusted without the seller confirming it? Only a barcode
    /// or the seller's own correction says yes.
    let identityIsAuthoritative: Bool?

    /// Should the card invite the seller to check this title? True for a
    /// similarity match, which US-2758 measured being equally confident when
    /// right and when wrong.
    var isUnverifiedGuess: Bool {
        identitySource == "visual" && identityIsAuthoritative != true
    }

    /// Plain-English provenance for the result card. Nil when the server said
    /// nothing, so the card makes no claim rather than inventing one.
    var sourceLabel: String? {
        switch identitySource {
        case "seller": return String(localized: "You set this title")
        case "tag": return String(localized: "Read off the tag")
        case "barcode": return String(localized: "From the barcode")
        case "visual": return String(localized: "Matched on looks")
        default: return nil
        }
    }
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
