import XCTest
@testable import GradeThread

/// US-3014 AC3 — the receipt scan decoder.
///
/// TESTED AGAINST WRONG OUTPUT, NOT RIGHT OUTPUT. A decoder that only ever sees
/// a perfect response proves nothing: the reason this file exists is the
/// blurred photo, the crumpled receipt and the model that answered with half a
/// draft, and those are the cases below.
@MainActor
final class ReceiptScanTests: XCTestCase {

    func test_decodesAFullReadWithVerbatimKeys() throws {
        // The KEYS matter. `confidence` is a map whose keys are field names in
        // snake_case, and EdgeAPI's typed helper rewrites dictionary keys as
        // well as coding keys — so this response went through the raw path and
        // this decoder instead. If that regressed, `confidence["total_cents"]`
        // would come back nil here while `low_confidence` still said
        // "total_cents", and the two halves of one answer would disagree.
        let json = #"""
        {"staging_path":"u1/_staging/receipt_1.jpg",
         "draft":{"vendor":"Goodwill","spent_on":"2026-03-04","total_cents":1875,
                  "tax_cents":125,"category":"shipping_supplies",
                  "lines":[{"description":"Box","amount_cents":900}]},
         "confidence":{"total_cents":0.94,"spent_on":0.42},
         "low_confidence":["spent_on"],
         "lines_gap_cents":850,
         "prompt_version":"receipt-v3"}
        """#
        let r = try ReceiptScanService.decode(Data(json.utf8))
        XCTAssertEqual(r.stagingPath, "u1/_staging/receipt_1.jpg")
        XCTAssertEqual(r.draft?.vendor, "Goodwill")
        XCTAssertEqual(r.draft?.totalCents, 1875)
        XCTAssertEqual(r.draft?.lines.first?.amountCents, 900)
        XCTAssertEqual(r.confidence["total_cents"], 0.94)
        XCTAssertEqual(r.lowConfidence, ["spent_on"])
        XCTAssertEqual(r.linesGapCents, 850)
        XCTAssertEqual(r.promptVersion, "receipt-v3")
        XCTAssertTrue(r.readAnything)
    }

    func test_theConfidenceMapAndTheLowConfidenceListUseTheSameSpelling() throws {
        // The specific regression the raw-decode path exists to prevent.
        let json = #"""
        {"staging_path":"u1/_staging/r.jpg","draft":{"vendor":"X"},
         "confidence":{"spent_on":0.31},"low_confidence":["spent_on"]}
        """#
        let r = try ReceiptScanService.decode(Data(json.utf8))
        for field in r.lowConfidence {
            XCTAssertNotNil(
                r.confidence[field],
                "\(field) is flagged low-confidence but has no score under that name"
            )
        }
        XCTAssertTrue(r.needsALook("spent_on"))
        XCTAssertFalse(r.needsALook("total_cents"))
    }

    func test_survivesAScanThatReadNothing() throws {
        // A model timeout. The server staged the photo FIRST, so the path is
        // still here and the seller loses nothing but the typing — which is the
        // difference between a degraded feature and a broken one.
        let json = #"""
        {"staging_path":"u1/_staging/r.jpg","draft":null,"confidence":{},
         "warning":"We could not read that one. Your photo is saved."}
        """#
        let r = try ReceiptScanService.decode(Data(json.utf8))
        XCTAssertEqual(r.stagingPath, "u1/_staging/r.jpg")
        XCTAssertNil(r.draft)
        XCTAssertFalse(r.readAnything)
        XCTAssertNotNil(r.warning)
    }

    func test_survivesAPdfWhichIsKeptButNotRead() throws {
        let json = #"""
        {"staging_path":"u1/_staging/r.pdf","draft":null,"confidence":{},
         "warning":"We can keep a PDF receipt but cannot read one yet."}
        """#
        let r = try ReceiptScanService.decode(Data(json.utf8))
        XCTAssertFalse(r.readAnything)
        XCTAssertEqual(r.stagingPath, "u1/_staging/r.pdf")
    }

    func test_survivesAPartialDraft() throws {
        // A vendor and no total is a real answer from a creased receipt. It is
        // still worth pre-filling.
        let json = #"""
        {"staging_path":"u1/_staging/r.jpg","draft":{"vendor":"Savers"}}
        """#
        let r = try ReceiptScanService.decode(Data(json.utf8))
        XCTAssertTrue(r.readAnything)
        XCTAssertEqual(r.prefill().note, "Savers")
        XCTAssertEqual(r.prefill().amountText, "")
    }

    func test_ignoresFieldsTheServerAddsLater() throws {
        // The server owns this contract and will grow. A strict decoder would
        // turn every server improvement into a client crash.
        let json = #"""
        {"staging_path":"u1/_staging/r.jpg","draft":{"vendor":"X","new_field":7},
         "some_future_key":{"nested":true}}
        """#
        let r = try ReceiptScanService.decode(Data(json.utf8))
        XCTAssertEqual(r.draft?.vendor, "X")
    }

    func test_failsWhenTheStagingPathIsMissing() throws {
        // The one field that is NOT optional. The screen promises the seller
        // their photo is saved, and that promise is this string; a nil here
        // would be the app claiming a file it cannot name.
        let json = #"{"draft":{"vendor":"X"}}"#
        XCTAssertThrowsError(try ReceiptScanService.decode(Data(json.utf8)))
    }

    // MARK: - Prefill

    func test_prefillsCentsAsATwoDecimalString() throws {
        let json = #"""
        {"staging_path":"p","draft":{"total_cents":1875,"spent_on":"2026-03-04"}}
        """#
        let r = try ReceiptScanService.decode(Data(json.utf8))
        XCTAssertEqual(r.prefill().amountText, "18.75")
        XCTAssertEqual(MoneyDate.iso(r.prefill().spentOn), "2026-03-04")
    }

    func test_prefillsARoundAmountWithItsCents() throws {
        // "20" in an amount field is fine; "20.00" is what the seller expects
        // to see back from a receipt that said $20.00.
        let json = #"{"staging_path":"p","draft":{"total_cents":2000}}"#
        let r = try ReceiptScanService.decode(Data(json.utf8))
        XCTAssertEqual(r.prefill().amountText, "20.00")
    }

    func test_prefillDateFallsBackToTodayWhenTheServerSentNone() throws {
        let json = #"{"staging_path":"p","draft":{"vendor":"X"}}"#
        let r = try ReceiptScanService.decode(Data(json.utf8))
        let now = MoneyDate.parse("2026-05-05") ?? .distantPast
        XCTAssertEqual(MoneyDate.iso(r.prefill(now: now).spentOn), "2026-05-05")
    }

    func test_prefillFallsBackToOtherForACategoryTheAppDoesNotKnow() throws {
        let json = #"""
        {"staging_path":"p","draft":{"category":"weird_new_thing","total_cents":100}}
        """#
        let r = try ReceiptScanService.decode(Data(json.utf8))
        XCTAssertEqual(r.prefill().category, .other)
    }

    // MARK: - Paths

    func test_theRoutesAreTheOnesTheWebUses() {
        // One prompt, one set of results. A second implementation would drift
        // the first time either side was tuned.
        XCTAssertEqual(ReceiptScanService.extractPath, "/api/flipdesk/expenses/extract")
        XCTAssertEqual(
            ReceiptScanService.adoptPath(expenseId: "e1"),
            "/api/flipdesk/expenses/e1/adopt-staged"
        )
    }

    func test_namesTheUploadedFileSensiblyWithoutTrustingIt() {
        // The server sniffs magic bytes and ignores what we claim (US-276), so
        // this only affects the name in storage.
        XCTAssertEqual(ReceiptScanService.fileExtension(for: "image/png"), "png")
        XCTAssertEqual(ReceiptScanService.fileExtension(for: "image/webp"), "webp")
        XCTAssertEqual(ReceiptScanService.fileExtension(for: "application/pdf"), "pdf")
        XCTAssertEqual(ReceiptScanService.fileExtension(for: "image/heic"), "jpg")
    }
}
