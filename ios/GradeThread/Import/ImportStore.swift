import SwiftUI

/// US-667 — drives the guided CSV / Google Sheets inventory import: pick a
/// source → auto-guess the column mapping → preview (with per-row errors) →
/// commit. `@MainActor @Observable` like the other stores.
@MainActor
@Observable
final class ImportStore {

    enum Phase: Equatable {
        case source       // choose a CSV file or paste a Sheets link
        case mapping      // adjust column→field mapping + preview
        case committing
        case done
    }

    private let sheets: SheetsImporting
    private let importer: InventoryImportService

    var phase: Phase = .source
    private(set) var sheet: CSVParser.Sheet?
    /// One ``ImportField`` per column in `sheet.headers`.
    var mapping: [ImportField] = []

    var errorBanner: String?
    var isFetching = false

    var progressDone = 0
    var progressTotal = 0
    private(set) var result: InventoryImportService.Result?

    init(
        sheets: SheetsImporting = SheetsImportService(),
        importer: InventoryImportService = InventoryImportService()
    ) {
        self.sheets = sheets
        self.importer = importer
    }

    // MARK: - Loading

    /// Parses raw CSV/TSV text, auto-guesses the per-column mapping, and moves
    /// to the mapping step. Surfaces a banner if the text has no usable rows.
    func loadCSV(_ text: String) {
        let parsed = CSVParser.parseSheet(text)
        guard !parsed.headers.isEmpty else {
            errorBanner = "That file didn't contain any columns."
            return
        }
        guard !parsed.rows.isEmpty else {
            errorBanner = "That file has headers but no data rows."
            return
        }
        sheet = parsed
        mapping = parsed.headers.map { ImportField.guess(from: $0) }
        errorBanner = nil
        phase = .mapping
    }

    /// Fetches a public Google Sheet (via the edge) then parses it.
    func loadFromSheet(url: String) async {
        isFetching = true
        defer { isFetching = false }
        do {
            let csv = try await sheets.fetchCSV(url: url)
            loadCSV(csv)
        } catch {
            errorBanner = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    // MARK: - Preview

    var hasTitleMapping: Bool { ImportMapping.hasTitle(mapping) }

    /// Mapped preview rows (ready + invalid), computed from the current mapping.
    var previewRows: [ImportMapping.RowResult] {
        guard let sheet else { return [] }
        return ImportMapping.mapAll(sheet: sheet, mapping: mapping)
    }

    var readyDrafts: [(row: Int, draft: ImportItemDraft)] {
        previewRows.enumerated().compactMap { idx, r in
            if case let .ready(draft) = r { return (row: idx + 2, draft: draft) }
            return nil
        }
    }

    var readyCount: Int { previewRows.filter { if case .ready = $0 { return true } else { return false } }.count }
    var errorCount: Int { previewRows.count - readyCount }
    var canCommit: Bool { hasTitleMapping && readyCount > 0 && phase == .mapping }

    // MARK: - Commit

    func commit(userId: String) async {
        guard canCommit else { return }
        phase = .committing
        progressDone = 0
        progressTotal = readyDrafts.count
        let outcome = await importer.commit(
            drafts: readyDrafts,
            userId: userId,
            progress: { [weak self] done, total in
                Task { @MainActor in
                    self?.progressDone = done
                    self?.progressTotal = total
                }
            }
        )
        result = outcome
        phase = .done
        // Nudge a sync so freshly-imported rows appear in the local mirror.
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
    }

    func reset() {
        phase = .source
        sheet = nil
        mapping = []
        result = nil
        errorBanner = nil
        progressDone = 0
        progressTotal = 0
    }
}
