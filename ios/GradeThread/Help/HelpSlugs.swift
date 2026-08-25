import Foundation

/// US-2874. The help articles the product points at, and where each one belongs.
///
/// Mirror of `PRODUCT_HELP_SLUGS` in `src/lib/help-slugs.ts`. There is still no
/// TypeScript-to-Swift generator in this repo -- US-2876 is building one, and
/// the owner's note on that story is explicit that a second one-off generator
/// is the thing to avoid. So this uses the guarantee the repo already relies on
/// for `BuyerEntitlements.swift`: a fenced table plus a Vitest parity test that
/// reads this file as text and fails on any drift. When US-2876's generator
/// lands, this file becomes its output rather than being rewritten.
///
/// Two checks stand behind it:
///   `src/test/ios-help-slugs-parity.test.ts`  slug, category and surface must
///       match the TypeScript registry exactly, in the same order.
///   `ios/Scripts/check-help-slugs.py`  every slug named in Swift UI code must
///       exist here, so a typo cannot ship as a sheet that opens on nothing.
enum HelpSlug: String, CaseIterable {
    // BEGIN GENERATED TABLE (parity-tested against src/lib/help-slugs.ts)
    case yourFirstGrade = "your-first-grade"
    case readingYourGradeReport = "reading-your-grade-report"
    case theFlipdeskPipeline = "the-flipdesk-pipeline"
    case writingAListingInTheComposer = "writing-a-listing-in-the-composer"
    case connectingAMarketplace = "connecting-a-marketplace"
    case reconcilingPayouts = "reconciling-payouts"
    case plansCreditsAndBilling = "plans-credits-and-billing"
    case apiKeysAndTheSandbox = "api-keys-and-the-sandbox"
    case invitingYourTeam = "inviting-your-team"
    case installingTheBrowserExtension = "installing-the-browser-extension"
    case addingYourFirstItem = "adding-your-first-item"
    case theFourInventoryViews = "the-four-inventory-views"
    case batchListingWithAutolister = "batch-listing-with-autolister"
    case decidingWhatToBuy = "deciding-what-to-buy"
    case pricingYourListings = "pricing-your-listings"
    case readingYourMoney = "reading-your-money"
    case offersAndBuyerMessages = "offers-and-buyer-messages"
    case returnsAndDisputes = "returns-and-disputes"
    case schedulingADrop = "scheduling-a-drop"
    case becomingAVerifiedSeller = "becoming-a-verified-seller"
    case takingInConsignment = "taking-in-consignment"
    case importingYourInventory = "importing-your-inventory"
    case snapToValue = "snap-to-value"
    case usingTheMeasurecard = "using-the-measurecard"
    case rewardsAndCredit = "rewards-and-credit"
    // END GENERATED TABLE
}
