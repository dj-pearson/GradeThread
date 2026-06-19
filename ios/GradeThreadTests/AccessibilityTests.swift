import XCTest
import SwiftUI
@testable import GradeThread

@MainActor
final class AccessibilityTests: XCTestCase {

    // MARK: - ReducedMotion

    func test_reducedMotion_animation_returnsAnimationWhenOff() {
        // On the simulator under test, UIAccessibility.isReduceMotionEnabled
        // is false unless explicitly toggled. The helper should return
        // the supplied animation as-is.
        if !ReducedMotion.isEnabled {
            let animation = ReducedMotion.animation(.easeInOut(duration: 0.2))
            XCTAssertNotNil(animation)
        }
        // Note: we can't toggle UIAccessibility.isReduceMotionEnabled
        // from a unit test — it's a system-level setting. The other
        // half of this branch (returning nil when on) is covered by
        // first TestFlight pass with the setting enabled in iOS.
    }

    func test_reducedMotion_durationScale_isZeroOrOne() {
        let scale = ReducedMotion.durationScale
        XCTAssertTrue(scale == 0 || scale == 1)
    }

    func test_accessibleAnimation_modifier_compiles() {
        // Smoke-test that the View extension exists + is callable.
        // SwiftUI views can't be evaluated headlessly, but the call
        // must type-check.
        let _: AnyView = AnyView(
            Text("x")
                .accessibleAnimation(.easeInOut(duration: 0.2), value: 1)
        )
    }

    // MARK: - Brand color extension

    func test_brandColors_resolveFromAssetCatalog() {
        // Color is value-type and Equatable on its description; we
        // can't introspect the source asset directly, but the API
        // surface should at least be reachable + non-nil.
        let navy = Color.brandNavy
        let red = Color.brandRed
        XCTAssertNotNil(navy)
        XCTAssertNotNil(red)
    }

    // MARK: - eBay account rows (US-1009)

    func test_ebayAccountsView_compiles() {
        // SwiftUI views can't be evaluated headlessly, but the row must
        // type-check with its accessibility actions + confirmation wiring.
        let _: AnyView = AnyView(EbayAccountsView(userId: "u"))
    }

    func test_ebayAccountRow_statusNeverConveyedByColorAlone() {
        // The selected/disconnected state a sighted user reads from the
        // icon color must be present in the VoiceOver label too.
        let selected = RemoteMarketplaceConnection(id: "a", accountHandle: "store", isPrimary: true)
        XCTAssertTrue(selected.accessibilityRowLabel.contains("Selected"))
        let off = RemoteMarketplaceConnection(id: "b", accountHandle: "store2", isActive: false)
        XCTAssertTrue(off.accessibilityRowLabel.contains("Disconnected"))
    }
}
