import XCTest
@testable import GradeThread

/// US-3104 — the buyer preview, at parity with the web composer's.
///
/// Two things are worth a test and neither is about pixels.
///
/// 1. **Which branch the description takes.** The web decides on a MARKER, not
///    on whether the string looks like markup, and getting that wrong is a
///    two-sided failure: sniff for angle brackets and a seller who typed
///    "<3 this jacket" gets a broken tag; miss the marker and the Verified
///    Seller block renders as visible HTML source in a buyer-facing preview.
/// 2. **The section order.** The whole story is parity with
///    `src/components/flipdesk/ebay-view-item-preview.tsx`, and a preview whose
///    order drifts from the page it claims to preview is worse than none.
final class EbayPreviewTests: XCTestCase {

    // MARK: - Which branch the description takes

    func test_aDescriptionWithTheMarkerRendersAsHTML() {
        let description = """
        Great condition, worn twice.

        <!--gradethread-seller-credentials--><div class="gt">Verified Seller</div>
        """
        guard case let .html(body, credentials) = EbayPreviewModel.describe(description) else {
            return XCTFail("the credentials block must take the HTML branch")
        }
        XCTAssertEqual(body, "Great condition, worn twice.")
        XCTAssertEqual(credentials, "<div class=\"gt\">Verified Seller</div>")
    }

    func test_aPlainDescriptionStaysText() {
        guard case let .plain(text) = EbayPreviewModel.describe("  Worn twice. No flaws.  ") else {
            return XCTFail("no marker means no web view")
        }
        XCTAssertEqual(text, "Worn twice. No flaws.")
    }

    func test_angleBracketsAloneDoNotMakeItHTML() {
        // The seller wrote a sentence, not markup. Sniffing for "<" would
        // render "<3" as the start of a tag and eat the rest of the line.
        guard case .plain = EbayPreviewModel.describe("<3 this jacket, size runs small") else {
            return XCTFail("a typed angle bracket is not a credentials block")
        }
    }

    func test_anEmptyDescriptionHasNoSection() {
        XCTAssertEqual(EbayPreviewModel.describe(""), .empty)
        XCTAssertEqual(EbayPreviewModel.describe("   \n  "), .empty)
    }

    func test_aMarkerWithNothingAfterItFallsBackToText() {
        // A renderer that started the block and did not finish. The body is
        // still worth showing; an empty web view is not.
        let render = EbayPreviewModel.describe("Body copy.\n\n<!--gradethread-seller-credentials-->")
        XCTAssertEqual(render, .plain("Body copy."))
    }

    func test_theMarkerMatchesTheOneTheEdgeWrites() {
        // src/lib/listing-templates.ts SELLER_CREDENTIALS_MARKER, and the
        // open-only marker list in GradeThreadCore's DescriptionBlocks. A drift
        // here shows the raw block to a buyer-facing preview.
        XCTAssertEqual(
            EbayPreviewModel.sellerCredentialsMarker,
            "<!--gradethread-seller-credentials-->"
        )
    }

    // MARK: - What reaches the web view

    func test_theBodyIsEscapedAndTheBlockIsNot() {
        let html = EbayPreviewModel.htmlDocument(
            body: "5 < 6 & \"quoted\"",
            credentials: "<div class=\"gt\">Verified</div>",
            dark: false
        )
        XCTAssertTrue(html.contains("5 &lt; 6 &amp; &quot;quoted&quot;"))
        XCTAssertTrue(html.contains("<div class=\"gt\">Verified</div>"))
        XCTAssertFalse(
            html.contains("&lt;div class"),
            "the credentials block is markup we built and eBay renders it as markup"
        )
    }

    func test_escapingDoesTheAmpersandFirst() {
        // "&" last would turn "<" into "&amp;lt;" and print the escape.
        XCTAssertEqual(EbayPreviewModel.escapeHTML("a & b < c"), "a &amp; b &lt; c")
    }

    func test_anEmptyBodyLeavesNoStrayParagraph() {
        let html = EbayPreviewModel.htmlDocument(
            body: "",
            credentials: "<div>V</div>",
            dark: true
        )
        XCTAssertFalse(html.contains("<p class=\"body\"></p>"))
        XCTAssertTrue(html.contains("<div>V</div>"))
    }

    // MARK: - Section order

    func test_theSectionsAreInTheWebComponentsOrder() {
        // ebay-view-item-preview.tsx: hero + thumbs, then the buy box (title,
        // condition pill, price), then specifics, then description.
        //
        // The story's AC lists price before condition, which is the one place
        // its paraphrase differs from the component it asks for parity with.
        // Parity wins; see the note on EbayPreviewModel.Section.
        XCTAssertEqual(
            fixture().sections,
            [.gallery, .title, .condition, .price, .specifics, .description]
        )
    }

    func test_anEmptySpecificsTableDropsItsSection() {
        let model = fixture(specifics: [])
        XCTAssertFalse(model.sections.contains(.specifics))
        XCTAssertEqual(
            model.sections,
            [.gallery, .title, .condition, .price, .description],
            "the remaining sections keep their order"
        )
    }

    func test_anEmptyDescriptionDropsItsSection() {
        XCTAssertFalse(fixture(description: "").sections.contains(.description))
    }

    func test_galleryTitleConditionAndPriceAlwaysRender() {
        // Each is a thing that MUST be right before publishing, so an absent one
        // shows as absent rather than vanishing.
        let bare = fixture(title: "", specifics: [], description: "")
        XCTAssertEqual(bare.sections, [.gallery, .title, .condition, .price])
    }

    // MARK: - The specifics table

    func test_aspectsAndTemplateSpecificsMergeWithTheTemplateWinning() {
        let rows = EbayPreviewModel.specifics(
            aspects: ["Brand": ["Patagonia"], "Size": ["M"], "Color": ["Navy"]],
            templateSpecifics: ["Size": "Medium", "Department": "Men"]
        )
        XCTAssertEqual(rows.map(\.label), ["Brand", "Color", "Department", "Size"])
        XCTAssertEqual(
            rows.first { $0.label == "Size" }?.value,
            "Medium",
            "an applied template is the seller's own choice and is what publish sends"
        )
    }

    func test_multiValuedAspectsJoinAndEmptiesDrop() {
        let rows = EbayPreviewModel.specifics(
            aspects: ["Material": ["Cotton", "Polyester"], "Pattern": ["  "], "Fit": []],
            templateSpecifics: [:]
        )
        XCTAssertEqual(rows.map(\.label), ["Material"])
        XCTAssertEqual(rows.first?.value, "Cotton, Polyester")
    }

    func test_theTableOrderIsStable() {
        // A dictionary has no order. A specifics table that reshuffles between
        // opens reads as data that changed.
        let aspects = ["Size": ["M"], "Brand": ["Nike"], "Color": ["Red"]]
        let first = EbayPreviewModel.specifics(aspects: aspects, templateSpecifics: [:])
        let second = EbayPreviewModel.specifics(aspects: aspects, templateSpecifics: [:])
        XCTAssertEqual(first.map(\.label), second.map(\.label))
        XCTAssertEqual(first.map(\.label), ["Brand", "Color", "Size"])
    }

    // MARK: - Price and format

    func test_anUnsetPriceSaysSoRatherThanReadingZero() {
        XCTAssertEqual(EbayPreviewModel.priceLabel(nil, currency: "USD"), "Price not set")
        XCTAssertEqual(EbayPreviewModel.priceLabel(0, currency: "USD"), "Price not set")
    }

    func test_theUSPrefixIsOnlyForUSD() {
        XCTAssertTrue(EbayPreviewModel.priceLabel(4800, currency: "USD").hasPrefix("US "))
        XCTAssertFalse(
            EbayPreviewModel.priceLabel(4800, currency: "GBP").hasPrefix("US "),
            "prefixing US onto a sterling amount is a lie about which marketplace this lists on"
        )
    }

    func test_anAuctionNeverPromisesBestOffer() {
        // eBay refuses Best Offer on an auction and the publish path suppresses
        // it, so a preview that promised it would promise something the publish
        // is about to drop.
        let auction = ComposerFormatChoice(format: .auction)
        XCTAssertEqual(EbayPreviewModel.formatLabel(auction, bestOffer: true), "Auction")
    }

    func test_fixedPriceCarriesTheBestOfferSuffixWhenItIsOn() {
        let fixed = ComposerFormatChoice(format: .fixedPrice)
        XCTAssertEqual(EbayPreviewModel.formatLabel(fixed, bestOffer: false), "Buy It Now")
        XCTAssertEqual(
            EbayPreviewModel.formatLabel(fixed, bestOffer: true),
            "Buy It Now · Best offer"
        )
    }

    // MARK: - Fixture

    private func fixture(
        title: String = "Patagonia Better Sweater fleece jacket",
        specifics: [EbayPreviewModel.Specific] = [
            .init(label: "Brand", value: "Patagonia"),
            .init(label: "Size", value: "M"),
        ],
        description: String = "Worn twice, no flaws."
    ) -> EbayPreviewModel {
        EbayPreviewModel(
            title: title,
            priceLabel: EbayPreviewModel.priceLabel(4800, currency: "USD"),
            formatLabel: EbayPreviewModel.formatLabel(
                ComposerFormatChoice(format: .fixedPrice),
                bestOffer: false
            ),
            conditionLabel: EbayCondition.usedExcellent.label,
            conditionDescription: "Small mark on the left cuff.",
            specifics: specifics,
            description: EbayPreviewModel.describe(description),
            shippingPolicyName: "USPS Ground Advantage",
            returnPolicyName: "30 day returns"
        )
    }
}
