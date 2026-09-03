import XCTest
import SwiftData
@testable import GradeThread

/// US-3100 — the sourcing log.
///
/// Prospect answered "is this worth buying" and then threw the answer away the
/// moment the sheet closed. A seller who scans six garments and buys two has no
/// way back to the close call they passed on, short of re-scanning it — a
/// second metered AI action for an answer we already had.
///
/// Three claims are worth a test and they are all about BOUNDS: the log holds
/// twenty and not twenty-one, it holds one tenant's rows and not another's, and
/// a saved verdict commits the same inventory row the live scan would have.
@MainActor
final class ProspectLogTests: XCTestCase {

    private var container: ModelContainer!
    private var context: ModelContext!

    override func setUpWithError() throws {
        let config = ModelConfiguration(
            schema: ModelStoreProvider.schema,
            isStoredInMemoryOnly: true,
            cloudKitDatabase: .none
        )
        container = try ModelContainer(
            for: ModelStoreProvider.schema,
            migrationPlan: GradeThreadMigrationPlan.self,
            configurations: config
        )
        context = ModelContext(container)
    }

    override func tearDown() {
        context = nil
        container = nil
        super.tearDown()
    }

    // MARK: - Prune to 20

    func test_pruneKeepsTwentyNotNineteenAndNotTwentyOne() {
        // The off-by-one IS the rule. A log that quietly holds 19 is
        // indistinguishable from one that holds 20 until somebody counts.
        let rows = (0..<25).map { index in
            LocalProspectResult(userId: "u1", title: "row \(index)", createdAt: Date(timeIntervalSince1970: Double(index)))
        }.reversed().map { $0 } // newest first, the order prune is given

        XCTAssertEqual(ProspectLog.rowsToPrune(rows, keep: 20).count, 5)
        XCTAssertEqual(ProspectLog.rowsToPrune(Array(rows.prefix(20)), keep: 20).count, 0)
        XCTAssertEqual(ProspectLog.rowsToPrune(Array(rows.prefix(21)), keep: 20).count, 1)
    }

    func test_pruneDropsTheOLDESTRowsNotTheNewest() {
        let rows = (0..<22).map { index in
            LocalProspectResult(
                userId: "u1",
                title: "row \(index)",
                createdAt: Date(timeIntervalSince1970: Double(1000 - index))
            )
        } // already newest-first: index 0 has the latest date

        let pruned = ProspectLog.rowsToPrune(rows, keep: 20).map(\.title)
        XCTAssertEqual(pruned, ["row 20", "row 21"])
    }

    func test_recordPrunesTheStoreToTwenty() throws {
        let log = ProspectLog(context: context, userId: "u1")
        for index in 0..<24 {
            log.record(response(title: "item \(index)"), thumbnail: nil)
        }
        let all = try context.fetch(FetchDescriptor<LocalProspectResult>())
        XCTAssertEqual(all.count, ProspectLog.keepCount)
        // The newest survive.
        XCTAssertTrue(all.contains { $0.title == "item 23" })
        XCTAssertFalse(all.contains { $0.title == "item 0" })
    }

    // MARK: - Tenants

    func test_oneTenantsLogNeverShowsAnothers() throws {
        ProspectLog(context: context, userId: "u1").record(response(title: "A's jacket"), thumbnail: nil)
        ProspectLog(context: context, userId: "u2").record(response(title: "B's jacket"), thumbnail: nil)

        let asSeen = ProspectLog(context: context, userId: "u1").recent(limit: 10).map(\.title)
        XCTAssertEqual(asSeen, ["A's jacket"])
    }

    func test_pruningOneTenantDoesNotEvictAnother() throws {
        let a = ProspectLog(context: context, userId: "u1")
        a.record(response(title: "A's only scan"), thumbnail: nil)

        let b = ProspectLog(context: context, userId: "u2")
        for index in 0..<25 { b.record(response(title: "B \(index)"), thumbnail: nil) }

        // A busy shared iPad must not cost the other account its whole log:
        // the cap is per tenant, not per device.
        XCTAssertEqual(a.recent(limit: 30).count, 1)
        XCTAssertEqual(b.recent(limit: 30).count, ProspectLog.keepCount)
    }

    func test_signOutWipeRemovesTheLog() throws {
        ProspectLog(context: context, userId: "u1").record(response(title: "kept until sign-out"), thumbnail: nil)
        XCTAssertEqual(try context.fetch(FetchDescriptor<LocalProspectResult>()).count, 1)

        // The same call ContentView.clearAllLocalDataOnSignOut makes. The log is
        // local-only and never synced, so nothing would re-pull it — which is
        // exactly why forgetting it here would leave one seller's sourcing list
        // on screen for the next account (US-2496).
        try context.delete(model: LocalProspectResult.self)
        try context.save()
        XCTAssertEqual(try context.fetch(FetchDescriptor<LocalProspectResult>()).count, 0)
    }

    func test_theModelIsRegisteredInTheSchema() {
        // A model missing from GradeThreadSchemaV1.models does not fail to
        // compile; it fails at runtime, on the first insert, in the seller's
        // hands.
        XCTAssertTrue(ModelStoreProvider.schema.entities.map(\.name).contains("LocalProspectResult"))
    }

    // MARK: - Hiding when empty

    func test_anEmptyLogHasNothingToShow() {
        // The Home section renders `recent()` and hides itself when it is empty.
        // A "Recently prospected" heading over nothing is how a seller learns
        // that part of Home is furniture.
        XCTAssertTrue(ProspectLog(context: context, userId: "u1").recent().isEmpty)
    }

    func test_anUnidentifiedScanIsNotLogged() {
        // "We could not tell what this is" is an answer, but it is not one the
        // seller can go back to a rack with, and it would push a real verdict
        // out of a twenty-row log.
        let log = ProspectLog(context: context, userId: "u1")
        XCTAssertNil(log.record(response(title: nil, identified: false), thumbnail: nil))
        XCTAssertTrue(log.recent().isEmpty)
    }

    // MARK: - What a saved verdict commits

    func test_aSavedVerdictCommitsWhatTheLiveScanWouldHave() throws {
        let log = ProspectLog(context: context, userId: "u1")
        let live = response(title: "We The Free waffle henley")
        XCTAssertNotNil(log.record(live, thumbnail: nil))

        let row = try XCTUnwrap(log.recent().first)
        let fromRow = try XCTUnwrap(ProspectCommit(row))
        let fromScan = try XCTUnwrap(ProspectCommit(live))

        XCTAssertEqual(fromRow.title, fromScan.title)
        XCTAssertEqual(fromRow.brand, fromScan.brand)
        XCTAssertEqual(fromRow.categoryId, fromScan.categoryId)
        XCTAssertEqual(fromRow.categoryPath, fromScan.categoryPath)
        XCTAssertEqual(fromRow.gradeValue, fromScan.gradeValue)
        XCTAssertEqual(fromRow.gradeLabel, fromScan.gradeLabel)
        // The median is the price suggestion on the new inventory row.
        XCTAssertEqual(fromRow.targetCents, fromScan.targetCents)
        XCTAssertEqual(fromRow.costCents, fromScan.costCents)
    }

    func test_theCategoryPathRidesInTheNotesBecauseThereIsNoColumnForIt() throws {
        let commit = try XCTUnwrap(ProspectCommit(response(title: "Patagonia Better Sweater")))
        XCTAssertEqual(commit.request.categoryId, "57988")
        let notes = try XCTUnwrap(commit.conditionNotes)
        XCTAssertTrue(notes.contains("Category: Clothing > Sweaters"))
    }

    func test_anUnidentifiedResultCommitsNothing() {
        XCTAssertNil(ProspectCommit(response(title: nil, identified: false)))
        XCTAssertNil(ProspectCommit(response(title: "")))
    }

    func test_markAddedLinksTheRowToTheItem() throws {
        let log = ProspectLog(context: context, userId: "u1")
        let rowId = try XCTUnwrap(log.record(response(title: "linked"), thumbnail: nil))
        log.markAdded(rowId: rowId, itemId: "item-42")
        XCTAssertEqual(log.row(id: rowId)?.addedItemId, "item-42")
    }

    // MARK: - Fixtures

    private func response(title: String?, identified: Bool = true) -> ProspectResponse {
        let json = """
        {
          "identified": \(identified),
          "item": {
            "brand": "Patagonia",
            "title": \(title.map { "\"\($0)\"" } ?? "null"),
            "keywords": ["fleece", "quarter zip"],
            "identifyConfidence": 0.9,
            "identitySource": "tag",
            "identityIsAuthoritative": false,
            "garmentType": "sweater",
            "color": "navy",
            "material": "polyester",
            "gender": "men",
            "size": "M",
            "styleCode": null
          },
          "category": { "id": "57988", "path": "Clothing > Sweaters" },
          "grade": { "value": 8.0, "tier": "excellent", "confidence": 0.82 },
          "stats": {
            "count": 24,
            "lowCents": 3200,
            "medianCents": 5400,
            "highCents": 8900,
            "currency": "USD",
            "confidence": 0.8,
            "sufficient": true,
            "basis": null
          },
          "sellThrough": null,
          "costCents": 1200,
          "decision": {
            "recommendation": "buy",
            "estProceedsCents": 4100,
            "estMarginCents": 2900,
            "roiPct": 2.4,
            "breakevenCents": 1600,
            "reason": "Sells for well above what you would pay.",
            "confident": true
          },
          "ceiling": {
            "maxPriceCents": 2600,
            "targetRoi": 0.3,
            "netResaleCents": 4100,
            "absentReason": null
          },
          "ebaySoldSearchUrl": null,
          "ebaySoldSearchQuery": null,
          "ebayBroadSearchUrl": null,
          "ebayBroadSearchQuery": null,
          "source": "active",
          "disclaimer": null,
          "note": null
        }
        """
        // Force-decoded on purpose: a malformed fixture is a broken test, and
        // failing here with the decoding error is more useful than every
        // assertion below failing on an optional that is nil for a reason
        // nobody can see.
        // swiftlint:disable:next force_try
        return try! JSONDecoder().decode(ProspectResponse.self, from: Data(json.utf8))
    }
}
