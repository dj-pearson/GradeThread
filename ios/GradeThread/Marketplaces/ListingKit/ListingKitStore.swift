import Foundation
import Observation

// US-745: the Listing Kit's view model. Loads the per-platform variants for one
// item and exposes the load phase to the view. @MainActor + injected protocol
// service, matching AutolisterBatchStore / TemplateStore.
// US-1180: migrated to @Observable (was ObservableObject) for consistency.

@MainActor
@Observable
final class ListingKitStore {
    enum Phase: Equatable {
        case idle
        case loading
        case ready
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var variants: [PlatformVariant] = []
    /// US-3103: the eBay draft the variants were generated from. The cross-push
    /// route addresses a LISTING, not an item, so the push sheet cannot be
    /// opened without it — the response has always carried it and the store
    /// dropped it.
    private(set) var listingId: String?

    let itemId: String
    let itemTitle: String
    private let service: ListingKitProviding

    /// The no-API marketplaces the kit generates. eBay is deliberately excluded —
    /// it uses its own draft columns + the live publish path (unchanged, US-745 AC4).
    static let kitPlatforms = ["poshmark", "mercari", "grailed", "depop"]

    // nonisolated so a SwiftUI View.init can build it synchronously (mirrors
    // InventoryImportService); it only assigns stored properties.
    nonisolated init(
        itemId: String,
        itemTitle: String,
        service: ListingKitProviding = ListingKitService()
    ) {
        self.itemId = itemId
        self.itemTitle = itemTitle
        self.service = service
    }

    func load() async {
        if phase == .loading { return }
        phase = .loading
        do {
            let res = try await service.platformFields(
                itemId: itemId,
                platforms: Self.kitPlatforms
            )
            variants = res.variants
            listingId = res.listingId
            phase = .ready
        } catch {
            variants = []
            listingId = nil
            // EdgeAPIError is a LocalizedError, so a 409 ("no eBay draft yet")
            // surfaces its server detail; everything else gets a clean fallback.
            phase = .failed(error.localizedDescription)
        }
    }
}
