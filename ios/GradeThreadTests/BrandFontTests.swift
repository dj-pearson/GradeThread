import XCTest
import UIKit
@testable import GradeThread

/// US-654 — verifies the brand typefaces are bundled and register under the
/// PostScript names the `Font`/`BrandFont` scale references. Runs in the
/// app-hosted test bundle, so `Bundle.main` is the app bundle and its
/// `UIAppFonts` are registered at launch.
final class BrandFontTests: XCTestCase {

    private let faces = [
        "Outfit-Regular", "Outfit-SemiBold", "Outfit-Bold",
        "Inter-Regular", "Inter-Medium", "Inter-Bold",
    ]

    func test_fontFiles_areBundled() {
        for face in faces {
            XCTAssertNotNil(
                Bundle.main.url(forResource: face, withExtension: "ttf"),
                "\(face).ttf is not in the app bundle")
        }
    }

    func test_fonts_resolveByPostScriptName() {
        for face in faces {
            let font = UIFont(name: face, size: 17)
            XCTAssertNotNil(font, "\(face) failed to register / resolve")
            // When a custom face resolves, its fontName matches what we asked for.
            XCTAssertEqual(font?.fontName, face)
        }
    }

    func test_brandFontConstants_matchBundledFaces() {
        XCTAssertEqual(BrandFont.outfitRegular, "Outfit-Regular")
        XCTAssertEqual(BrandFont.outfitSemiBold, "Outfit-SemiBold")
        XCTAssertEqual(BrandFont.outfitBold, "Outfit-Bold")
        XCTAssertEqual(BrandFont.interRegular, "Inter-Regular")
        XCTAssertEqual(BrandFont.interMedium, "Inter-Medium")
        XCTAssertEqual(BrandFont.interBold, "Inter-Bold")
    }
}
