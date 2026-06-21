import XCTest
import SwiftUI
@testable import GradeThread

/// US-1152: the scaled-icon clamp keeps a Dynamic-Type-scaled glyph from
/// overflowing a fixed frame at the largest accessibility text sizes.
final class ScaledIconFontTests: XCTestCase {

    func test_resolve_noMax_returnsScaledSize() {
        XCTAssertEqual(ScaledIconFont.resolve(scaled: 72, maxSize: nil), 72)
    }

    func test_resolve_belowMax_returnsScaledSize() {
        XCTAssertEqual(ScaledIconFont.resolve(scaled: 40, maxSize: 96), 40)
    }

    func test_resolve_aboveMax_clampsToMax() {
        // AX5 scales a 60pt base well past the 96pt cap → clamp.
        XCTAssertEqual(ScaledIconFont.resolve(scaled: 130, maxSize: 96), 96)
    }
}
