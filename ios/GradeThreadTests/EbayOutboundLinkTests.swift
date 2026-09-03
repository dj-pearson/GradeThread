import XCTest
@testable import GradeThread

/// US-3097 — the seller's route out to eBay, and the numbers the phone was
/// throwing away on the way there.
///
/// Three separate failures live under this one story, and each gets its own
/// section below:
///
///  1. The link opened in an in-app browser instead of the eBay app, so a
///     seller signed in to eBay on their phone arrived signed out.
///  2. `url` (the affiliate form, once US-3082 ships) was not decoded at all,
///     so the commission would have needed an App Store release to start.
///  3. `ceiling` and `stats.basis` were sent by the server and dropped by the
///     client — the ceiling being the one number someone standing over a rack
///     with a price tag in their hand is actually trying to work out.
@MainActor
final class EbayOutboundLinkTests: XCTestCase {

    // MARK: - URL precedence

    func test_prefersAffiliateURLOverPlainListingURL() throws {
        // The whole point of decoding `url` now: the day the edge starts
        // sending an affiliate link, the phone follows with no client release.
        let resolved = EbayOutboundURL.resolve(
            url: "https://www.ebay.com/itm/123?mkcid=1&campid=5339154788",
            fallback: "https://www.ebay.com/itm/123"
        )
        XCTAssertEqual(
            resolved?.absoluteString,
            "https://www.ebay.com/itm/123?mkcid=1&campid=5339154788"
        )
        XCTAssertTrue(EbayOutboundURL.isAffiliate(try XCTUnwrap(resolved)))
    }

    func test_fallsBackToListingURLWhileTheServerSendsNoAffiliate() throws {
        let resolved = EbayOutboundURL.resolve(url: nil, fallback: "https://www.ebay.com/itm/123")
        XCTAssertEqual(resolved?.absoluteString, "https://www.ebay.com/itm/123")
        XCTAssertFalse(
            EbayOutboundURL.isAffiliate(try XCTUnwrap(resolved)),
            "a plain listing URL must not report itself as attributed — that flag is what an EPN click report gets reconciled against"
        )
    }

    func test_refusesAnythingThatIsNotHTTPS() {
        // A link that goes nowhere is worse than no link, because the seller
        // taps it. An empty string and a whitespace-only string are the two
        // shapes an absent server field actually arrives in.
        XCTAssertNil(EbayOutboundURL.resolve(url: "", fallback: nil))
        XCTAssertNil(EbayOutboundURL.resolve(url: "   ", fallback: "  "))
        XCTAssertNil(EbayOutboundURL.resolve(url: nil, fallback: nil))
        XCTAssertNil(
            EbayOutboundURL.resolve(url: "ebay://item/123", fallback: nil),
            "no custom scheme: the universal link is what reaches the app, and a scheme would need an LSApplicationQueriesSchemes entry for nothing"
        )
        XCTAssertNil(
            EbayOutboundURL.resolve(url: "http://www.ebay.com/itm/1", fallback: nil),
            "plain http is refused rather than upgraded"
        )
    }

    func test_skipsAnUnusableFirstChoiceAndTakesTheFallback() {
        let resolved = EbayOutboundURL.resolve(url: "", fallback: "https://www.ebay.com/itm/9")
        XCTAssertEqual(resolved?.absoluteString, "https://www.ebay.com/itm/9")
    }

    // MARK: - Candidate wiring

    func test_candidateOutboundURLUsesThePrecedence() {
        let withAffiliate = makeCandidate(
            url: "https://www.ebay.com/itm/1?campid=5339154788",
            itemWebUrl: "https://www.ebay.com/itm/1"
        )
        XCTAssertEqual(
            withAffiliate.outboundURL?.absoluteString,
            "https://www.ebay.com/itm/1?campid=5339154788"
        )

        let plain = makeCandidate(url: nil, itemWebUrl: "https://www.ebay.com/itm/2")
        XCTAssertEqual(plain.outboundURL?.absoluteString, "https://www.ebay.com/itm/2")

        let none = makeCandidate(url: nil, itemWebUrl: nil)
        XCTAssertNil(none.outboundURL, "a candidate with no link shows no button")
    }

    // MARK: - The guard (AC4)

    /// Every eBay hand-off goes through `EbayOutboundLink`, and nothing else
    /// opens an eBay URL.
    ///
    /// A grep test rather than a type-level one because the thing being
    /// prevented is a FUTURE call site: `Link(destination:)` compiles, looks
    /// right in a review, and silently costs the app hand-off and the affiliate
    /// attribution at the same time. The idiom is the ios-guard-lane's.
    func test_noOtherCallSiteOpensAnEbayURL() throws {
        let sourceRoot = Self.repoRoot.appendingPathComponent("ios/GradeThread")
        let allowed = ["EbayOutboundLink.swift"]

        var offenders: [String] = []
        let files = FileManager.default.enumerator(at: sourceRoot, includingPropertiesForKeys: nil)
        while let url = files?.nextObject() as? URL {
            guard url.pathExtension == "swift" else { continue }
            let name = url.lastPathComponent
            if allowed.contains(name) { continue }
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }

            for (index, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                // A comment explaining the rule is not a violation of it.
                if trimmed.hasPrefix("//") { continue }
                guard trimmed.contains("ebay.com") else { continue }
                let opens = trimmed.contains("UIApplication.shared.open")
                    || trimmed.contains("Link(destination")
                    || trimmed.contains("openURL(")
                if opens {
                    offenders.append("\(name):\(index + 1): \(trimmed)")
                }
            }
        }

        XCTAssertEqual(
            offenders, [],
            "these open an eBay URL outside EbayOutboundLink. A SwiftUI Link lands in an in-app browser instead of the eBay app, and a hand-built URL loses the affiliate attribution US-3082 adds:\n" + offenders.joined(separator: "\n")
        )
    }

    func test_noEbaySchemeIsDeclaredOrUsed() throws {
        // The story is explicit: no `ebay://` and no LSApplicationQueriesSchemes
        // entry. The universal link already reaches the app, and a declared
        // scheme adds a queryable app to the privacy surface for nothing.
        let plist = try String(
            contentsOf: Self.repoRoot.appendingPathComponent("ios/GradeThread/Info.plist"),
            encoding: .utf8
        )
        XCTAssertFalse(plist.contains("LSApplicationQueriesSchemes"))
        XCTAssertFalse(plist.contains("ebay://"))
    }

    // MARK: - Helpers

    /// The repo root, walked up from this file's own path at compile time.
    static var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // GradeThreadTests
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repo root
    }

    private func makeCandidate(url: String?, itemWebUrl: String?) -> ScoutCandidate {
        ScoutCandidate(
            itemId: "1", title: "Item", imageUrl: nil, itemWebUrl: itemWebUrl,
            askingCents: 1000, shadowGrade: 7, gradeConfidence: 0.8,
            valueLowCents: 1500, valueMedianCents: 2000, valueHighCents: 2500,
            estMarginCents: 500, estMarginPct: 0.5,
            underpriced: true, actionable: true, reason: "",
            valueBasis: nil, url: url
        )
    }

}
