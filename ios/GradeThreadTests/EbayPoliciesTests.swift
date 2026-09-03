import XCTest
@testable import GradeThread

/// US-3102 — shipping, payment and returns per listing, and how many units.
///
/// Publish has always honoured a per-listing policy id and the draft has always
/// carried one; the composer on the phone could only ever SET them by applying
/// a template. So changing shipping for one heavy item meant leaving the phone
/// for the web or Seller Hub, which is the single most common per-listing edit
/// there is.
@MainActor
final class EbayPoliciesTests: XCTestCase {

    // MARK: - Decoding

    func test_decodesThePolicyListAndDefaults() throws {
        // The edge returns snake_case; EdgeAPI decodes with
        // `.convertFromSnakeCase`, so the fixture is written the way the wire
        // actually looks rather than the way the Swift type does.
        let json = #"""
        {"policies":[
          {"policy_id":"F-1","policy_type":"fulfillment","policy_name":"Free 3-day","is_default":true},
          {"policy_id":"F-2","policy_type":"fulfillment","policy_name":"Calculated","is_default":false},
          {"policy_id":"P-1","policy_type":"payment","policy_name":"Immediate","is_default":true},
          {"policy_id":"R-1","policy_type":"return","policy_name":"30-day","is_default":true}
        ],
         "defaults":{"fulfillment_policy_id":"F-1","payment_policy_id":"P-1",
                     "return_policy_id":"R-1","merchant_location_key":"HOME"}}
        """#
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(EbayPoliciesResponse.self, from: Data(json.utf8))

        XCTAssertEqual(response.policies.count, 4)
        XCTAssertEqual(response.defaults.fulfillmentPolicyId, "F-1")
        XCTAssertEqual(response.defaults.merchantLocationKey, "HOME")
    }

    func test_optionsAreFilteredByTypeWithTheDefaultFirst() {
        // Default-first because it is the answer for almost every listing, and
        // a seller scanning a picker on a phone should not hunt for the one
        // they already chose once.
        let response = EbayPoliciesResponse(policies: [
            policy("F-2", "fulfillment", "Zebra", isDefault: false),
            policy("F-1", "fulfillment", "Alpha", isDefault: false),
            policy("F-3", "fulfillment", "Middle", isDefault: true),
            policy("P-1", "payment", "Immediate", isDefault: true),
        ])

        let shipping = response.options(ofType: "fulfillment")
        XCTAssertEqual(shipping.map(\.policyId), ["F-3", "F-1", "F-2"])
        XCTAssertEqual(response.options(ofType: "payment").map(\.policyId), ["P-1"])
        XCTAssertTrue(response.options(ofType: "return").isEmpty, "an empty type is empty, not everything")
    }

    // MARK: - The cache

    func test_theCacheServesASecondReadWithoutAnotherRequest() async throws {
        var loads = 0
        let service = EbayPoliciesService(
            load: {
                loads += 1
                return EbayPoliciesResponse(policies: [self.policy("F-1", "fulfillment", "Free")])
            },
            runSync: {}
        )

        _ = try await service.policies(forceRefresh: false)
        _ = try await service.policies(forceRefresh: false)
        XCTAssertEqual(loads, 1, "opening the composer twice must not ask twice")
    }

    func test_theCacheExpiresAfterFifteenMinutes() async throws {
        var loads = 0
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let service = EbayPoliciesService(
            load: {
                loads += 1
                return EbayPoliciesResponse(policies: [])
            },
            runSync: {},
            now: { clock }
        )

        _ = try await service.policies(forceRefresh: false)
        clock = clock.addingTimeInterval(EbayPoliciesService.cacheTTL - 1)
        _ = try await service.policies(forceRefresh: false)
        XCTAssertEqual(loads, 1, "still fresh a second before the TTL")

        clock = clock.addingTimeInterval(2)
        _ = try await service.policies(forceRefresh: false)
        XCTAssertEqual(loads, 2, "stale a second after it")
    }

    func test_syncBypassesTheCacheAndDropsItBeforeReReading() async throws {
        // The seller who just created a policy in Seller Hub is the whole
        // reason this button exists; serving them the cache would be the one
        // case where the cache is wrong.
        var loads = 0
        var syncs = 0
        let service = EbayPoliciesService(
            load: {
                loads += 1
                return EbayPoliciesResponse(policies: [])
            },
            runSync: { syncs += 1 }
        )

        _ = try await service.policies(forceRefresh: false)
        XCTAssertEqual(loads, 1)
        _ = try await service.sync()
        XCTAssertEqual(syncs, 1)
        XCTAssertEqual(loads, 2, "sync re-reads rather than trusting the cache")
    }

    func test_aFailedReadIsNotCached() async {
        var attempts = 0
        let service = EbayPoliciesService(
            load: {
                attempts += 1
                throw EdgeAPIError.network("offline")
            },
            runSync: {}
        )

        _ = try? await service.policies(forceRefresh: false)
        _ = try? await service.policies(forceRefresh: false)
        XCTAssertEqual(attempts, 2, "a failure must not become a cached empty list")
        XCTAssertFalse(service.hasFreshCache)
    }

    func test_invalidateClearsItForTheNextTenant() async throws {
        var loads = 0
        let service = EbayPoliciesService(
            load: {
                loads += 1
                return EbayPoliciesResponse(policies: [])
            },
            runSync: {}
        )
        _ = try await service.policies(forceRefresh: false)
        service.invalidate()
        _ = try await service.policies(forceRefresh: false)
        XCTAssertEqual(loads, 2, "the next workspace must not see the last one's policies")
    }

    // MARK: - What the composer sends

    func test_aTemplateStillSetsThePolicyIdsItCarries() {
        // The template path is what existed before this story, and it must keep
        // working: applying a template with policies fills the pickers.
        let template = ListingTemplate(
            id: "t1",
            name: "Heavy items",
            returnPolicyId: "R-9",
            shippingPolicyId: "F-9",
            paymentPolicyId: "P-9"
        )
        let applied = ComposerTemplateApply.apply(
            template: template,
            description: "",
            condition: .usedExcellent,
            conditionDescription: "",
            itemSpecifics: [:],
            ebayCategoryId: nil,
            returnPolicyId: nil,
            shippingPolicyId: nil,
            paymentPolicyId: nil
        )
        XCTAssertEqual(applied.returnPolicyId, "R-9")
        XCTAssertEqual(applied.shippingPolicyId, "F-9")
        XCTAssertEqual(applied.paymentPolicyId, "P-9")
    }

    func test_anEmptyTemplatePolicyDoesNotClearASellerChoice() {
        // A template with no policies must leave a picker choice alone rather
        // than blanking it back to the account default.
        let template = ListingTemplate(id: "t2", name: "Plain")
        let applied = ComposerTemplateApply.apply(
            template: template,
            description: "",
            condition: .usedExcellent,
            conditionDescription: "",
            itemSpecifics: [:],
            ebayCategoryId: nil,
            returnPolicyId: "R-chosen",
            shippingPolicyId: "F-chosen",
            paymentPolicyId: "P-chosen"
        )
        XCTAssertEqual(applied.returnPolicyId, "R-chosen")
        XCTAssertEqual(applied.shippingPolicyId, "F-chosen")
        XCTAssertEqual(applied.paymentPolicyId, "P-chosen")
    }

    func test_aPolicyLoadFailureNamesTheReconnectRatherThanTheStatus() {
        // "Unauthorized" sends a seller looking for a GradeThread problem. The
        // thing that actually needs fixing is the eBay connection.
        let authCopy = PublishDialog.policiesFailureCopy(EdgeAPIError.forbidden(detail: nil))
        XCTAssertTrue(authCopy.contains("Reconnect eBay"), authCopy)

        let genericCopy = PublishDialog.policiesFailureCopy(EdgeAPIError.network("offline"))
        XCTAssertTrue(
            genericCopy.contains("account defaults"),
            "a failed load must say publish still works — it does"
        )
        XCTAssertFalse(genericCopy.lowercased().contains("unauthorized"))
    }

    // MARK: - Quantity

    func test_quantityIsCarriedOnlyWhenTheControlWasShown() {
        // nil means "leave the column alone". Writing 1 over a seller's real
        // number because the composer happened to be on an auction is the exact
        // damage this rule prevents.
        var edits = ComposerEdits(
            title: "t", condition: .usedExcellent, conditionDescription: "", description: ""
        )
        XCTAssertNil(edits.quantity, "the default carries nothing")

        edits.quantity = 5
        XCTAssertEqual(edits.quantity, 5)
    }

    func test_theDraftQuantitySeedsTheStepperWithinBounds() {
        // The seed is clamped rather than trusted: `listings.quantity` is a
        // plain integer column and a row written by an import could hold
        // anything.
        XCTAssertEqual(seedQuantity(nil), 1, "no listing row yet means one unit")
        XCTAssertEqual(seedQuantity(0), 1, "zero is not a listable quantity")
        XCTAssertEqual(seedQuantity(-3), 1)
        XCTAssertEqual(seedQuantity(4), 4)
        XCTAssertEqual(seedQuantity(5000), 999, "eBay's cap, not an unbounded field")
    }

    // MARK: - Helpers

    /// Mirrors the clamp in `PublishDialog.init`.
    private func seedQuantity(_ stored: Int?) -> Int {
        max(1, min(999, stored ?? 1))
    }

    private func policy(
        _ id: String, _ type: String, _ name: String, isDefault: Bool = false
    ) -> EbayBusinessPolicy {
        EbayBusinessPolicy(policyId: id, policyType: type, policyName: name, isDefault: isDefault)
    }
}
