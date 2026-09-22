// GENERATED FILE. DO NOT EDIT.
//
// Source:      extension-unified/lister/selectors.js (each platform's list block)
// Regenerate:  node scripts/gen-ios-list-selectors.mjs
// Guarded by:  scripts/gen-ios-list-selectors.mjs --check, run by
//              src/test/ios-list-flows-drift.test.ts in npm run verify
//
// US-3455. The iOS app fills a marketplace's create-listing form in a
// WKWebView the seller is signed into and watching, then stops with the
// marketplace's own Post button on screen. The selectors it fills are the same
// ones the desktop extension fills, resolved at build time and compiled in,
// because the app must download no executable code at runtime (App Review 4.7)
// and because a hand-kept second copy of a marketplace's DOM goes stale the
// day the first one is fixed.
//
// `submit` is carried so the run can PROBE that it is on the real form. It is
// never clicked: the seller posts.

import Foundation

enum ListFlows {

    struct Flow {
        let platform: String
        let label: String
        /// Verified against the live site. False means refuse, never guess.
        let enabled: Bool
        /// The selector-set version, named in a refusal so a stale build is
        /// diagnosable from a screenshot.
        let version: String
        /// Hosts the run may load. Anything else stops it.
        let hosts: [String]
        /// The create-listing page. The only URL this flow opens on its own.
        let newListingUrl: String
        /// A URL that means the marketplace wants a sign-in first.
        let loginUrlPattern: String?
        /// What a live listing's URL looks like: landing on one means the
        /// seller posted, and is the only thing that records a listing.
        let liveListingUrlPattern: String?
        /// Field names that must ALL be present before anything is filled.
        let required: [String]
        let title: String?
        let description: String?
        let price: String?
        let originalPrice: String?
        let brand: String?
        /// The form's file input. Photos go through the marketplace's own
        /// picker, which this input opens when the seller taps it.
        let photoInput: String?
        /// Poshmark keeps the price behind a dialog; nil elsewhere.
        let priceDialogOpen: String?
        let priceDialogPrice: String?
        /// Probed, never clicked.
        let submit: String?
        /// Pickers the seller sets by hand on the form, in this order.
        let manualFields: [String]

        /// The selector a `required` name refers to.
        func selector(named name: String) -> String? {
            switch name {
            case "title": return title
            case "description": return description
            case "price": return price
            case "originalPrice": return originalPrice
            case "brand": return brand
            case "photoInput": return photoInput
            case "submit": return submit
            default: return nil
            }
        }
    }

    static let flows: [String: Flow] = [
        "poshmark": Flow(
            platform: "poshmark",
            label: "Poshmark",
            enabled: true,
            version: "2026.08.2",
            hosts: ["poshmark.com"],
            newListingUrl: "https://poshmark.com/create-listing",
            loginUrlPattern: "poshmark\\.com/(login|signup)",
            liveListingUrlPattern: "^https://[^/]*poshmark\\.(com|ca)/listing/[^/]+",
            required: ["title", "description", "submit"],
            title: "input[data-test=\"listing-editor-title\"], input[name=\"title\"], input#title, input[placeholder^=\"What are you selling\"]",
            description: "textarea[data-test=\"listing-editor-description\"], textarea[name=\"description\"], textarea#description, textarea[placeholder^=\"Describe it\"]",
            price: "input[data-vv-name=\"listingPrice\"], #listing-price-modal-listing-price-input, input[data-test=\"listing-editor-listing-price\"]",
            originalPrice: "input[data-vv-name=\"originalPrice\"], #listing-price-modal-original-price-input, input[data-test=\"listing-editor-original-price\"]",
            brand: "input[placeholder^=\"Enter the Brand\"]",
            photoInput: "input#img-file-input, input[name=\"img-file-input\"], input[type=\"file\"][accept*=\"image\"], input[type=\"file\"][accept*=\"jpg\"]",
            priceDialogOpen: "input.ff--no-increment-input:not([id^=\"listing-price-modal\"])",
            priceDialogPrice: "#listing-price-modal-listing-price-input, input[aria-label=\"Listing Price\"]",
            submit: "button[data-test=\"listing-editor-submit\"], button[type=\"submit\"].listing-editor__submit, button.btn--primary[type=\"submit\"], button[data-et-name=\"next\"]",
            manualFields: ["category", "size", "color", "nwt"]
        ),
        "mercari": Flow(
            platform: "mercari",
            label: "Mercari",
            enabled: true,
            version: "2026.08.1",
            hosts: ["mercari.com"],
            newListingUrl: "https://www.mercari.com/sell/",
            loginUrlPattern: "mercari\\.com/(signin|login|signup)",
            liveListingUrlPattern: "^https://[^/]*mercari\\.com/(us/)?item/[^/]+",
            required: ["title", "description", "price", "submit"],
            title: "input[data-testid=\"Title\"], input[name=\"sellName\"], input#sellName",
            description: "textarea[name=\"description\"], textarea[data-testid=\"Description\"]",
            price: "input[name=\"price\"], input[data-testid=\"Price\"]",
            originalPrice: nil,
            brand: "input[data-testid=\"Brand\"], input[data-testid=\"BrandName\"], input[name=\"brand\"], input#brand",
            photoInput: "input[type=\"file\"][accept*=\"image\"]",
            priceDialogOpen: nil,
            priceDialogPrice: nil,
            submit: "button[data-testid=\"ListButton\"], button[type=\"submit\"]",
            manualFields: ["category", "condition", "size"]
        ),
    ]

    static func flow(for platform: String) -> Flow? {
        flows[platform]
    }

    /// Platforms this build will fill for. Everything else queues for the
    /// desktop, which is the honest answer and the one a seller can act on.
    static var runnable: [String] {
        flows.values.filter { $0.enabled }.map { $0.platform }.sorted()
    }
}
