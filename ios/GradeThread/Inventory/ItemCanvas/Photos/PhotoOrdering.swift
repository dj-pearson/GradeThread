import Foundation

/// Minimal view of a photo for ordering math — lets the pure helpers be
/// unit-tested with a plain struct instead of a SwiftData model.
protocol PhotoOrderable {
    var id: String { get }
    var currentSortOrder: Int { get }
}

/// Pure helpers for the photo manager. An array's index IS the canonical
/// `sort_order`; **index 0 is the cover** — the lowest sort_order is what
/// `SyncEngine` caches into `LocalInventoryItem.primaryPhotoURL` (grid
/// thumbnail) and what eBay publish uses as the listing's main image.
enum PhotoOrdering {

    /// Given the desired display order (array index → target sort_order),
    /// returns only the `(id, newSortOrder)` pairs whose sort_order actually
    /// changed, so persistence touches the fewest rows.
    static func changedSortOrders<P: PhotoOrderable>(
        _ ordered: [P]
    ) -> [(id: String, sortOrder: Int)] {
        ordered.enumerated().compactMap { index, photo in
            photo.currentSortOrder == index ? nil : (photo.id, index)
        }
    }

    /// Moves the element at `source` to the front (cover slot). No-op when
    /// it's already the cover or the index is out of range.
    static func movedToCover<P>(_ ordered: [P], from source: Int) -> [P] {
        guard ordered.indices.contains(source), source != 0 else { return ordered }
        var copy = ordered
        let element = copy.remove(at: source)
        copy.insert(element, at: 0)
        return copy
    }
}

extension LocalItemPhoto: PhotoOrderable {
    var currentSortOrder: Int { sortOrder }
}
