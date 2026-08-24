import Foundation
import Observation

/// Owns the editable canvas state for a single item. Holds the original
/// snapshot + the active draft + lifecycle flags. Save action is on the
/// view because it needs SupabaseClient access — but the dirty math and
/// the post-save reset live here so they're unit-testable in isolation.
@MainActor
@Observable
public final class ItemCanvasState {
    public enum SavePhase: Equatable {
        case idle
        case saving
        case failed(message: String)
    }

    public let itemId: String
    public private(set) var original: ItemDraft
    public var draft: ItemDraft
    public var savePhase: SavePhase = .idle

    private let currencyFormatter: CurrencyFormatter

    init(item: LocalInventoryItem, currencyFormatter: CurrencyFormatter = CurrencyFormatter()) {
        self.itemId = item.id
        let initial = ItemDraft(from: item, currencyFormatter: currencyFormatter)
        self.original = initial
        self.draft = initial
        self.currencyFormatter = currencyFormatter
    }

    /// True iff any field on the draft differs from the original. Drives
    /// the "discard?" confirmation when the user tries to leave the
    /// canvas without saving.
    public var isDirty: Bool {
        draft != original
    }

    /// Validity check before allowing save. Title is required;
    /// everything else can be blank.
    public var isSavable: Bool {
        !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Returns true iff the picked status would be a forward (or sideways)
    /// transition. Mirrors the web's resolveStatus guard.
    public func canTransition(to candidate: String) -> Bool {
        StatusGuard.allows(from: original.status, to: candidate)
    }

    /// A status the server changed out from under this screen -- recording a
    /// sale is the one that exists today.
    ///
    /// Moves the BASELINE as well as the draft. Moving only the draft would
    /// leave the page dirty against a status the seller never picked, so the
    /// leave-guard would ask about changes they did not make and the next Save
    /// would push the old value back over the new one.
    public func applyExternalStatus(_ status: String) {
        draft.status = status
        original.status = status
    }

    /// Snapshot the current draft as the new baseline. Called from the
    /// save success path so subsequent edits compute `isDirty` against
    /// the just-saved values, not the stale pre-save snapshot.
    public func acceptDraftAsOriginal() {
        original = draft
        savePhase = .idle
    }

    /// Reset everything back to the original — used by the "Discard
    /// changes" confirmation.
    public func discardChanges() {
        draft = original
        savePhase = .idle
    }

    /// Re-seed the baseline + draft from a freshly-synced item — but ONLY
    /// when the user has no pending edits. This lets a server update that
    /// lands *while the canvas is open* flow into the form. The motivating
    /// case (US-682): after photo intake the AI-extract step writes the
    /// accepted fields to the remote row, then deep-links the canvas open;
    /// the canvas first renders against the stale "Untitled item" local row
    /// and only picks up the extracted brand/size/etc. once the sync pull
    /// lands. Without this, the user had to back out to the list and re-open
    /// the item to see the approved fields. No-op while dirty so we never
    /// clobber in-progress edits. Returns true when it actually refreshed.
    // `internal` (not `public`) because `LocalInventoryItem` is an internal
    // type — same reason `init(item:)` above isn't public. The canvas view is
    // in this module, so internal visibility is all it needs.
    @discardableResult
    func refreshFromItem(_ item: LocalInventoryItem) -> Bool {
        guard !isDirty else { return false }
        let fresh = ItemDraft(from: item, currencyFormatter: currencyFormatter)
        guard fresh != original else { return false }
        original = fresh
        draft = fresh
        return true
    }

    /// Set savePhase and clear any draft-side enum normalization. Called
    /// from the view's save-task happy + failure paths.
    public func beginSaving() { savePhase = .saving }
    public func failSaving(_ message: String) { savePhase = .failed(message: message) }

    /// Parses the user-entered price strings into Doubles for the wire
    /// payload. Empty strings become nil so we don't accidentally write
    /// 0 over a previously-set value.
    public func parsedPrices() -> (target: Double?, cost: Double?) {
        (
            currencyFormatter.parse(draft.targetPriceText),
            currencyFormatter.parse(draft.acquiredPriceText)
        )
    }
}
