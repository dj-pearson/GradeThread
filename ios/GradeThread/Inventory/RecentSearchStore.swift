import Foundation
import Observation

/// US-1053 — persists the user's recent global-search terms to `UserDefaults`
/// so they can be offered as one-tap suggestions when the search field is empty.
/// Mirrors the web command palette's "Recent searches" section (DB-backed there;
/// device-local here, matching ``SavedFilterStore``'s convention).
///
/// Newest-first, de-duplicated case-insensitively, capped at ``maxItems``.
@Observable
public final class RecentSearchStore {
    private let defaults: UserDefaults
    private let storageKey = "com.gradethread.inventory.recentSearches"
    private let maxItems = 8

    public private(set) var terms: [String]

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.terms = Self.load(from: defaults, key: storageKey)
    }

    /// Records a search term, moving it to the front. Blank/too-short terms are
    /// ignored. A repeat search (case-insensitive) is promoted, not duplicated.
    public func record(_ term: String) {
        let trimmed = term.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else { return }
        terms.removeAll { $0.caseInsensitiveCompare(trimmed) == .orderedSame }
        terms.insert(trimmed, at: 0)
        if terms.count > maxItems { terms = Array(terms.prefix(maxItems)) }
        persist()
    }

    public func clear() {
        terms = []
        persist()
    }

    // MARK: - Persistence

    private func persist() {
        guard let data = try? JSONEncoder().encode(terms) else { return }
        defaults.set(data, forKey: storageKey)
    }

    private static func load(from defaults: UserDefaults, key: String) -> [String] {
        guard let data = defaults.data(forKey: key),
              let decoded = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return decoded
    }
}
