import Foundation

/// US-1897 (AC5): the Listing Quality Score, as the server computes it.
///
/// One 0–100 number per listing, plus the breakdown that names which fix earns
/// the most points and where to go and make it.
///
/// NOTHING IS RECOMPUTED HERE, and AC5 says so explicitly. The weights live in
/// exactly one place — `services/edge-functions/src/lib/listing-quality-score.ts`
/// — and arrive on the `POST /listings/validate` response this app already
/// calls before every publish. A client that re-derived them would drift from
/// the number the server persists on the listing row for sorting, and the two
/// screens would disagree about the same listing.
///
/// The only judgement this file makes is PRESENTATION: which colour band a
/// score falls in. That mirrors the web chip (`src/components/flipdesk/
/// quality-score-chip.tsx` `scoreBand`) and must stay in lockstep with it.
struct ListingQualityScore: Decodable, Equatable {
    /// 0–100, already rescaled over the components with a readable signal and
    /// already capped when the listing cannot publish at all.
    let score: Int
    let components: [QualityComponent]
    /// Sum of the weights actually counted — 100 when every signal was readable.
    /// Below 100 the breakdown admits it is a partial assessment rather than
    /// passing an incomplete read off as a full one.
    let weightCounted: Int
    /// Highest-value fixes first: what to nag about.
    let topFixes: [QualityFix]
    /// Something here stops the listing going live at all.
    let blocked: Bool
    /// Why, in the seller's words.
    let blockingReasons: [String]

    init(
        score: Int,
        components: [QualityComponent] = [],
        weightCounted: Int = 100,
        topFixes: [QualityFix] = [],
        blocked: Bool = false,
        blockingReasons: [String] = []
    ) {
        self.score = score
        self.components = components
        self.weightCounted = weightCounted
        self.topFixes = topFixes
        self.blocked = blocked
        self.blockingReasons = blockingReasons
    }

    private enum CodingKeys: String, CodingKey {
        case score, components, weightCounted, topFixes, blocked, blockingReasons
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A partial payload degrades rather than failing the whole validate
        // decode: the score is advisory, and losing the preflight because an
        // advisory field changed shape would cost the seller the publish.
        score = try c.decodeIfPresent(Int.self, forKey: .score) ?? 0
        components = try c.decodeIfPresent([QualityComponent].self, forKey: .components) ?? []
        weightCounted = try c.decodeIfPresent(Int.self, forKey: .weightCounted) ?? 100
        topFixes = try c.decodeIfPresent([QualityFix].self, forKey: .topFixes) ?? []
        blocked = try c.decodeIfPresent(Bool.self, forKey: .blocked) ?? false
        blockingReasons = try c.decodeIfPresent([String].self, forKey: .blockingReasons) ?? []
    }

    /// True when the server scored on less than the full 100 points because a
    /// signal (typically an unsynced business policy) could not be read.
    var isPartial: Bool { weightCounted < 100 }

    var band: QualityScoreBand { QualityScoreBand(score: score, blocked: blocked) }
}

/// One weighted component of the score.
struct QualityComponent: Decodable, Equatable, Identifiable {
    let key: String
    let label: String
    /// Nominal weight out of 100, before unknown-component rescaling.
    let weight: Int
    /// Points earned, 0...weight. Always 0 when `status` is `.unknown`.
    let earned: Int
    let status: Status
    /// One line explaining the number.
    let detail: String
    /// AC5: the surface that fixes this, named rather than merely implied.
    let fixSurface: String
    /// This component alone stops the listing publishing.
    let blocking: Bool

    var id: String { key }

    enum Status: String, Decodable, Equatable {
        case ok, warn, fix
        /// The signal could not be read. Excluded from the maths server-side,
        /// so it must not be shown as a failure here either — "not checked" is
        /// a different fact from "scored zero".
        case unknown
    }

    init(
        key: String,
        label: String,
        weight: Int,
        earned: Int,
        status: Status,
        detail: String = "",
        fixSurface: String = "",
        blocking: Bool = false
    ) {
        self.key = key
        self.label = label
        self.weight = weight
        self.earned = earned
        self.status = status
        self.detail = detail
        self.fixSurface = fixSurface
        self.blocking = blocking
    }

    private enum CodingKeys: String, CodingKey {
        case key, label, weight, earned, status, detail, fixSurface, blocking
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
        weight = try c.decodeIfPresent(Int.self, forKey: .weight) ?? 0
        // The server rounds for display but the wire type is a number; a
        // fractional value must not fail the decode.
        earned = Int((try c.decodeIfPresent(Double.self, forKey: .earned) ?? 0).rounded())
        // An unrecognised status reads as "unknown", never as a pass. A future
        // server-side status the app has not shipped support for must not be
        // painted green.
        status = Status(rawValue: try c.decodeIfPresent(String.self, forKey: .status) ?? "") ?? .unknown
        detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
        fixSurface = try c.decodeIfPresent(String.self, forKey: .fixSurface) ?? ""
        blocking = try c.decodeIfPresent(Bool.self, forKey: .blocking) ?? false
    }

    /// What the points column reads. An unknown component shows "not checked"
    /// rather than 0/10, matching the server excluding it from the score.
    var pointsText: String {
        status == .unknown ? "not checked" : "\(earned)/\(weight)"
    }
}

/// A ranked fix, highest points available first.
struct QualityFix: Decodable, Equatable, Identifiable {
    let key: String
    let label: String
    let pointsAvailable: Int
    let fixSurface: String

    var id: String { key }

    init(key: String, label: String, pointsAvailable: Int, fixSurface: String = "") {
        self.key = key
        self.label = label
        self.pointsAvailable = pointsAvailable
        self.fixSurface = fixSurface
    }

    private enum CodingKeys: String, CodingKey {
        case key, label, pointsAvailable, fixSurface
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
        pointsAvailable = Int(
            (try c.decodeIfPresent(Double.self, forKey: .pointsAvailable) ?? 0).rounded()
        )
        fixSurface = try c.decodeIfPresent(String.self, forKey: .fixSurface) ?? ""
    }
}

/// The chip's colour band. LOCKSTEP with the web's `scoreBand`
/// (src/components/flipdesk/quality-score-chip.tsx) — the two projects cannot
/// import each other, so the thresholds must be kept identical by hand.
///
/// `blocked` is its OWN band, not merely "poor". The server caps a blocked
/// listing at 40 so it sorts with the wreckage; painting it the same amber as a
/// weak-but-listable listing would undo that on screen, which is the exact
/// confusion the cap exists to prevent.
enum QualityScoreBand: Equatable {
    case blocked
    case good
    case fair
    case poor

    /// Web parity: >= 85 good, >= 60 fair, else poor.
    static let goodMin = 85
    static let fairMin = 60

    init(score: Int, blocked: Bool) {
        if blocked {
            self = .blocked
        } else if score >= Self.goodMin {
            self = .good
        } else if score >= Self.fairMin {
            self = .fair
        } else {
            self = .poor
        }
    }
}

/// Just the persisted half of the score: the sortable scalar and the blocked
/// flag, which is all migration 00476 stores on the `listings` row.
///
/// The breakdown is deliberately NOT persisted — it is cheap to recompute from
/// the preflight and changes whenever the weights change, so a stored copy would
/// go stale and show a seller a breakdown that no longer matches the number
/// beside it. A list surface renders chips from the cheap column read; the
/// publish dialog gets the full object from the preflight it already runs.
struct QualityScoreSummary: Equatable {
    let score: Int
    let blocked: Bool
    var band: QualityScoreBand { QualityScoreBand(score: score, blocked: blocked) }

    init(score: Int, blocked: Bool) {
        self.score = score
        self.blocked = blocked
    }

    /// Build from the persisted columns.
    ///
    /// A NULL `quality_score` yields nil rather than a zero. "Never scored" and
    /// "scored zero" are different facts, and a 0 would both render a confident
    /// chip and sort an unscored draft in with the genuinely worst listings.
    init?(score: Int?, blocked: Bool?) {
        guard let score else { return nil }
        self.score = score
        self.blocked = blocked == true
    }

    /// Sort rank for a worst-first ordering.
    ///
    /// Unscored drafts sink to the END. "We do not know" is not evidence of low
    /// quality, and floating unknowns to the top of a worst-first sort would
    /// bury the listings we DO know are weak — which is that sort's whole job.
    /// Mirrors the web's `qualityRankOf` (src/pages/flipdesk/draft-quality.ts).
    static func rank(_ summary: QualityScoreSummary?) -> Int {
        summary?.score ?? Int.max
    }
}
