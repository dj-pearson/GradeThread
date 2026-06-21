import SwiftUI

/// View-model for Item Prospecting (US-1107). Holds up to two captured photos
/// (front + tag) and an optional "what would you pay?" amount, calls
/// ``ProspectService``, and exposes the result/error for the view. Images are
/// compressed (and EXIF-stripped) off the main actor via ``PhotoCompressor``
/// before upload — the same path Snap-to-Value uses.
@MainActor
final class ProspectStore: ObservableObject {

    /// Up to two source photos: the front and (ideally) the brand/size tag.
    @Published var images: [UIImage] = []
    /// Optional cost entry, in dollars, that unlocks the ROI verdict.
    @Published var costText: String = ""
    @Published var isLoading = false
    @Published var result: ProspectResponse?
    @Published var errorMessage: String?

    /// Set once the user commits the prospect into inventory, so the view can
    /// confirm + offer a jump to the inventory tab.
    @Published var isAdding = false
    @Published var addedItemId: String?

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
        let cleaned = costText
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespaces)
        guard !cleaned.isEmpty, let dollars = Double(cleaned), dollars > 0 else { return nil }
        return Int((dollars * 100).rounded())
    }

    func run() async {
        guard !images.isEmpty else {
            errorMessage = "Take a photo of the item (and its tag) first."
            return
        }
        isLoading = true
        errorMessage = nil
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
            errorMessage = "Nothing to add — identify an item first."
            return
        }
        isAdding = true
        errorMessage = nil
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
            costCents: costCents,
            targetCents: result.stats?.medianCents,
            gradeValue: result.grade?.value,
            gradeLabel: result.grade?.tier,
            conditionNotes: prospectNotes(result)
        )
        do {
            let response = try await service.buy(request)
            addedItemId = response.id
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
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
