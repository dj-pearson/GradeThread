import Foundation

// US-2503 slice 2: the buyer entitlement payload, as the SERVER resolves it.
//
// /pricing says "Every FlipDesk plan includes buyer tools", and until this slice
// a phone-only subscriber got none of them and was told nothing about it. The
// screens come next; this is the gate they read and the honest list the plan
// screen shows.

/// The resolved buyer entitlement payload from `GET /api/buyer/entitlements`.
///
/// AC3 says both clients read the SAME answer. So this decodes the edge's
/// resolution rather than re-deriving it from the plan: a Swift copy of the
/// plan-to-capability matrix would be a second source of truth, and the way
/// that fails is quiet — a plan change unlocks a feature on web and not here,
/// and nothing is red anywhere.
struct BuyerEntitlements: Decodable, Equatable {
    /// "free" | "guard" | "connoisseur".
    let plan: String

    /// Capability id to unlocked, keyed exactly as `BuyerGateFlags` in
    /// src/lib/constants.ts.
    ///
    /// A DICTIONARY rather than thirteen properties, on purpose. A struct would
    /// have to name every flag, so a flag added on the server would decode to
    /// nothing here and the mismatch would surface as a missing screen months
    /// later. A dictionary carries whatever the server sends; the capability
    /// TABLE below is what decides which ones this app has an opinion about, and
    /// a parity test pins that table to the web registry.
    let gateFlags: [String: Bool]

    let allowances: BuyerAllowances

    /// The locked floor. Every failure resolves here — a bad response, a decode
    /// error, no network. The direction is deliberate and it is the one that
    /// matters: showing a paid screen to someone who is not paying is a worse
    /// failure than showing a locked screen to someone who is, because only one
    /// of the two corrects itself on the next load.
    static let free = BuyerEntitlements(
        plan: "free",
        gateFlags: [:],
        allowances: .free
    )

    func isUnlocked(_ capability: BuyerCapability) -> Bool {
        gateFlags[capability.id] ?? false
    }
}

struct BuyerAllowances: Decodable, Equatable {
    let extensionChecksPerMonth: Int
    let authenticityCreditsPerMonth: Int
    let videoGradeCreditsPerMonth: Int
    let activeAlertsCap: Int
    let portfolioItemCap: Int
    /// "daily" | "hourly" | "instant".
    let alertFrequency: String

    static let free = BuyerAllowances(
        extensionChecksPerMonth: 0,
        authenticityCreditsPerMonth: 0,
        videoGradeCreditsPerMonth: 0,
        activeAlertsCap: 0,
        portfolioItemCap: 0,
        alertFrequency: "daily"
    )
}

// MARK: - The capability table

/// Where a bundled buyer capability actually lives.
enum BuyerCapabilityDelivery: String, Equatable {
    /// An iOS screen exists and works today.
    case shipped
    /// iOS can deliver it and has not yet. Said so, rather than omitted.
    case planned
    /// iOS cannot deliver it, for a reason about the capability rather than
    /// about effort.
    case desktopOnly
}

/// One bundled buyer capability, as the iOS plan screen describes it.
///
/// MIRRORS `BUYER_FEATURES` in src/lib/buyer-features.ts, and the mirror is
/// TESTED, not trusted: src/test/buyer-ios-capability-parity.test.ts imports the
/// real registry, parses this file, and fails on any difference in ids, labels,
/// delivery or notes. Hand-syncing two lists is exactly how the over-promise
/// this story is about got written in the first place.
struct BuyerCapability: Identifiable, Equatable {
    let id: String
    let label: String
    let delivery: BuyerCapabilityDelivery
    /// Shown under the label when the capability lives somewhere other than this
    /// app. AC2 requires the extension be STATED as desktop-only rather than
    /// quietly dropped: a bundled capability that simply vanishes on one client
    /// reads as a bug, and a subscriber who paid for the bundle is owed the
    /// sentence.
    let note: String?

    // BEGIN GENERATED TABLE (parity-tested against src/lib/buyer-features.ts)
    static let all: [BuyerCapability] = [
        BuyerCapability(
            id: "extensionSecondOpinion",
            label: "Extension second-opinion checks",
            delivery: .desktopOnly,
            note: "Runs in the desktop browser extension while you shop."),
        BuyerCapability(
            id: "discrepancyScoring",
            label: "Claimed-vs-objective discrepancy",
            delivery: .desktopOnly,
            note: "Part of the desktop extension's check."),
        BuyerCapability(
            id: "priceFairness",
            label: "Price-fairness meter",
            delivery: .desktopOnly,
            note: "Part of the desktop extension's check."),
        BuyerCapability(
            id: "conditionAlerts",
            label: "Condition alerts",
            delivery: .planned,
            note: nil),
        BuyerCapability(
            id: "fitPrediction",
            label: "Fit prediction",
            delivery: .desktopOnly,
            note: "Part of the desktop extension's check."),
        BuyerCapability(
            id: "authenticityAddon",
            label: "Authenticity add-on",
            delivery: .desktopOnly,
            note: "Bought on the web when you request a grade."),
        BuyerCapability(
            id: "videoGrading",
            label: "Walk-around video grading",
            delivery: .planned,
            note: nil),
        BuyerCapability(
            id: "rewards",
            label: "Grade-confirmation rewards",
            delivery: .planned,
            note: nil),
        BuyerCapability(
            id: "trustScore",
            label: "Buyer trust score",
            delivery: .shipped,
            note: nil),
        BuyerCapability(
            id: "purchaseGuarantee",
            label: "Grade-locked purchase guarantee",
            delivery: .shipped,
            note: nil),
        BuyerCapability(
            id: "wardrobePortfolio",
            label: "Wardrobe portfolio",
            delivery: .shipped,
            note: nil),
        BuyerCapability(
            id: "demandBoard",
            label: "Graded-Wanted demand board",
            delivery: .planned,
            note: nil),
        BuyerCapability(
            id: "prioritySupport",
            label: "Priority support",
            delivery: .shipped,
            note: nil),
    ]
    // END GENERATED TABLE
}
