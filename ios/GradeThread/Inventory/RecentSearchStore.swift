import Foundation
import Observation

/// US-1053 — persists the user's recent global-search terms to `UserDefaults`
/// so they can be offered as one-tap suggestions when the search field is empty.
/// Mirrors the web command palette's "Recent searches" section (DB-backed there;
/// device-local here, matching ``SavedFilterStore``'s convention).
///
/// Newest-first, de-duplicated case-insensitively, capped at ``maxItems``.
///
/// US-1218 — search terms may include consignor/buyer names (free-text PII), so
/// they are persisted to a file-protected store in Application Support
/// (`.completeFileProtectionUntilFirstUserAuthentication`) rather than plaintext
/// `UserDefaults`, keeping them out of unencrypted backups. The cap is kept
/// small for the same reason.
@Observable
public final class RecentSearchStore {
    /// Legacy UserDefaults key — read once to migrate, then removed (US-1218).
    private let legacyKey = "com.gradethread.inventory.recentSearches"
    private let defaults: UserDefaults
    private let dirName = "inventory-recent-searches"
    private let maxItems = 5

    public private(set) var terms: [String]

    private var directory: URL? {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return base?.appendingPathComponent(dirName, isDirectory: true)
    }

    private var fileURL: URL? {
        directory?.appendingPathComponent("terms.json")
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.terms = []
        self.terms = loadAndMigrate()
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
        guard let dir = directory, let url = fileURL,
              let data = try? JSONEncoder().encode(terms) else { return }
        try? FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Loads from the file-protected store, migrating any legacy plaintext
    /// UserDefaults value once and then deleting the key (US-1218).
    private func loadAndMigrate() -> [String] {
        if let url = fileURL,
           let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode([String].self, from: data) {
            // A legacy key may still exist if the file store wrote first; purge it.
            defaults.removeObject(forKey: legacyKey)
            return Array(decoded.prefix(maxItems))
        }
        // First run on US-1218: migrate the old UserDefaults value if present.
        if let data = defaults.data(forKey: legacyKey),
           let decoded = try? JSONDecoder().decode([String].self, from: data) {
            defaults.removeObject(forKey: legacyKey)
            let capped = Array(decoded.prefix(maxItems))
            terms = capped
            persist()
            return capped
        }
        defaults.removeObject(forKey: legacyKey)
        return []
    }
}
