import XCTest
@testable import GradeThread

/// US-666 — payout reconciliation store + decode helpers. The edge calls are
/// faked so the store logic (load / auto-match / match / dismiss / error
/// surfacing) is exercised without a network.
final class PayoutReconciliationTests: XCTestCase {

    // MARK: - Fake

    final class FakeService: PayoutReconciliationProviding {
        var entries: [PayoutQueueEntry]
        var runResult = PayoutRunResult(autoMatched: 2, ambiguous: 1, noCandidates: 0, scanned: 3)
        var matchError: Error?
        var dismissError: Error?
        var importError: Error?
        var importResult = PayoutImportResult(imported: 3, skipped: 0, duplicates: 1)
        private(set) var matched: [(String, String)] = []
        private(set) var dismissed: [String] = []
        private(set) var importedCsv: [String] = []

        init(entries: [PayoutQueueEntry]) { self.entries = entries }

        func queue() async throws -> [PayoutQueueEntry] { entries }
        func run() async throws -> PayoutRunResult { runResult }
        func match(payoutImportId: String, saleId: String) async throws {
            if let matchError { throw matchError }
            matched.append((payoutImportId, saleId))
        }
        func dismiss(payoutImportId: String) async throws {
            if let dismissError { throw dismissError }
            dismissed.append(payoutImportId)
        }
        func importCsv(_ csv: String) async throws -> PayoutImportResult {
            if let importError { throw importError }
            importedCsv.append(csv)
            return importResult
        }
    }

    private func entry(_ id: String, candidates: [PayoutCandidate]) -> PayoutQueueEntry {
        PayoutQueueEntry(
            payoutImport: PayoutImportSummary(id: id, payoutDate: "2024-01-05", amount: 42.0, createdAt: nil),
            candidates: candidates)
    }
    private func candidate(_ saleId: String, score: Double) -> PayoutCandidate {
        PayoutCandidate(saleId: saleId, itemId: "i-\(saleId)", itemTitle: "Item \(saleId)",
                        saleDate: "2024-01-03", salePrice: 50, payoutAmount: 42,
                        payoutReference: nil, score: score, reasons: ["amount within $0.00"])
    }

    @MainActor
    func test_load_populatesEntriesAndReadyPhase() async {
        let fake = FakeService(entries: [entry("p1", candidates: [candidate("s1", score: 0.9)])])
        let store = PayoutReconciliationStore(service: fake)
        await store.load()
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.unreconciledCount, 1)
    }

    @MainActor
    func test_runAutoMatch_storesResultAndReloads() async {
        let fake = FakeService(entries: [entry("p1", candidates: [candidate("s1", score: 0.9)])])
        let store = PayoutReconciliationStore(service: fake)
        await store.load()
        fake.entries = []                     // server matched it during the sweep
        await store.runAutoMatch()
        XCTAssertEqual(store.lastRun?.autoMatched, 2)
        XCTAssertEqual(store.unreconciledCount, 0)
    }

    @MainActor
    func test_match_removesEntryAndRecordsCall() async {
        let e = entry("p1", candidates: [candidate("s1", score: 0.9)])
        let fake = FakeService(entries: [e])
        let store = PayoutReconciliationStore(service: fake)
        await store.load()
        await store.match(e, to: e.candidates[0])
        XCTAssertTrue(store.entries.isEmpty)
        XCTAssertEqual(fake.matched.first?.0, "p1")
        XCTAssertEqual(fake.matched.first?.1, "s1")
    }

    @MainActor
    func test_match_failureKeepsEntryAndSurfacesError() async {
        let e = entry("p1", candidates: [candidate("s1", score: 0.9)])
        let fake = FakeService(entries: [e])
        fake.matchError = EdgeAPIError.badRequest(detail: "This sale is already linked to a different payout.")
        let store = PayoutReconciliationStore(service: fake)
        await store.load()
        await store.match(e, to: e.candidates[0])
        XCTAssertEqual(store.unreconciledCount, 1)
        XCTAssertNotNil(store.actionError)
    }

    @MainActor
    func test_dismiss_removesEntry() async {
        let e = entry("p1", candidates: [])
        let fake = FakeService(entries: [e])
        let store = PayoutReconciliationStore(service: fake)
        await store.load()
        await store.dismiss(e)
        XCTAssertTrue(store.entries.isEmpty)
        XCTAssertEqual(fake.dismissed, ["p1"])
    }

    @MainActor
    func test_importCsv_uploadsTextAndReloadsQueue() async {
        let fake = FakeService(entries: [])
        fake.importResult = PayoutImportResult(imported: 2, skipped: 0, duplicates: 1)
        let store = PayoutReconciliationStore(service: fake)
        // After import the server returns the newly-imported unreconciled rows.
        let pending = entry("p1", candidates: [candidate("s1", score: 0.9)])
        await store.importCsv("payout id,date,amount\nx,2024-01-05,42")
        // Reload happens inside importCsv; simulate the server now returning rows.
        fake.entries = [pending]
        await store.load()
        XCTAssertEqual(fake.importedCsv.count, 1)
        XCTAssertEqual(store.lastImport?.imported, 2)
        XCTAssertEqual(store.lastImport?.duplicates, 1)
        XCTAssertNotNil(store.actionBanner)
        XCTAssertEqual(store.unreconciledCount, 1)
    }

    @MainActor
    func test_importCsv_emptyFileSurfacesActionableError() async {
        let fake = FakeService(entries: [])
        let store = PayoutReconciliationStore(service: fake)
        await store.importCsv("   \n  ")
        XCTAssertTrue(fake.importedCsv.isEmpty)
        XCTAssertNotNil(store.actionError)
    }

    @MainActor
    func test_importCsv_badCsvSurfacesServerMessage() async {
        let fake = FakeService(entries: [])
        fake.importError = EdgeAPIError.badRequest(
            detail: "Could not find a payouts table in this CSV.")
        let store = PayoutReconciliationStore(service: fake)
        await store.importCsv("not,a,payout,file")
        XCTAssertNil(store.lastImport)
        XCTAssertEqual(store.actionError, "Could not find a payouts table in this CSV.")
    }

    func test_importSummary_formatsCounts() {
        let r = PayoutImportResult(imported: 1, skipped: 2, duplicates: 1)
        let s = PayoutReconciliationStore.importSummary(r)
        XCTAssertTrue(s.contains("Imported 1 payout"))
        XCTAssertTrue(s.contains("1 duplicate skipped"))
        XCTAssertTrue(s.contains("2 rows skipped"))
    }

    func test_topCandidate_picksHighestScore() {
        let e = PayoutQueueEntry(
            payoutImport: PayoutImportSummary(id: "p", payoutDate: nil, amount: nil, createdAt: nil),
            candidates: [candidate("low", score: 0.4), candidate("high", score: 0.95)])
        XCTAssertEqual(e.topCandidate?.saleId, "high")
        XCTAssertEqual(e.topCandidate?.scorePercent, 95)
    }

    func test_dateParse_handlesDateOnlyAndISO() {
        XCTAssertNotNil(PayoutDateFormat.parse("2024-01-05"))
        XCTAssertNotNil(PayoutDateFormat.parse("2024-01-05T12:00:00Z"))
        XCTAssertNil(PayoutDateFormat.parse(nil))
        XCTAssertEqual(PayoutDateFormat.display(nil), "—")
    }
}
