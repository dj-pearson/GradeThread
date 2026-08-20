import Foundation

/// US-2016 — paying for a consumer grade on iOS.
///
/// NO CARD IS INVOLVED, which is the finding that shrank this story from "build
/// a payment surface" to "call one endpoint". `POST /api/grade/pay/:id` charges
/// through the precedence chain: the seller's INCLUDED monthly grades first,
/// then their credit BALANCE. Stripe only ever enters on the web, for buying
/// credits.
///
/// When neither covers it the route answers `checkoutRequired: true` and names
/// the credit pack that would - and iOS already sells exactly those packs
/// through StoreKit. So the App Store commission question this story flagged as
/// open never arises: credits are a consumable IAP, which is the compliant
/// shape, and they were built before this.
enum PhotoGradePayment {
    /// Mirrors `PrecedenceResult` in services/edge-functions/src/lib/grade-precedence.ts.
    ///
    /// PAID AND UNPAID ARE DIFFERENT SCREENS, not a success and an error. An
    /// unpaid answer is the normal path for anyone out of included grades, and
    /// treating it as a failure would show a red banner to a customer who is
    /// about to buy something.
    enum Outcome: Equatable {
        /// A monthly included grade covered it. `used` is the new count.
        case paidFromIncluded(used: Int)
        /// A credit was spent. `balance` is what is left.
        case paidFromCredits(balance: Int)
        /// Neither covered it. The route names the smallest pack that would.
        case needsCredits(offer: PackOffer?)
    }

    /// The pack the route suggests. Optional because the route can answer
    /// `suggestedPack: null` - there is no pack list configured, or none large
    /// enough - and a client that assumed one would crash on the honest reply.
    struct PackOffer: Equatable {
        let credits: Int
        let priceCents: Int

        /// The StoreKit product for this pack.
        ///
        /// ⚠ TWO LISTS THAT MUST AGREE. The server's packs (CREDIT_PACKS in
        /// grade-pricing.ts, overridable from admin via pricing_config) and the
        /// App Store product ids in ``IAPProduct`` are maintained separately.
        /// A size the store does not sell resolves to nil here, which the UI
        /// must render as "buy credits" pointing at the paywall rather than as
        /// a broken purchase button.
        var storeKitProductId: String? {
            let known = [10, 25, 50, 100]
            guard known.contains(credits) else { return nil }
            return "com.gradethread.credits.\(credits)"
        }
    }
}

/// The `POST /api/grade/pay/:id` reply.
struct PhotoGradePayResponse: Decodable {
    let submissionId: String?
    let status: String?
    let payment: Payment?

    struct Payment: Decodable {
        let paid: Bool?
        /// "included" or "credits" on a paid reply; absent otherwise.
        let method: String?
        let newIncludedUsed: Int?
        let newBalance: Int?
        let checkoutRequired: Bool?
        let suggestedPack: Pack?

        struct Pack: Decodable {
            let credits: Int?
            let priceCents: Int?
        }
    }

    /// Reads the reply into the outcome the UI branches on.
    ///
    /// Keyed on `method` rather than on which count is present: both counts are
    /// optional in the wire shape, so "whichever field arrived" would silently
    /// pick the wrong branch the day the route adds a field.
    func outcome() -> PhotoGradePayment.Outcome {
        if payment?.paid == true {
            switch payment?.method {
            case "included":
                return .paidFromIncluded(used: payment?.newIncludedUsed ?? 0)
            default:
                return .paidFromCredits(balance: payment?.newBalance ?? 0)
            }
        }
        guard let pack = payment?.suggestedPack,
              let credits = pack.credits,
              let priceCents = pack.priceCents
        else {
            return .needsCredits(offer: nil)
        }
        return .needsCredits(
            offer: PhotoGradePayment.PackOffer(credits: credits, priceCents: priceCents)
        )
    }
}
