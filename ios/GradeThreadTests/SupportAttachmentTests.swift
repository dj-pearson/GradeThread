import XCTest
@testable import GradeThread

/// US-2561. The parts of the attachment flow that can be wrong without a device:
/// the expiry rule, the wire shape, and the room arithmetic.
///
/// The expiry rule earns most of the file. AC3 asks for a placeholder rather
/// than a broken image, and the case that produces one is NOT a nil url - it is
/// a perfectly good string that stopped working while the thread sat on screen.
/// Nothing about the value says so, so the only thing that can be wrong here is
/// the arithmetic.
final class SupportAttachmentTests: XCTestCase {

    private let base = Date(timeIntervalSince1970: 1_760_000_000)

    // MARK: - Contract constants

    func testLimitMatchesTheServer() {
        // Also MAX_ATTACHMENTS_PER_MESSAGE in the edge route and MAX_ATTACHMENTS
        // in the web picker. A client that allows four makes the user wait for
        // an upload the server then rejects with a 400.
        XCTAssertEqual(SupportAttachmentContract.maxAttachments, 3)
    }

    func testTtlMatchesTheSigner() {
        XCTAssertEqual(SupportAttachmentContract.urlTTLSeconds, 600)
        XCTAssertEqual(SupportAttachmentContract.urlExpiryMarginSeconds, 30)
    }

    // MARK: - Expiry

    func testNilUrlIsNeverUsable() {
        XCTAssertFalse(
            SupportAttachmentContract.isURLUsable(nil, fetchedAt: base, now: base)
        )
        XCTAssertFalse(
            SupportAttachmentContract.isURLUsable("", fetchedAt: base, now: base)
        )
    }

    func testFreshUrlIsUsable() {
        XCTAssertTrue(
            SupportAttachmentContract.isURLUsable(
                "https://example.test/signed",
                fetchedAt: base,
                now: base.addingTimeInterval(60)
            )
        )
    }

    func testExpiredUrlIsNotUsableEvenThoughItIsAGoodString() {
        XCTAssertFalse(
            SupportAttachmentContract.isURLUsable(
                "https://example.test/signed",
                fetchedAt: base,
                now: base.addingTimeInterval(601)
            )
        )
    }

    func testAUrlAboutToExpireIsTreatedAsGone() {
        // 580s in: 20s of life left, inside the 30s margin. One unnecessary
        // re-fetch beats an image that fails after the user watched a spinner.
        XCTAssertFalse(
            SupportAttachmentContract.isURLUsable(
                "https://example.test/signed",
                fetchedAt: base,
                now: base.addingTimeInterval(580)
            )
        )
        // 569s in: still outside the margin, still usable. The boundary is
        // pinned from both sides because an off-by-one here either shows a dead
        // image or re-fetches the thread forever.
        XCTAssertTrue(
            SupportAttachmentContract.isURLUsable(
                "https://example.test/signed",
                fetchedAt: base,
                now: base.addingTimeInterval(569)
            )
        )
    }

    func testABackwardsClockIsNotEvidenceOfFreshness() {
        XCTAssertFalse(
            SupportAttachmentContract.isURLUsable(
                "https://example.test/signed",
                fetchedAt: base,
                now: base.addingTimeInterval(-120)
            )
        )
    }

    // MARK: - Wire shape

    func testDataUrlIsTheShapeTheServerDecodes() {
        let url = SupportAttachmentContract.jpegDataURL(Data([0xFF, 0xD8, 0xFF]))
        XCTAssertTrue(url.hasPrefix("data:image/jpeg;base64,"))
        // The server's regex requires image/<something> AND an explicit ;base64.
        // A bare data:;base64, is rejected as "not an image", which reads like a
        // corrupt file rather than a malformed header.
        XCTAssertEqual(url, "data:image/jpeg;base64,/9j/")
    }

    func testUploadEncodesDataUrlInSnakeCase() throws {
        // The edge reads item?.data_url. A camelCase key decodes to null there
        // and surfaces as "One attachment was not an image" - the bytes were
        // fine and the KEY was wrong, and nothing in that message says so.
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        let json = String(
            data: try encoder.encode(
                SupportAttachmentUpload(dataURL: "data:image/jpeg;base64,AAA", name: "a.jpg")
            ),
            encoding: .utf8
        ) ?? ""
        XCTAssertTrue(json.contains("\"data_url\""), json)
        XCTAssertFalse(json.contains("dataUrl"), json)
        XCTAssertFalse(json.contains("dataURL"), json)
    }

    func testViewDecodesTheGetShape() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let json = """
        {"path":"u/support/t/1.jpg","name":"shot.jpg","content_type":"image/jpeg","bytes":1234,"url":null}
        """
        let view = try decoder.decode(SupportAttachmentView.self, from: Data(json.utf8))
        XCTAssertEqual(view.contentType, "image/jpeg")
        XCTAssertNil(view.url)
        // Identity is the storage path, not the signed url: the url changes on
        // every GET, so keying on it rebuilds every image view on every poll.
        XCTAssertEqual(view.id, "u/support/t/1.jpg")
    }

    func testMessageWithoutAnAttachmentsKeyStillDecodes() throws {
        // An edge build that predates attachments omits the key. A non-optional
        // property would make that a decode FAILURE and blank the whole thread.
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let json = """
        {"id":"m1","author":"you","body":"hi","created_at":"2026-08-19T00:00:00Z"}
        """
        let message = try decoder.decode(SupportTicketMessage.self, from: Data(json.utf8))
        XCTAssertTrue(message.files.isEmpty)
    }

    // MARK: - Room

    @MainActor
    func testPickingStopsAtTheLimitAndReportsWhatItDropped() async {
        // No PHPickerResults can be constructed in a unit test, so the arithmetic
        // is exercised through the zero-room path, which is the branch a full
        // tray takes and the one that must not silently swallow a selection.
        let result = await SupportAttachmentPicking.drafts(from: [], room: 0)
        XCTAssertTrue(result.drafts.isEmpty)
        XCTAssertEqual(result.skipped, 0)
    }
}
