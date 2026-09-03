import Foundation

/// US-3104 — the listing as a buyer will see it, as DATA.
///
/// The web composer has had `EbayViewItemPreview` since US-558. A seller
/// publishing from the phone had no preview at all, so a photo in the wrong
/// order or a description that renders as a wall of markup was found on eBay,
/// after the listing was live and buyers could already see it.
///
/// This type is the whole decision: which sections there are, in what order,
/// what each one says, and whether the description is HTML or plain text.
/// Nothing here draws anything, and nothing here touches SwiftData or the
/// network — which is what makes "the sections are in the web's order" and
/// "the credentials block renders as HTML" claims a test can check rather than
/// claims a screenshot could disagree with.
struct EbayPreviewModel: Equatable {

    /// The sections, in the order they render.
    ///
    /// ⚠️ ORDER NOTE. US-3104's acceptance criterion enumerates these as
    /// "gallery, title, price, condition, specifics, description", which is one
    /// pair transposed from the web component it asks for parity WITH:
    /// `ebay-view-item-preview.tsx` puts the condition pill ABOVE the price box
    /// in its buy box, and eBay's own view-item page does too. Parity is the
    /// point of the story, so the web order wins and the AC's inline list is
    /// read as the paraphrase it is. If that is ever decided the other way, the
    /// change is this enum's case order and the test that asserts it.
    enum Section: String, CaseIterable, Equatable {
        case gallery
        case title
        case condition
        case price
        case specifics
        case description
    }

    /// One row of the item-specifics table.
    struct Specific: Equatable, Identifiable {
        let label: String
        let value: String
        var id: String { label }
    }

    /// How the description has to be drawn.
    ///
    /// The web renders the body as ESCAPED text and the trailing seller
    /// credentials block as HTML, because that is how eBay renders the string it
    /// is given. One string, two treatments — so the split has to happen here
    /// rather than in the view, where a mistake would either print raw markup at
    /// a buyer-facing preview or execute markup as though it were trusted.
    enum DescriptionRender: Equatable {
        /// Nothing written yet.
        case empty
        /// No credentials block: the whole string is text, escaped by SwiftUI.
        case plain(String)
        /// A credentials block is present. `body` is still TEXT (escape it) and
        /// `credentials` is GradeThread-built markup whose dynamic values were
        /// escaped at the source (edge `seller-credentials.ts`).
        case html(body: String, credentials: String)
    }

    let title: String
    /// "US $48.00", or the not-set copy. Never a bare "0.00": a price the
    /// seller has not set is a thing to fix before publishing, not a free item.
    let priceLabel: String
    /// "Buy It Now", "Auction", or "Buy It Now · Best offer".
    let formatLabel: String
    let conditionLabel: String
    /// The seller's own condition note. The web preview has no equivalent; the
    /// AC asks for it, and it is the line a buyer reads hardest.
    let conditionDescription: String?
    let specifics: [Specific]
    let description: DescriptionRender
    /// Shipping and returns, as the assigned business policies name them. Nil
    /// when the account default applies, which is what the composer says too.
    let shippingPolicyName: String?
    let returnPolicyName: String?

    /// The sections this listing actually has, in order.
    ///
    /// Specifics and description drop out when empty, matching the web (both
    /// render `null` there). Gallery, title, condition and price always render:
    /// each of them is a thing that MUST be right, so an absent one is worth
    /// showing as absent.
    var sections: [Section] {
        Section.allCases.filter { section in
            switch section {
            case .specifics: return !specifics.isEmpty
            case .description: return description != .empty
            default: return true
            }
        }
    }
}

// MARK: - Building it

extension EbayPreviewModel {

    /// The marker the edge appends the "Verified Seller" credentials block
    /// behind (`SELLER_CREDENTIALS_MARKER` in src/lib/listing-templates.ts, and
    /// the open-only marker list in `DescriptionBlocks`). Keep this literal in
    /// lockstep with both.
    static let sellerCredentialsMarker = "<!--gradethread-seller-credentials-->"

    /// Split a resolved description the way the web preview does: everything
    /// before the marker is body text, everything from the marker on is the
    /// block, and a string with no marker is all body.
    ///
    /// The MARKER is what decides, not a guess at whether the string "looks like
    /// HTML". A seller who types "<3 this jacket" has not written markup, and
    /// sniffing for angle brackets would render their sentence as a broken tag.
    static func describe(_ description: String) -> DescriptionRender {
        let trimmed = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .empty }

        guard let range = description.range(of: sellerCredentialsMarker) else {
            return .plain(trimmed)
        }

        let body = String(description[description.startIndex..<range.lowerBound])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let credentials = String(description[range.upperBound...])
            .trimmingCharacters(in: .whitespacesAndNewlines)

        // A marker with nothing after it is a string the renderer started and
        // did not finish. The body is still worth showing, and an empty web
        // view is not.
        guard !credentials.isEmpty else {
            return body.isEmpty ? .empty : .plain(body)
        }
        return .html(body: body, credentials: credentials)
    }

    /// The document loaded into the preview's web view.
    ///
    /// The body is ESCAPED and the credentials block is not, which is the whole
    /// asymmetry: the body is whatever the seller typed and the block is markup
    /// we built. Styling is inline and minimal — this is a preview of a listing,
    /// not a page, and a stylesheet here would drift from what eBay does.
    static func htmlDocument(body: String, credentials: String, dark: Bool) -> String {
        let fg = dark ? "#f2f2f7" : "#1a1a2e"
        let bg = dark ? "#1c1c1e" : "#ffffff"
        let bodyBlock = body.isEmpty
            ? ""
            : "<p class=\"body\">\(escapeHTML(body))</p>"
        return """
        <!doctype html>
        <html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
        html,body{margin:0;padding:0;background:\(bg);color:\(fg);
        font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        -webkit-text-size-adjust:100%;}
        .body{white-space:pre-wrap;margin:0 0 12px;}
        img{max-width:100%;height:auto;}
        table{max-width:100%;}
        </style></head>
        <body>\(bodyBlock)\(credentials)</body></html>
        """
    }

    /// Minimal HTML escaping for text that must render as text.
    ///
    /// Ampersand FIRST, or the escapes escape each other and `<` comes out as
    /// `&amp;lt;`.
    static func escapeHTML(_ text: String) -> String {
        text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    /// The specifics table, from the server-resolved aspects plus anything an
    /// applied template set.
    ///
    /// The template wins on a collision: it is the seller's own choice, applied
    /// after the server resolved its suggestion, and it is what `ComposerEdits`
    /// sends. Sorted by label so the same listing previews the same way twice —
    /// a dictionary has no order, and a table that reshuffles between opens
    /// looks like the data changed.
    static func specifics(
        aspects: [String: [String]]?,
        templateSpecifics: [String: String]
    ) -> [Specific] {
        var merged: [String: String] = [:]
        for (label, values) in aspects ?? [:] {
            let value = values
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: ", ")
            if !value.isEmpty { merged[label] = value }
        }
        for (label, value) in templateSpecifics {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { merged[label] = trimmed }
        }
        return merged
            .map { Specific(label: $0.key, value: $0.value) }
            .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    /// "Buy It Now", "Auction", or "Buy It Now · Best offer".
    ///
    /// eBay refuses Best Offer on an auction and the publish path suppresses it,
    /// so an auction never carries the suffix however the toggle is set —
    /// the same rule `ComposerFormatChoice.allowsBestOffer` enforces one screen
    /// up. A preview that promised Best Offer on an auction would be promising
    /// something the publish is about to drop.
    static func formatLabel(_ format: ComposerFormatChoice, bestOffer: Bool) -> String {
        if format.isAuction { return String(localized: "Auction") }
        return bestOffer
            ? String(localized: "Buy It Now · Best offer")
            : String(localized: "Buy It Now")
    }

    /// eBay's own price line, or the not-set copy.
    static func priceLabel(_ cents: Int?, currency: String?) -> String {
        guard let cents, cents > 0 else { return String(localized: "Price not set") }
        let formatted = CurrencyFormatter.shared.formatDisplay(Double(cents) / 100)
        // The web prints "US $48.00" because that is what eBay's page prints.
        // Only for USD: prefixing "US" onto a euro amount would be a lie about
        // which marketplace this lists on.
        return (currency ?? "USD") == "USD" ? "US \(formatted)" : formatted
    }
}
