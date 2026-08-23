import Foundation

/// US-815 — pipeline status auto-advance + prep-checklist derivation, mirroring
/// the web `src/lib/workflow.ts` (`rankOf`/`earnedStatus`/`resolveStatus`) and the
/// `/flipdesk/prep` reference. Pure + value-typed so the advancement logic is
/// unit-tested in isolation and the canvas just reads derived state.
///
/// Auto-advance is forward-only: completed work earns a furthest "prep" stage,
/// and the resolved status is the max rank of {where it is, where the user put
/// it, what work has earned}. A manual pick of a non-prep status (sold, kept…)
/// wins outright so the pipeline never overrides an explicit sale/side-track.
enum ItemWorkflow {

    /// Ordered prep + sale pipeline rank. Mirrors the web `STAGE_RANK`. Side-track
    /// statuses (keeping/wearing/archived/returned) sit outside this rank and are
    /// only ever set by explicit action.
    static let stageRank: [String: Int] = [
        "sourced": 0,
        "acquired": 1,
        "cataloged": 2,
        "measured": 3,
        "photographed": 4,
        "grading": 5,
        "graded": 6,
        "comped": 7,
        "drafted": 8,
        "listed": 9,
        "sold": 10,
        "shipped": 11,
        "completed": 12,
    ]

    /// Statuses auto-advance can manage. Anything else (sold/shipped/completed/
    /// returned/keeping/wearing/archived) is only set by explicit action.
    static let prepStatuses: Set<String> = [
        "sourced", "acquired", "cataloged", "measured",
        "photographed", "grading", "graded", "comped", "drafted",
    ]

    /// Rank of a status in the pipeline, or `-1` for side-track statuses that
    /// sit outside the ordered flow.
    static func rank(_ status: String) -> Int {
        stageRank[status] ?? -1
    }

    /// The signals that drive auto-advance, derived from item state. Mirrors the
    /// web `WorkFacts`.
    struct Facts: Equatable {
        var hasMeasurements: Bool
        var hasRequiredPhotos: Bool
        var hasTargetPrice: Bool
        var hasGrade: Bool
        var hasDraftListing: Bool

        init(
            hasMeasurements: Bool = false,
            hasRequiredPhotos: Bool = false,
            hasTargetPrice: Bool = false,
            hasGrade: Bool = false,
            hasDraftListing: Bool = false
        ) {
            self.hasMeasurements = hasMeasurements
            self.hasRequiredPhotos = hasRequiredPhotos
            self.hasTargetPrice = hasTargetPrice
            self.hasGrade = hasGrade
            self.hasDraftListing = hasDraftListing
        }
    }

    /// The furthest prep stage the item has *earned* through completed work.
    /// Grading is optional, so it is never gated on (mirrors web `earnedStatus`).
    static func earnedStatus(_ facts: Facts) -> String {
        if facts.hasDraftListing { return "drafted" }
        if facts.hasTargetPrice { return "comped" }
        if facts.hasRequiredPhotos { return "photographed" }
        if facts.hasMeasurements { return "measured" }
        return "cataloged"
    }

    /// US-2818: where an item lands once the AI has read its photos and written
    /// its listing fields.
    ///
    /// The web has always ended this step on `drafted`: its composer save passes
    /// `hasDraftListing: true` unconditionally (composer.tsx composerItemPatch),
    /// because on the web the composer IS the listing draft. iOS derives the
    /// same fact from an actual `listings` row, which the photo-first intake
    /// never creates — so an item that had been through the whole AI pass sat on
    /// `photographed`, one stage behind the identical item on the web, and the
    /// seller's Drafted tab was empty.
    static let aiDraftedStatus = "drafted"

    /// A forward-only advance to `target`. Returns nil — meaning "leave it
    /// alone" — when the item has already reached or passed `target`, or when it
    /// has left the prep pipeline entirely (listed, sold, archived, …): those
    /// statuses are only ever set by explicit action, and stepping one back to
    /// `drafted` would unlist a live listing in every view that reads status.
    static func advanced(current: String, to target: String) -> String? {
        guard prepStatuses.contains(current) else { return nil }
        guard rank(target) > rank(current) else { return nil }
        return target
    }

    /// Resolve the status to persist. Auto-advances forward from completed work,
    /// never regresses, and lets a manual pick of a non-prep status win outright.
    /// Mirrors the web `resolveStatus`.
    static func resolveStatus(current: String, selected: String, facts: Facts) -> String {
        // Manual pick of a side-track / sale status — the user's choice wins.
        if !prepStatuses.contains(selected) { return selected }
        let earned = earnedStatus(facts)
        // Furthest of where it is, where the user put it, and what work earned.
        // Forward-only: `max` by rank never picks a lower-ranked status.
        return [current, selected, earned].max(by: { rank($0) < rank($1) }) ?? selected
    }
}

/// US-815 — the prep checklist rendered atop ``ItemCanvasView``. Pure derivation
/// from ``ItemWorkflow/Facts`` so it's unit-tested and renders identically for a
/// brand-new item (every row incomplete) and a fully-prepped one (every row
/// complete). No manually-ticked booleans — each row's `done` flag is computed
/// straight from item facts.
enum ItemPrepChecklist {

    /// One prep step. The optional grade step is excluded from required-progress
    /// counting but still rendered so the seller can jump to grading.
    enum Step: String, Hashable, Identifiable, CaseIterable {
        case photos
        case measurements
        case comps
        case grade
        case draft

        public var id: String { rawValue }
    }

    struct Row: Identifiable {
        let step: Step
        let title: String
        let detail: String
        let done: Bool
        let optional: Bool

        var id: String { step.rawValue }
    }

    /// True when the required capture slots (front + back) are present in
    /// `photoTypes` — the server `item_photos.photo_type` strings. Mirrors the
    /// web `has_required_photos` (00306). Tag + Detail are encouraged but not
    /// required, so they don't gate the "photographed" step.
    static func hasRequiredPhotos(photoTypes: Set<String>) -> Bool {
        let required = Set(PhotoSlotType.required.map(\.serverPhotoType))
        return required.isSubset(of: photoTypes)
    }

    /// The ordered checklist rows for the given facts.
    static func rows(facts: ItemWorkflow.Facts) -> [Row] {
        [
            Row(
                step: .photos,
                title: "Photos",
                detail: facts.hasRequiredPhotos
                    ? "Front & back captured"
                    : "Add the front & back shots (tag & detail optional)",
                done: facts.hasRequiredPhotos,
                optional: false
            ),
            Row(
                step: .measurements,
                title: "Measurements",
                detail: facts.hasMeasurements
                    ? "Measurements recorded"
                    : "Add flat measurements",
                done: facts.hasMeasurements,
                optional: false
            ),
            Row(
                step: .comps,
                title: "Comp & price",
                detail: facts.hasTargetPrice
                    ? "Target price set"
                    : "Pull comps and set a target price",
                done: facts.hasTargetPrice,
                optional: false
            ),
            Row(
                step: .grade,
                title: "Certified grade",
                detail: facts.hasGrade
                    ? "Grade attached"
                    : "Optional — add a certified condition grade",
                done: facts.hasGrade,
                optional: true
            ),
            Row(
                step: .draft,
                title: "Draft listing",
                detail: facts.hasDraftListing
                    ? "Listing drafted"
                    : "Draft the eBay listing",
                done: facts.hasDraftListing,
                optional: false
            ),
        ]
    }

    /// Count of completed REQUIRED steps (the optional grade step is excluded).
    static func completedRequired(facts: ItemWorkflow.Facts) -> Int {
        rows(facts: facts).filter { !$0.optional && $0.done }.count
    }

    /// Total REQUIRED steps — the denominator for the progress badge.
    static func totalRequired(facts: ItemWorkflow.Facts) -> Int {
        rows(facts: facts).filter { !$0.optional }.count
    }
}
