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
    // ── US-3099: what the phone read before it uploaded anything ────────────
    //
    // The tag OCR and the barcode scanner both run on-device, for free, offline,
    // in the time the shutter takes. Sending what they read lets the server skip
    // a metered AI action spent re-reading the same tag from a JPEG that had to
    // be uploaded first. The server applies its own confidence floor
    // (lib/prospect-onboard-hints.ts); the phone reports, it does not decide.
    /// A scanned retail barcode. Checksummed, so the server trusts it outright.
    let barcode: String?
    /// Brand read off the tag by Vision.
    let brandHint: String?
    /// Size read off the tag by Vision.
    let sizeHint: String?
    /// Vision's own confidence in the two hints above, 0..1.
    let hintConfidence: Double?

    init(
        images: [String],
        roles: [ProspectPhotoRole],
        costCents: Int?,
        fix: RadarFix? = nil,
        hints: OnDeviceHints = .none
    ) {
        self.init(
            images: images,
            imageRoles: roles.map { $0.rawValue },
            costCents: costCents,
            lat: fix?.latitude,
            lng: fix?.longitude,
            titleOverride: nil,
            brandOverride: nil,
            gradeValue: nil,
            gradeTier: nil,
            barcode: hints.barcode,
            brandHint: hints.brand,
            sizeHint: hints.size,
            hintConfidence: hints.confidence
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
            gradeTier: gradeTier,
            // A re-pull carries no photos, so it has nothing the phone read.
            barcode: nil,
            brandHint: nil,
            sizeHint: nil,
            hintConfidence: nil
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
    /// US-3097: the sourcing ceiling — the most to pay and still clear the
    /// target return. The server has sent this since US-2851 and the app
    /// dropped it, which left the single most useful number for someone
    /// standing over a rack with a price tag in their hand off the screen.
    let ceiling: ProspectCeiling?
    /// Deep link to eBay's SOLD/completed search for this item (browser).
    let ebaySoldSearchUrl: String?
    /// US-3026: the words that link searches for.
    ///
    /// Shown next to the link rather than hidden behind it. A link whose query
    /// is invisible is a link nobody can tell is broken, which is how a
    /// brand-only sold search survived: the seller saw "See sold comps on eBay",
    /// tapped it, and had to work out for themselves that they were looking at
    /// every We The Free garment ever listed instead of their cropped top.
    let ebaySoldSearchQuery: String?
    /// The wider search: brand plus garment type, nothing else.
    ///
    /// Offered ALONGSIDE the specific one because precision can overshoot - eBay
    /// ANDs every term, so a well-described unusual garment can return an empty
    /// page, which reads as "nothing like this ever sold". Nil when it would
    /// open the same page as the specific link.
    let ebayBroadSearchUrl: String?
    let ebayBroadSearchQuery: String?
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

    // US-3026: the identification in FIELDS rather than only as a title.
    //
    // The buy sheet used to send `size: nil, color: nil` with a comment saying
    // the prospect payload did not carry them. It does now, and the catalog step
    // starts from what the AI actually read off the tag instead of from a blank
    // item the seller re-types. Every one is optional: a tag macro with no
    // garment in frame legitimately yields a brand and nothing else.

    /// The head noun: "cropped top", "flannel shirt".
    let garmentType: String?
    /// The dominant colour, one word.
    let color: String?
    /// Main fabric, when the care label states it.
    let material: String?
    /// "women" | "men" | "unisex" | "kids".
    let gender: String?
    /// Size as printed on the tag.
    let size: String?
    /// The brand's own product code off the tag.
    let styleCode: String?

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
    /// US-3097 / US-2850: what this number actually IS. Optional so a response
    /// from before the provenance shipped still decodes.
    let basis: ValueBasis?
}

/// Where a price came from, written by the server.
///
/// The WORDS are not built here. `headline` and `detail` arrive already
/// phrased from services/edge-functions/src/lib/value-disclosure.ts, for the
/// same reason the web's `ValueBasisNote` does not write them: a sentence about
/// provenance that lives next to one surface's markup eventually says something
/// another surface contradicts. This type decides nothing except how to decode.
struct ValueBasis: Decodable, Equatable {
    /// "measured_curve" | "comp_median".
    let source: String
    /// "active_asking" | "sold_realized" — asking prices until the Marketplace
    /// Insights grant lands.
    let prices: String
    let sampleSize: Int
    let headline: String
    let detail: String?
}

/// US-2851's sourcing ceiling, decoded.
///
/// NOTE ON THE FIELD NAME: the server calls it `maxPriceCents`
/// (`SourcingCeiling` in lib/scout-decision.ts). US-3097's acceptance criterion
/// said `maxBuyCents`, which is not a key the edge has ever sent — decoding
/// that name would have produced a permanently absent ceiling that looked like
/// a server that never computes one.
struct ProspectCeiling: Decodable, Equatable {
    /// Highest price to pay and still clear `targetRoi`. Nil when unavailable,
    /// and then `absentReason` says why.
    let maxPriceCents: Int?
    /// The target actually applied, as a fraction. 0.3 = 30%.
    let targetRoi: Double
    /// Net-of-fees resale at the condition-adjusted median.
    let netResaleCents: Int?
    /// "no_measured_curve" | "insufficient_comps" | "no_headroom", or nil.
    let absentReason: String?

    /// Why there is no ceiling, in the seller's words.
    ///
    /// Every one of these says what is MISSING rather than apologising, because
    /// the honest answer here is that we do not know this garment well enough
    /// yet, and a vaguer sentence would read as a bug in the app.
    var absentCopy: String? {
        switch absentReason {
        case "no_measured_curve":
            return String(localized: "No ceiling yet: we have not measured how condition moves the price for this kind of item.")
        case "insufficient_comps":
            return String(localized: "No ceiling yet: too few comparable listings to price this one.")
        case "no_headroom":
            return String(localized: "No ceiling: after fees there is nothing left at this item's going rate.")
        default:
            return nil
        }
    }
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
    /// US-3100: the eBay leaf category the scan resolved, written to
    /// `ebay_category_id` on the new row. The composer opens on it instead of
    /// asking the seller for a category the app already worked out.
    let categoryId: String?
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

/// US-3100 — what "Add to inventory" sends, from a live scan OR a saved verdict.
///
/// Prospect could only ever commit the result currently on screen, because the
/// buy request was assembled inline from a ``ProspectResponse``. A saved verdict
/// is the same garment described by fewer fields, and re-scanning it to get an
/// object of the right TYPE would spend a metered AI action to learn nothing.
///
/// So both sources map to this, and one commit path serves both. The mapping is
/// a plain value type with no I/O, which is what makes "the saved row commits
/// the same thing the live scan would have" a claim a test can check.
struct ProspectCommit: Equatable {
    var title: String
    var brand: String?
    var size: String?
    var color: String?
    /// The eBay leaf category, which becomes `ebay_category_id` on the item so
    /// the composer opens on the right category instead of asking again.
    var categoryId: String?
    /// The human-readable path. There is no column for it — it rides in the
    /// notes, where the catalog step reads it.
    var categoryPath: String?
    var costCents: Int?
    var targetCents: Int?
    var gradeValue: Double?
    var gradeLabel: String?
    var keywords: [String]

    /// From a live scan. Nil when there is nothing to commit: an unidentified
    /// result has no title, and an inventory row called "" is worse than none.
    init?(_ result: ProspectResponse) {
        guard result.identified, let title = result.item.title, !title.isEmpty else { return nil }
        self.title = title
        self.brand = result.item.brand
        self.size = result.item.size
        self.color = result.item.color
        self.categoryId = result.category?.id
        self.categoryPath = result.category?.path
        // US-1275: the cost the run was COMPUTED with, not whatever is in the
        // field now. If the seller edited it after the run, the grade and target
        // below still come from the earlier one, and persisting the new cost
        // would store a verdict the comps never used.
        self.costCents = result.costCents
        self.targetCents = result.stats?.medianCents
        self.gradeValue = result.grade?.value
        self.gradeLabel = result.grade?.tier
        self.keywords = result.item.keywords
    }

    /// From a saved verdict.
    ///
    /// Carries no keywords and no size or colour: the log keeps what a Home row
    /// shows, and storing the whole response to fill three more fields on a
    /// commit that may never happen is the wrong trade. Everything the seller
    /// SEES on the saved card is committed exactly as the live scan would have.
    init?(_ row: LocalProspectResult) {
        guard let title = row.title, !title.isEmpty else { return nil }
        self.title = title
        self.brand = row.brand
        self.size = nil
        self.color = nil
        self.categoryId = row.categoryId
        self.categoryPath = row.categoryPath
        self.costCents = row.costCents
        self.targetCents = row.medianCents
        self.gradeValue = row.gradeValue
        self.gradeLabel = row.gradeTier
        self.keywords = []
    }

    /// US-1170: the AI's read, distilled into the notes so the catalog step
    /// starts from it rather than from a blank item. Nil when there is nothing
    /// worth recording.
    var conditionNotes: String? {
        var parts: [String] = []
        if !keywords.isEmpty { parts.append(keywords.joined(separator: ", ")) }
        if let categoryPath, !categoryPath.isEmpty { parts.append("Category: \(categoryPath)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var request: ProspectBuyRequest {
        ProspectBuyRequest(
            title: title,
            brand: brand,
            size: size,
            color: color,
            categoryId: categoryId,
            costCents: costCents,
            targetCents: targetCents,
            gradeValue: gradeValue,
            gradeLabel: gradeLabel,
            conditionNotes: conditionNotes
        )
    }
}
