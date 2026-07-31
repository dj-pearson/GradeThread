import ImageIO
import XCTest
@testable import GradeThread

/// US-2373: reading a photo's real shutter time out of its EXIF block. This is
/// what gives the AutoLister batch genuine capture times — the picker is
/// deliberately configured without library access (US-1013), so the PHAsset
/// route can never supply them and every photo used to arrive stamped `.now`.
final class ImageCaptureDateTests: XCTestCase {

    private func components(_ date: Date, zone: TimeZone) -> DateComponents {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    }

    func test_parse_readsAnExifTimestampInTheDevicesZone() throws {
        let date = try XCTUnwrap(ImageCaptureDate.parse("2026:07:31 14:03:22"))
        let parts = components(date, zone: .current)
        XCTAssertEqual(parts.year, 2026)
        XCTAssertEqual(parts.month, 7)
        XCTAssertEqual(parts.day, 31)
        XCTAssertEqual(parts.hour, 14)
        XCTAssertEqual(parts.minute, 3)
        XCTAssertEqual(parts.second, 22)
    }

    func test_parse_honoursAnOffsetTimeTagWhenTheCameraWroteOne() throws {
        let utc = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let date = try XCTUnwrap(ImageCaptureDate.parse("2026:07:31 14:00:00", offset: "+02:00"))
        XCTAssertEqual(components(date, zone: utc).hour, 12)

        let behind = try XCTUnwrap(ImageCaptureDate.parse("2026:07:31 14:00:00", offset: "-07:30"))
        let parts = components(behind, zone: utc)
        XCTAssertEqual(parts.hour, 21)
        XCTAssertEqual(parts.minute, 30)
    }

    func test_parse_rejectsAnUnsetCameraClockAndGarbage() {
        XCTAssertNil(ImageCaptureDate.parse("0000:00:00 00:00:00"))
        XCTAssertNil(ImageCaptureDate.parse(""))
        XCTAssertNil(ImageCaptureDate.parse("last Tuesday"))
        // ISO-8601 is NOT the EXIF format — don't silently accept it.
        XCTAssertNil(ImageCaptureDate.parse("2026-07-31T14:03:22Z"))
    }

    func test_properties_prefersTheOriginalShutterTimeOverTheDigitizeAndTiffTimes() throws {
        let properties: [String: Any] = [
            kCGImagePropertyExifDictionary as String: [
                kCGImagePropertyExifDateTimeOriginal as String: "2026:07:31 09:00:00",
                kCGImagePropertyExifDateTimeDigitized as String: "2026:07:31 10:00:00",
            ],
            kCGImagePropertyTIFFDictionary as String: [
                kCGImagePropertyTIFFDateTime as String: "2026:07:31 11:00:00",
            ],
        ]
        let date = try XCTUnwrap(ImageCaptureDate.from(properties: properties))
        XCTAssertEqual(components(date, zone: .current).hour, 9)
    }

    func test_properties_fallsBackToDigitizedThenTiff() throws {
        let digitized: [String: Any] = [
            kCGImagePropertyExifDictionary as String: [
                kCGImagePropertyExifDateTimeDigitized as String: "2026:07:31 10:00:00",
            ],
            kCGImagePropertyTIFFDictionary as String: [
                kCGImagePropertyTIFFDateTime as String: "2026:07:31 11:00:00",
            ],
        ]
        XCTAssertEqual(
            components(try XCTUnwrap(ImageCaptureDate.from(properties: digitized)), zone: .current).hour,
            10
        )

        let tiffOnly: [String: Any] = [
            kCGImagePropertyTIFFDictionary as String: [
                kCGImagePropertyTIFFDateTime as String: "2026:07:31 11:00:00",
            ],
        ]
        XCTAssertEqual(
            components(try XCTUnwrap(ImageCaptureDate.from(properties: tiffOnly)), zone: .current).hour,
            11
        )
    }

    /// A screenshot or a re-encoded export carries no timestamp at all. That
    /// must read as "timeless", not as a fabricated time — grouping treats the
    /// two completely differently.
    func test_properties_returnsNilWhenTheFileCarriesNoTimestamp() {
        XCTAssertNil(ImageCaptureDate.from(properties: [:]))
        XCTAssertNil(ImageCaptureDate.from(properties: [
            kCGImagePropertyExifDictionary as String: [
                kCGImagePropertyExifLensMake as String: "Apple",
            ],
        ]))
    }

    func test_from_data_returnsNilForNonImageBytes() {
        XCTAssertNil(ImageCaptureDate.from(Data("not an image".utf8)))
    }
}
