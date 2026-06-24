import Foundation
import Observation

/// Drives the comps panel on ``ItemCanvasView``. One per canvas; starts
/// idle and only hits the network when the user taps "Get eBay comps".
@MainActor
@Observable
final class CompsStore {
    enum Phase: Equatable {
        case idle
        case loading
        case loaded(CompsLookup)
        case failed(String)
    }

    var phase: Phase = .idle

    /// US-1186: identity of the draft the loaded comps were fetched for, so the
    /// canvas can flag results that no longer match the edited title/brand/size.
    private(set) var fetchedKey: String?

    /// Normalized identity of the comps-relevant draft fields.
    static func key(title: String, brand: String?, size: String?) -> String {
        [title, brand ?? "", size ?? ""]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .joined(separator: "|")
    }

    private let service: CompsProviding

    // Default is nil (not `CompsService()`): a default argument is evaluated
    // in the caller's isolation, and CompsService's init is @MainActor — so
    // we construct it inside the (MainActor-isolated) init body instead.
    init(service: CompsProviding? = nil) {
        self.service = service ?? CompsService()
    }

    func fetch(title: String, brand: String?, size: String?) async {
        phase = .loading
        fetchedKey = Self.key(title: title, brand: brand, size: size)
        do {
            if let lookup = try await service.lookup(title: title, brand: brand, size: size) {
                phase = .loaded(lookup)
            } else {
                phase = .failed(
                    "Couldn't match this to an eBay category. Give the item a clearer title and try again."
                )
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
            phase = .failed(message)
        }
    }
}
