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

    public init(item: LocalInventoryItem, currencyFormatter: CurrencyFormatter = CurrencyFormatter()) {
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
