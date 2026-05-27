import XCTest
import SwiftUI
@testable import GradeThread

final class GradeThreadTests: XCTestCase {
    func testBrandPaletteDefined() {
        // Sanity-check that the brand palette extensions compile and resolve.
        // Mirrors src/index.css custom properties on the web.
        _ = Color.brandNavy
        _ = Color.brandRed
    }
}
