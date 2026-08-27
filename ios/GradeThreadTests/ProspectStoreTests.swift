import UIKit
import XCTest
@testable import GradeThread

/// US-1224 — coverage for the US-1170 / US-1225 Prospect logic that lives on the
/// CLIENT (the buy/skip ROI verdict itself is computed server-side and only
/// decoded, so it isn't re-asserted here). The two testable, deterministic
/// pieces are:
///   • `costNeedsRerun` — detects when the cost typed/changed after a run no
///     longer matches the cost the (server-computed) verdict was run with, so
///     the view can prompt a re-run.
///   • the AI-read "prospect notes" folded into the inventory item on commit
///     (keywords + resolved category), verified through the buy request the
///     store hands to the service.
///
/// `ProspectStore` is `@MainActor`; the fake `Prospecting` service keeps this
/// fully headless (no network, no Vision, no Speech).
@MainActor
final class ProspectStoreTests: XCTestCase {

    // MARK: - Fake service

    private final class FakeProspecting: Prospecting {
        var prospectResult: ProspectResponse?
        /// When set, the next `prospect` call throws instead of returning.
        var prospectError: Error?
        var buyResult: ProspectBuyResponse = .init(id: "item-1", status: "sourced")
        /// Captures the request `addToInventory()` builds so we can assert the
        /// notes / target / grade it folded in.
        private(set) var capturedBuy: ProspectBuyRequest?
        /// US-2923: every prospect request in order, so a test can assert the
        /// roles that were sent and what a re-pull carried across.
        private(set) var captured: [ProspectRequest] = []
        var last: ProspectRequest? { captured.last }
        /// US-1861: the Thrift Radar coordinate the store sent, if any. Read off
        /// the request rather than stored separately, so it cannot disagree with
        /// what actually went over the wire. `didProspect` distinguishes "no fix
        /// sent" from "never called".
        var capturedFix: RadarFix? {
            guard let lat = last?.lat, let lng = last?.lng else { return nil }
            return RadarFix(latitude: lat, longitude: lng)
        }
        var didProspect: Bool { !captured.isEmpty }

        func prospect(_ request: ProspectRequest) async throws -> ProspectResponse {
            captured.append(request)
            if let prospectError { throw prospectError }
            guard let prospectResult else { throw EdgeAPIError.network("no fixture") }
            return prospectResult
        }

        func buy(_ request: ProspectBuyRequest) async throws -> ProspectBuyResponse {
            capturedBuy = request
            return buyResult
        }
    }

    // MARK: - Fixtures

    private func item(brand: String? = "Patagonia",
                      title: String? = "Patagonia Synchilla Fleece",
                      keywords: [String] = ["fleece", "synchilla"],
                      identitySource: String? = "tag",
                      identityIsAuthoritative: Bool? = false) -> ProspectItem {
        ProspectItem(brand: brand, title: title, keywords: keywords, identifyConfidence: 0.9,
                     identitySource: identitySource,
                     identityIsAuthoritative: identityIsAuthoritative)
    }

    private func response(identified: Bool = true,
                          item: ProspectItem? = nil,
                          category: ProspectCategory? = ProspectCategory(id: "57988", path: "Men > Coats & Jackets"),
                          medianCents: Int? = 4200,
                          gradeValue: Double? = 8.0,
                          costCents: Int?) -> ProspectResponse {
        let stats = medianCents.map {
            ProspectStats(count: 12, lowCents: 3000, medianCents: $0, highCents: 6000,
                          currency: "USD", confidence: 0.8, sufficient: true)
        }
        let grade = gradeValue.map { ProspectGrade(value: $0, tier: "excellent", confidence: 0.8) }
        return ProspectResponse(
            identified: identified,
            item: item ?? self.item(),
            category: category,
            grade: grade,
            stats: stats,
            sellThrough: nil,
            costCents: costCents,
            decision: nil,
            ebaySoldSearchUrl: nil,
            source: "active",
            disclaimer: nil,
            note: nil
        )
    }

    // MARK: - costNeedsRerun

    func test_costNeedsRerun_falseWhenNoResultYet() {
        let store = ProspectStore(service: FakeProspecting())
        store.costText = "20"
        XCTAssertFalse(store.costNeedsRerun, "No result → nothing to re-run.")
    }

    func test_costNeedsRerun_falseWhenCostMatchesRun() {
        let store = ProspectStore(service: FakeProspecting())
        // Verdict was run at $20.00 (2000 cents) and the field still says 20.
        store.result = response(costCents: 2000)
        store.costText = "20"
        XCTAssertFalse(store.costNeedsRerun)
    }

    func test_costNeedsRerun_trueWhenCostChangedAfterRun() {
        let store = ProspectStore(service: FakeProspecting())
        store.result = response(costCents: 2000)   // ran at $20
        store.costText = "35"                       // user bumped it to $35
        XCTAssertTrue(store.costNeedsRerun)
    }

    func test_costNeedsRerun_trueWhenCostAddedAfterCostlessRun() {
        let store = ProspectStore(service: FakeProspecting())
        store.result = response(costCents: nil)     // ran with no cost → no verdict
        store.costText = "15"                        // now a cost is entered
        XCTAssertTrue(store.costNeedsRerun)
    }

    func test_costNeedsRerun_handlesCurrencyFormatting() {
        let store = ProspectStore(service: FakeProspecting())
        store.result = response(costCents: 1234)    // $12.34
        store.costText = "$12.34"                    // formatted, with symbol
        XCTAssertFalse(store.costNeedsRerun, "$ and matching value → no re-run needed.")
    }

    // MARK: - addToInventory notes / prefill (US-1170)

    func test_addToInventory_foldsKeywordsAndCategoryIntoNotes() async {
        let fake = FakeProspecting()
        let store = ProspectStore(service: fake)
        store.result = response(
            item: item(keywords: ["fleece", "synchilla", "vintage"]),
            category: ProspectCategory(id: "57988", path: "Men > Coats & Jackets"),
            costCents: 2000
        )
        store.costText = "20"

        await store.addToInventory()

        let req = try? XCTUnwrap(fake.capturedBuy)
        XCTAssertEqual(req?.title, "Patagonia Synchilla Fleece")
        XCTAssertEqual(req?.brand, "Patagonia")
        XCTAssertEqual(req?.costCents, 2000)
        XCTAssertEqual(req?.targetCents, 4200, "target prefilled from median comp")
        XCTAssertEqual(req?.gradeValue, 8.0)
        XCTAssertEqual(req?.gradeLabel, "excellent")
        XCTAssertEqual(req?.conditionNotes, "fleece, synchilla, vintage · Category: Men > Coats & Jackets")
        XCTAssertEqual(store.addedItemId, "item-1")
        XCTAssertNil(store.addError)
    }

    func test_addToInventory_nilNotesWhenNothingToRecord() async {
        let fake = FakeProspecting()
        let store = ProspectStore(service: fake)
        store.result = response(
            item: item(keywords: []),
            category: nil,
            costCents: nil
        )

        await store.addToInventory()

        let req = try? XCTUnwrap(fake.capturedBuy)
        XCTAssertNil(req?.conditionNotes, "No keywords + no category → no notes string.")
    }

    // MARK: - Thrift Radar contribution consent (US-1861)

    /// A UserDefaults suite of its own so the real preference is untouched and
    /// the "never set" case is genuinely never set.
    private func freshConsent(_ name: String = #function) -> RadarConsent {
        let defaults = UserDefaults(suiteName: "radar-consent-\(name)")!
        defaults.removePersistentDomain(forName: "radar-consent-\(name)")
        return RadarConsent(defaults: defaults)
    }

    func test_radarConsent_defaultsOff() {
        // The whole feature rests on this being false on a device that has never
        // been told otherwise. If a future refactor gives it a `?? true`, this is
        // the test that should go red.
        XCTAssertFalse(freshConsent().isContributing)
    }

    func test_radarFix_isNilWhileContributionIsOff() async {
        let store = ProspectStore(
            service: FakeProspecting(),
            radarConsent: freshConsent(),
            radarLocation: RadarLocationProvider()
        )
        // Consent is checked BEFORE the provider, so this returns without ever
        // asking CoreLocation — which is what "consent before collection" means
        // here: not collecting, rather than collecting and discarding.
        let fix = await store.radarFix()
        XCTAssertNil(fix, "An opted-out scan must contribute nothing.")
    }

    func test_addToInventory_rejectsUnidentifiedResult() async {
        let fake = FakeProspecting()
        let store = ProspectStore(service: fake)
        store.result = response(identified: false, costCents: nil)

        await store.addToInventory()

        XCTAssertNil(fake.capturedBuy, "Nothing to buy when the item wasn't identified.")
        XCTAssertNotNil(store.addError)
        XCTAssertNil(store.addedItemId)
    }

    // MARK: - US-2923: photo roles
    //
    // The role is the ONLY thing the server uses to decide whether it reads the
    // tag or runs eBay visual search, so these assert what actually goes over
    // the wire. Before US-2923 the app sent no roles at all, which meant the
    // server's `no-usable-role` branch fired on every scan and visual search was
    // unreachable from the phone however the flag was set.

    private func pixel() -> UIImage {
        UIGraphicsBeginImageContextWithOptions(CGSize(width: 8, height: 8), true, 1)
        UIColor.gray.setFill()
        UIRectFill(CGRect(x: 0, y: 0, width: 8, height: 8))
        let img = UIGraphicsGetImageFromCurrentImageContext()!
        UIGraphicsEndImageContext()
        return img
    }

    func test_run_sendsFrontRoleForAnItemOnlyScan() async {
        let fake = FakeProspecting()
        fake.prospectResult = response(costCents: nil)
        let store = ProspectStore(service: fake)
        store.setImage(pixel(), for: .front)

        await store.run()

        XCTAssertEqual(fake.last?.imageRoles, ["front"])
        XCTAssertEqual(fake.last?.images.count, 1)
    }

    func test_run_labelsATagOnlyScanAsTagNeverAsFront() async {
        let fake = FakeProspecting()
        fake.prospectResult = response(costCents: nil)
        let store = ProspectStore(service: fake)
        store.setImage(pixel(), for: .tag)

        await store.run()

        XCTAssertEqual(
            fake.last?.imageRoles, ["tag"],
            "A lone tag photo must not be labelled `front`. US-2758 measured a " +
            "care label returning a midi dress, joggers and a mini skirt when " +
            "sent to visual search as though it were a garment."
        )
    }

    func test_run_sendsBothRolesInFrontThenTagOrder() async {
        let fake = FakeProspecting()
        fake.prospectResult = response(costCents: nil)
        let store = ProspectStore(service: fake)
        store.setImage(pixel(), for: .tag)
        store.setImage(pixel(), for: .front)

        await store.run()

        XCTAssertEqual(
            fake.last?.imageRoles, ["front", "tag"],
            "Order is role order, not the order they were added: /prospect " +
            "documents its FIRST image as the front and grades from it."
        )
    }

    func test_run_rolesStayParallelToImages() async {
        let fake = FakeProspecting()
        fake.prospectResult = response(costCents: nil)
        let store = ProspectStore(service: fake)
        store.setImage(pixel(), for: .front)
        store.setImage(pixel(), for: .tag)

        await store.run()

        XCTAssertEqual(
            fake.last?.images.count, fake.last?.imageRoles.count,
            "The server reads roles POSITIONALLY. A mismatch silently mislabels " +
            "every photo after the gap."
        )
    }

    func test_run_sendsNoOverrideOnAnOrdinaryScan() async {
        let fake = FakeProspecting()
        fake.prospectResult = response(costCents: nil)
        let store = ProspectStore(service: fake)
        store.setImage(pixel(), for: .front)

        await store.run()

        XCTAssertNil(fake.last?.titleOverride, "An ordinary scan is not a re-pull.")
    }

    // MARK: - US-2923: correcting the title

    func test_canRepull_falseUntilTheTitleActuallyChanges() {
        let store = ProspectStore(service: FakeProspecting())
        store.result = response(costCents: nil)
        store.beginTitleEdit()

        XCTAssertEqual(store.titleDraft, "Patagonia Synchilla Fleece")
        XCTAssertFalse(
            store.canRepull,
            "Re-pulling the title the server already returned spends a comp pull " +
            "to be told the same thing."
        )
    }

    func test_canRepull_falseOnABlankDraft() {
        let store = ProspectStore(service: FakeProspecting())
        store.result = response(costCents: nil)
        store.titleDraft = "   "
        XCTAssertFalse(store.canRepull)
    }

    func test_canRepull_falseWhenNothingWasIdentified() {
        let store = ProspectStore(service: FakeProspecting())
        store.result = response(identified: false, costCents: nil)
        store.titleDraft = "Lululemon ABC Pant"
        XCTAssertFalse(store.canRepull, "There is no identification to correct.")
    }

    func test_canRepull_trueOnARealCorrection() {
        let store = ProspectStore(service: FakeProspecting())
        store.result = response(costCents: nil)
        store.titleDraft = "Lululemon ABC Pant 32"
        XCTAssertTrue(store.canRepull)
    }

    func test_repull_sendsTheCorrectionWithNoPhotosAndCarriesTheGrade() async {
        let fake = FakeProspecting()
        fake.prospectResult = response(
            item: item(title: "Lululemon ABC Pant 32", identitySource: "seller",
                       identityIsAuthoritative: true),
            costCents: 1500
        )
        let store = ProspectStore(service: fake)
        store.result = response(gradeValue: 7.5, costCents: 1500)
        store.costText = "15"
        store.titleDraft = "Lululemon ABC Pant 32"

        await store.repull()

        let sent = fake.last
        XCTAssertEqual(sent?.titleOverride, "Lululemon ABC Pant 32")
        XCTAssertTrue(sent?.images.isEmpty == true, "A re-pull sends no photos.")
        XCTAssertTrue(sent?.imageRoles.isEmpty == true)
        XCTAssertEqual(sent?.gradeValue, 7.5, "The grade is carried across, not recomputed.")
        XCTAssertEqual(sent?.gradeTier, "excellent")
        XCTAssertEqual(sent?.costCents, 1500)
        XCTAssertNil(
            sent?.lat,
            "A re-pull corrects a scan already recorded; sending a coordinate " +
            "would ask to double-count one garment in the shared Radar map."
        )
        XCTAssertNil(
            sent?.brandOverride,
            "The old brand came from the identification being corrected. Pinning " +
            "it would let a wrong brand survive the fix and keep pricing the " +
            "item against the wrong comps."
        )
    }

    func test_repull_replacesTheResultAndClosesTheEditor() async {
        let fake = FakeProspecting()
        fake.prospectResult = response(item: item(title: "Lululemon ABC Pant 32"), costCents: nil)
        let store = ProspectStore(service: fake)
        store.result = response(costCents: nil)
        store.titleDraft = "Lululemon ABC Pant 32"

        await store.repull()

        XCTAssertEqual(store.result?.item.title, "Lululemon ABC Pant 32")
        XCTAssertNil(store.titleDraft, "A successful correction closes the field.")
        XCTAssertFalse(store.isRepulling)
    }

    func test_repull_keepsThePreviousNumbersOnFailure() async {
        let fake = FakeProspecting()
        fake.prospectError = EdgeAPIError.network("offline")
        let store = ProspectStore(service: fake)
        store.result = response(medianCents: 4200, costCents: nil)
        store.titleDraft = "Lululemon ABC Pant 32"

        await store.repull()

        XCTAssertEqual(
            store.result?.stats?.medianCents, 4200,
            "A failed correction must not blank the card. The seller is standing " +
            "in a shop with numbers they already had."
        )
        XCTAssertNotNil(store.errorMessage)
        XCTAssertEqual(store.titleDraft, "Lululemon ABC Pant 32", "Their typing survives a retry.")
    }

    func test_repull_appliesACostEditedAfterTheScan() async {
        let fake = FakeProspecting()
        fake.prospectResult = response(costCents: 3500)
        let store = ProspectStore(service: fake)
        store.result = response(costCents: 2000)   // scanned at $20
        store.costText = "35"                       // then bumped to $35
        store.titleDraft = "Lululemon ABC Pant 32"

        await store.repull()

        XCTAssertEqual(
            fake.last?.costCents, 3500,
            "A re-pull recomputes the verdict server-side anyway, so it is the " +
            "cheapest moment to apply a cost the seller edited after the scan."
        )
        XCTAssertFalse(store.costNeedsRerun)
    }

    // MARK: - US-2923: a new photo invalidates a correction

    func test_changingAPhotoDiscardsTheCorrectedTitle() {
        let store = ProspectStore(service: FakeProspecting())
        store.result = response(costCents: nil)
        store.titleDraft = "Lululemon ABC Pant 32"

        store.setImage(pixel(), for: .front)

        XCTAssertNil(store.result, "A new photo invalidates the old result.")
        XCTAssertNil(
            store.titleDraft,
            "And the title corrected for a garment that is no longer on screen."
        )
    }

    // MARK: - US-2923: provenance the card reads

    func test_visualMatchIsFlaggedAsWorthChecking() {
        let guess = item(identitySource: "visual", identityIsAuthoritative: false)
        XCTAssertTrue(guess.isUnverifiedGuess)
        XCTAssertEqual(guess.sourceLabel, "Matched on looks")
    }

    func test_aTagReadAndTheSellersOwnTitleAreNotFlagged() {
        XCTAssertFalse(item(identitySource: "tag").isUnverifiedGuess)
        XCTAssertFalse(
            item(identitySource: "seller", identityIsAuthoritative: true).isUnverifiedGuess
        )
        XCTAssertEqual(item(identitySource: "seller").sourceLabel, "You set this title")
    }

    func test_anUnknownOrAbsentSourceMakesNoClaim() {
        XCTAssertNil(item(identitySource: nil).sourceLabel)
        XCTAssertNil(item(identitySource: "something-new").sourceLabel)
        XCTAssertFalse(item(identitySource: nil).isUnverifiedGuess)
    }
}
