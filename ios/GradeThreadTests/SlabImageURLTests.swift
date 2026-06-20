import XCTest
@testable import GradeThread

/// US-768/US-764: the iOS twin of the web `slab-image.test.ts` — derives the
/// Digital-Slab image URL from an item's public certificate URL.
final class SlabImageURLTests: XCTestCase {

    func test_rewritesCertToSlabCert_andAppendsSquareByDefault() {
        let url = SlabImageURL.url(
            certificateURL: "https://gradethread.com/cert/abc-123",
            format: .square)
        XCTAssertEqual(url?.absoluteString,
                       "https://gradethread.com/slab/cert/abc-123?format=square")
    }

    func test_appendsEachFormat() {
        let base = "https://gradethread.com/cert/abc-123"
        XCTAssertEqual(
            SlabImageURL.url(certificateURL: base, format: .portrait)?.absoluteString,
            "https://gradethread.com/slab/cert/abc-123?format=portrait")
        XCTAssertEqual(
            SlabImageURL.url(certificateURL: base, format: .story)?.absoluteString,
            "https://gradethread.com/slab/cert/abc-123?format=story")
        XCTAssertEqual(
            SlabImageURL.url(certificateURL: base, format: .label)?.absoluteString,
            "https://gradethread.com/slab/cert/abc-123?format=label")
    }

    func test_usesAmpersandWhenCertUrlAlreadyHasQuery() {
        let url = SlabImageURL.url(
            certificateURL: "https://gradethread.com/cert/abc-123?s=qr",
            format: .square)
        XCTAssertEqual(url?.absoluteString,
                       "https://gradethread.com/slab/cert/abc-123?s=qr&format=square")
    }

    func test_rewritesOnlyTheFirstCertSegment() {
        // A defensive case: the id never contains "/cert/", but if a URL did the
        // path segment is what gets rewritten, not later occurrences.
        let url = SlabImageURL.url(
            certificateURL: "https://gradethread.com/cert/x",
            format: .square)
        XCTAssertEqual(url?.absoluteString,
                       "https://gradethread.com/slab/cert/x?format=square")
    }

    func test_nilWhenNoPublicCertificate() {
        XCTAssertNil(SlabImageURL.url(certificateURL: nil, format: .square))
        XCTAssertNil(SlabImageURL.url(certificateURL: "", format: .square))
        XCTAssertNil(SlabImageURL.url(certificateURL: "   ", format: .square))
        // A non-certificate URL (no /cert/ segment) yields nil rather than a
        // bogus slab URL.
        XCTAssertNil(SlabImageURL.url(certificateURL: "https://gradethread.com/x", format: .square))
    }

    func test_formatAspectRatios() {
        XCTAssertEqual(SlabFormat.square.aspectRatio, 1)
        XCTAssertEqual(SlabFormat.label.aspectRatio, 1)
        XCTAssertEqual(SlabFormat.portrait.aspectRatio, 4.0 / 5.0, accuracy: 0.0001)
        XCTAssertEqual(SlabFormat.story.aspectRatio, 9.0 / 16.0, accuracy: 0.0001)
    }

    func test_allFormatsHaveLabels() {
        for f in SlabFormat.allCases {
            XCTAssertFalse(f.label.isEmpty, "\(f) missing label")
        }
    }
}
