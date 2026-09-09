import UIKit
import XCTest
@testable import GradeThread

/// US-3236: the decoded-thumbnail cache was bounded by COUNT only, so 400
/// entries could be 400 inventory rows (a few MB) or 400 eBay preview heroes
/// (gigabytes), and nothing evicted the second case because the count was still
/// under the limit. These pin the cost accounting that makes the bound about
/// memory instead.
final class ThumbnailCacheCostTests: XCTestCase {

    private func image(width: Int, height: Int, scale: CGFloat = 1) -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = scale
        format.opaque = true
        let size = CGSize(width: CGFloat(width) / scale, height: CGFloat(height) / scale)
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.gray.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
    }

    func test_cost_isProportionalToPixelsNotPoints() {
        let small = ThumbnailLoader.decodedByteCost(image(width: 100, height: 100))
        let big = ThumbnailLoader.decodedByteCost(image(width: 200, height: 200))

        // Four times the pixels, four times the cost (allow a little slack for
        // row padding, which CGImage is free to add).
        XCTAssertGreaterThan(Double(big), Double(small) * 3.5)
        XCTAssertLessThan(Double(big), Double(small) * 4.5)
    }

    /// A 2x image of the same POINT size holds four times the pixels. Costing it
    /// by `size` alone would under-count by exactly this factor, which is how a
    /// cache budget silently becomes four times the number it says.
    func test_cost_countsBackingPixelsAtScale() {
        let onePoint = ThumbnailLoader.decodedByteCost(image(width: 100, height: 100, scale: 1))
        let twoPoint = ThumbnailLoader.decodedByteCost(image(width: 200, height: 200, scale: 2))

        XCTAssertGreaterThan(Double(twoPoint), Double(onePoint) * 3.5)
    }

    func test_cost_isAtLeastOneSoNothingIsFree() {
        XCTAssertGreaterThanOrEqual(ThumbnailLoader.decodedByteCost(UIImage()), 1)
    }

    /// The budget has to be small enough that a handful of full-size heroes
    /// cannot all sit in it at once — that was the failure. A 1200pt hero on a
    /// 3x screen is 3600x3600, about 52 MB.
    func test_memoryBudget_cannotHoldTwoFullSizeHeroes() {
        let heroBytes = 3600 * 3600 * 4
        XCTAssertLessThan(ThumbnailLoader.memoryBudgetBytes, heroBytes * 2)
        // ...but comfortably holds a screen of 56pt rows at 3x (168px each).
        let rowBytes = 168 * 168 * 4
        XCTAssertGreaterThan(ThumbnailLoader.memoryBudgetBytes, rowBytes * 200)
    }
}
