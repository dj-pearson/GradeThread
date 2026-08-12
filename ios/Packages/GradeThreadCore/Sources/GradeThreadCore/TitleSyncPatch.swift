import Foundation

// US-1995: the ORCHESTRATION around backwards title sync, as a pure function.
//
// ``TitleSync`` owns the substitution. This owns the decisions WRAPPED around it
// - which base title to start from, whether both A/B variants move, and whether
// the change needs review - because those were previously written out longhand
// at each call site and would otherwise be copy-pasted into every surface that
// edits an item.
//
// That is the whole lesson of the story: the pure helper was shared and the
// orchestration was not, so only one surface ever ran it. A seller who corrects
// a brand still gets a stale title everywhere else.
//
// Mirrors src/lib/title-sync-patch.ts. Pure and side-effect free: it returns a
// patch for the caller to write.

extension TitleSync {

    /// Everything the patch decision needs about one listing.
    public struct PatchInput {
        /// The listing's current title (fall back to the item title upstream).
        public var baseTitle: String?
        /// The A/B variant titles, in order. An element is nil when that variant
        /// carries no string title; it comes back nil and the caller leaves the
        /// entry alone.
        ///
        /// The JS copy takes the whole variant OBJECTS and spreads them
        /// (`{ ...v, title: sync(v.title) }`). GradeThreadCore is Foundation-only
        /// and has no JSON value type, so the titles travel on their own and the
        /// caller re-attaches them to the jsonb, preserving `label`/`active`.
        /// Same decisions, different plumbing.
        public var variantTitles: [String?]?
        /// Field changes from ``TitleSync/changesFromItemDiff(before:after:)``.
        public var changes: [FieldChange]
        /// The title the AI generated (`ai_generated_snapshot.title`). When the
        /// current title differs, the seller hand-edited it and the substitution
        /// needs review rather than silent application.
        public var snapshotTitle: String?
        /// True for a listing that is LIVE on the marketplace. A live listing
        /// never silently changes: buyers are already reading those words.
        public var isLive: Bool
        /// `listing_origin`. An 'ebay'-origin listing is eBay's to own - the sync
        /// contract forbids writing its title
        /// (vault/20-domain/sync-source-of-truth.md), so this returns an empty
        /// patch for those.
        public var listingOrigin: String?

        public init(
            baseTitle: String?,
            variantTitles: [String?]? = nil,
            changes: [FieldChange],
            snapshotTitle: String? = nil,
            isLive: Bool = false,
            listingOrigin: String? = nil
        ) {
            self.baseTitle = baseTitle
            self.variantTitles = variantTitles
            self.changes = changes
            self.snapshotTitle = snapshotTitle
            self.isLive = isLive
            self.listingOrigin = listingOrigin
        }
    }

    /// The listings columns to write. A nil member means "do not write this
    /// column" - the caller's Encodable patch must skip it, not send null.
    public struct Patch: Equatable {
        public var listingTitle: String?
        public var variantTitles: [String?]?
        public var needsReview: Bool?

        public init(
            listingTitle: String? = nil,
            variantTitles: [String?]? = nil,
            needsReview: Bool? = nil
        ) {
            self.listingTitle = listingTitle
            self.variantTitles = variantTitles
            self.needsReview = needsReview
        }

        /// Nothing should change. Callers skip the UPDATE entirely on this, so a
        /// no-op save cannot dirty `updated_at` on every listing of every item.
        public var isEmpty: Bool {
            listingTitle == nil && variantTitles == nil && needsReview == nil
        }
    }

    /// Build the listings patch for a set of item field changes.
    public static func buildTitleSyncPatch(_ input: PatchInput) -> Patch {
        guard !input.changes.isEmpty else { return Patch() }

        // eBay owns an ebay-origin listing's title. Never write it: it would break
        // the sync contract, and eBay re-asserts its own value on the next pull
        // anyway, so the write is both wrong and futile.
        guard input.listingOrigin != "ebay" else { return Patch() }

        let baseTitle = (input.baseTitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !baseTitle.isEmpty else { return Patch() }

        let synced = syncTitle(baseTitle, changes: input.changes)
        // Compare against the TRIMMED base: syncTitle re-trims to the cap, so an
        // 81-char title that only lost its tail is not a substitution and must not
        // masquerade as one (that would silently truncate titles on unrelated
        // saves).
        guard !synced.isEmpty, synced != trimTitleToLimit(baseTitle) else { return Patch() }

        var patch = Patch(listingTitle: synced)

        // Both A/B variants get the substitution - a stale brand in variant B is
        // the same bug, just less visible.
        if let variants = input.variantTitles {
            patch.variantTitles = variants.map { title in
                title.map { syncTitle($0, changes: input.changes) }
            }
        }

        // A hand-edited title (diverged from the AI snapshot) or a live listing is
        // FLAGGED rather than silently rewritten: the seller chose those words, or
        // buyers are already seeing them.
        let snapshotTitle = (input.snapshotTitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let handEdited = !snapshotTitle.isEmpty
            && trimTitleToLimit(baseTitle) != trimTitleToLimit(snapshotTitle)
        if handEdited || input.isLive { patch.needsReview = true }

        return patch
    }
}
