import Foundation
import Observation

/// A named, reusable filter — a "smart view" the user pins for one-tap
/// recall ("Nike size L to list", "Ungraded under $20"). Power-user feature
/// for large inventories where re-dialing the same facets gets old fast.
public struct SavedFilter: Codable, Equatable, Identifiable, Hashable {
    public let id: UUID
    public var name: String
    public var criteria: InventoryFilterCriteria

    public init(id: UUID = UUID(), name: String, criteria: InventoryFilterCriteria) {
        self.id = id
        self.name = name
        self.criteria = criteria
    }
}

/// Persists ``SavedFilter`` views to `UserDefaults` as JSON. Observable so
/// SwiftUI rerenders the saved-views list when one is added or removed.
///
/// Deliberately *not* persisting the live/active criteria: silently
/// reapplying a stale filter across launches ("where did my items go?") is
/// a worse default than starting clean. Only explicit saved views survive.
@Observable
public final class SavedFilterStore {
    private let defaults: UserDefaults
    private let storageKey = "com.gradethread.inventory.savedFilters"

    public private(set) var filters: [SavedFilter]

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.filters = Self.load(from: defaults, key: storageKey)
    }

    /// Saves `criteria` under `name`. A blank name is rejected (returns
    /// nil). Reusing an existing name overwrites that view rather than
    /// creating a duplicate, so "save" is idempotent on the name.
    @discardableResult
    public func save(name: String, criteria: InventoryFilterCriteria) -> SavedFilter? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let filter = SavedFilter(name: trimmed, criteria: criteria)
        if let idx = filters.firstIndex(where: {
            $0.name.caseInsensitiveCompare(trimmed) == .orderedSame
        }) {
            filters[idx] = SavedFilter(id: filters[idx].id, name: trimmed, criteria: criteria)
        } else {
            filters.append(filter)
        }
        persist()
        return filter
    }

    public func delete(_ filter: SavedFilter) {
        filters.removeAll { $0.id == filter.id }
        persist()
    }

    public func delete(at offsets: IndexSet) {
        filters.remove(atOffsets: offsets)
        persist()
    }

    /// US-1646: wipe all saved filter views. Called by the sign-out sweep so the
    /// next account on this device can't see the previous user's saved views.
    public func clear() {
        filters.removeAll()
        defaults.removeObject(forKey: storageKey)
    }

    /// Name of an existing saved view whose criteria exactly matches the
    /// argument, if any — lets the UI show "Saved" state for the active set.
    public func matchingName(for criteria: InventoryFilterCriteria) -> String? {
        filters.first { $0.criteria == criteria }?.name
    }

    // MARK: - Persistence

    private func persist() {
        guard let data = try? JSONEncoder().encode(filters) else { return }
        defaults.set(data, forKey: storageKey)
    }

    private static func load(from defaults: UserDefaults, key: String) -> [SavedFilter] {
        guard let data = defaults.data(forKey: key),
              let decoded = try? JSONDecoder().decode([SavedFilter].self, from: data)
        else { return [] }
        return decoded
    }
}
