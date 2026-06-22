import UIKit
import XCTest
@testable import GradeThread

/// Tag-photo quality pre-flight (US-686). Covers the deterministic paths
/// (resolution floor + decode-failure leniency) without depending on the OCR
/// recognizer, which the "readable" path uses but these cases short-circuit
/// before reaching.
@MainActor
final class TagPhotoQualityTests: XCTestCase {

    private func solidImage(size: CGSize) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.gray.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
    }

    private func capture(from image: UIImage) -> PhotoCapture {
        PhotoCapture(
            imageData: image.jpegData(compressionQuality: 0.8) ?? Data(),
            thumbnail: image,
            capturedAt: .now,
            source: .camera
        )
    }

    func test_assess_flagsLowResolutionTag() async {
        // 120px long edge is well under the 700px floor → resolution-flagged
        // before OCR ever runs.
        let result = await TagPhotoQuality.assess(capture(from: solidImage(size: CGSize(width: 120, height: 90))))
        XCTAssertEqual(result, .poor(.lowResolution))
    }

    func test_assess_decodeFailureIsLenient() async {
        // Our own decode failure must never block the user.
        let bad = PhotoCapture(imageData: Data([0x00, 0x01, 0x02, 0x03]), thumbnail: UIImage(), source: .camera)
        let result = await TagPhotoQuality.assess(bad)
        XCTAssertEqual(result, .ok)
    }

    func test_message_isNonEmptyForEachReason() {
        XCTAssertFalse(TagPhotoQuality.message(for: .lowResolution).isEmpty)
        XCTAssertFalse(TagPhotoQuality.message(for: .unreadable).isEmpty)
    }
}
