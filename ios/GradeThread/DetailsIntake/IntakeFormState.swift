import Foundation
import Observation

/// Form state for the manual intake screen. All fields are exposed as
/// stored properties so they bind directly to SwiftUI inputs. Reset
/// preserves the batch-cataloging fields (source + container + sourced
/// by + purchase date) per the US-178 AC so a user sourcing a thrift haul
/// can save and immediately start the next item without retyping.
@MainActor
@Observable
public final class IntakeFormState {
    // Item identity
    public var title: String = ""
    public var sku: String = ""
    public var brand: String = ""
    public var style: String = ""
    public var size: String = ""
    public var color: String = ""
    public var material: String = ""
    public var category: FlipdeskCategory = .clothing
    public var status: IntakeStatus = .cataloged

    // Sourcing (preserved across "Save & Add another")
    public var sourceId: String? = nil
    public var container: String = ""
    public var sourcedBy: String = ""
    public var purchaseDate: Date = .now
    public var purchasePriceText: String = ""

    // Notes
    public var notes: String = ""

    /// True when there's enough to save. Title is the only required
    /// field — everything else is optional. Matches the web intake form.
    public var canSubmit: Bool {
        !title.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Title is the lone gate on Save (see `canSubmit`). While it's blank the
    /// form surfaces `titleRequiredHelp` so the user understands why both Save
    /// buttons are disabled; the helper disappears once a title is entered.
    public var isTitleMissing: Bool {
        title.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// Helper copy shown beneath the required Title field while it's empty.
    public static let titleRequiredHelp = "A title is required to save"

    public init() {}

    /// "Save & Add another" reset: clears item-identity fields and
    /// notes while keeping the sourcing context the user established for
    /// this batch. Mirrors src/pages/flipdesk/intake.tsx.
    public func resetForBatchAddAnother() {
        title = ""
        sku = ""
        brand = ""
        style = ""
        size = ""
        color = ""
        material = ""
        category = .clothing
        status = .cataloged
        notes = ""
        purchasePriceText = ""
        // sourceId / container / sourcedBy / purchaseDate intentionally
        // retained — the next item in the batch belongs to the same haul.
    }

    /// Full reset — used when the user closes and re-opens the form.
    public func resetAll() {
        resetForBatchAddAnother()
        sourceId = nil
        container = ""
        sourcedBy = ""
        purchaseDate = .now
    }
}
