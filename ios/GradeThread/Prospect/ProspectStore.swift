import Observation
import SwiftUI

/// View-model for Item Prospecting (US-1107). Holds up to two captured photos
/// (front + tag) and an optional "what would you pay?" amount, calls
/// ``ProspectService``, and exposes the result/error for the view. Images are
/// compressed (and EXIF-stripped) off the main actor via ``PhotoCompressor``
/// before upload — the same path Snap-to-Value uses.
///
/// US-1180: migrated to `@Observable` (was `ObservableObject`) for consistency
/// with the rest of the app's stores and finer-grained view invalidation.
@MainActor
@Observable
final class ProspectStore {

    /// Up to two source photos: the front and (ideally) the brand/size tag.
    var images: [UIImage] = []
    /// Optional cost entry, in dollars, that unlocks the ROI verdict.
    var costText: String = ""
    var isLoading = false
    var result: ProspectResponse?
    var errorMessage: String?

    /// Set once the user commits the prospect into inventory, so the view can
    /// confirm + offer a jump to the inventory tab.
    var isAdding = false
    var addedItemId: String?
    /// US-1225: separate from `errorMessage` so an add-to-inventory failure
    /// renders its OWN retry (which re-calls `addToInventory()`) instead of the
    /// top error card whose "Try again" re-runs the billable identify+comp pipeline.
    var addError: String?

    static let maxPhotos = 2

    private let service: Prospecting

    // Constructed in the init BODY (main-actor-isolated) rather than as a default
    // argument, which would evaluate in a nonisolated context.
    init(service: Prospecting? = nil) {
        self.service = service ?? ProspectService()
    }

    var canAddPhoto: Bool { images.count < Self.maxPhotos }
    var canRun: Bool { !images.isEmpty && !isLoading }

    func addImage(_ img: UIImage) {
        guard canAddPhoto else { return }
        images.append(img)
        result = nil
        errorMessage = nil
        addError = nil
        addedItemId = nil
    }

    func removeImage(at index: Int) {
        guard images.indices.contains(index) else { return }
        images.remove(at: index)
        result = nil
        addedItemId = nil
    }

    /// Parsed cost in integer cents, or nil when the field is empty/invalid.
    private var costCents: Int? {
        // US-1491: locale-aware parse. A raw comma-strip + Double() read "24,99"
        // as 2499.0 in comma-decimal locales — a 100× cost that poisons the ROI
        // verdict. CurrencyFormatter.parse strips the symbol/grouping and honors
        // the locale decimal separator.
        guard let dollars = CurrencyFormatter().parse(costText), dollars > 0 else { return nil }
        return Int((dollars * 100).rounded())
    }

    /// US-1225: the buy/skip verdict + ROI are computed server-side and baked into
    /// the result for the cost it was run with (`result.costCents`). Nothing
    /// watches `costText` afterwards, so entering — or changing — a cost AFTER a
    /// run produces no verdict. Since the ROI math lives on the server (not here),
    /// we can't recompute locally; instead detect the mismatch so the view can
    /// prompt a re-run with the new cost.
    var costNeedsRerun: Bool {
        guard result != nil else { return false }
        return costCents != result?.costCents
    }

    func run() async {
        guard !images.isEmpty else {
            errorMessage = "Take a photo of the item (and its tag) first."
            return
        }
        isLoading = true
        errorMessage = nil
        addError = nil
        addedItemId = nil
        defer { isLoading = false }

        // Compress off the main actor so the spinner stays smooth (US-636).
        var payload: [Data] = []
        for img in images {
            if let output = await PhotoCompressor.compressOffMain(img) {
                payload.append(output.imageData)
            }
        }
        guard !payload.isEmpty else {
            errorMessage = "Couldn't read those photos. Try again."
            return
        }

        do {
            result = try await service.prospect(images: payload, costCents: costCents)
        } catch {
            result = nil
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Commit the current result into inventory at `sourced` via the existing
    /// Scout buy endpoint. Prefills cost/grade/target from what we just learned.
    func addToInventory() async {
        guard let result, result.identified, let title = result.item.title, !title.isEmpty else {
            addError = "Nothing to add — identify an item first."
            return
        }
        isAdding = true
        addError = nil
        defer { isAdding = false }

        // US-1170: don't discard the AI's read on commit. size/color aren't in
        // the prospect payload (ProspectItem only carries brand/title/keywords),
        // but the keywords + resolved category are — fold them into notes so the
        // catalog step starts from the AI's read instead of a blank item.
        let request = ProspectBuyRequest(
            title: title,
            brand: result.item.brand,
            size: nil,
            color: nil,
            // US-1275: commit the cost the run was computed with (result.costCents),
            // not the current field — if the user edited cost after the run
            // (costNeedsRerun), targetCents/grade below come from the prior run, so
            // persisting the edited cost would store a verdict the comps never used.
            costCents: result.costCents,
            targetCents: result.stats?.medianCents,
            gradeValue: result.grade?.value,
            gradeLabel: result.grade?.tier,
            conditionNotes: prospectNotes(result)
        )
        do {
            let response = try await service.buy(request)
            addedItemId = response.id
        } catch {
            addError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// US-1170: distill the AI's read (keywords + resolved category) into a
    /// notes string so it carries into the new inventory item. Returns nil when
    /// there's nothing useful to record.
    private func prospectNotes(_ result: ProspectResponse) -> String? {
        var parts: [String] = []
        if !result.item.keywords.isEmpty {
            parts.append(result.item.keywords.joined(separator: ", "))
        }
        if let path = result.category?.path, !path.isEmpty {
            parts.append("Category: \(path)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
