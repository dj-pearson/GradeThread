// GENERATED FILE. DO NOT EDIT.
//
// Source:      extension-unified/lister/selectors.js (each platform's delist block)
// Regenerate:  node scripts/gen-ios-delist-selectors.mjs
// Guarded by:  scripts/gen-ios-delist-selectors.mjs --check, in npm run verify
//
// US-3281. The iOS app ends a listing in a WKWebView the seller is signed into
// and watching. The selectors it clicks are the same ones the desktop extension
// clicks, resolved at build time and compiled in, because the app must download
// no executable code at runtime (App Review 4.7) and because a hand-kept second
// copy of a marketplace's DOM goes stale the day the first one is fixed.
//
// `enabled: false` means nobody has verified that platform's delist flow
// against the live site. The runner refuses those by name.

import Foundation

enum DelistFlows {

    struct Flow {
        let platform: String
        let label: String
        /// Verified against the live site. False means refuse, never guess.
        let enabled: Bool
        /// The selector-set version, reported in failures so a stale build is
        /// diagnosable from a screenshot.
        let version: String
        /// Hosts a listing URL must match before anything is loaded.
        let hosts: [String]
        /// What a live listing's URL looks like, so a page that is not one is
        /// never clicked on.
        let liveListingUrlPattern: String?
        /// Set when the menu control navigates to another page (Poshmark's
        /// delete lives on the edit page) rather than opening a panel in place.
        let navigatesTo: String?
        let menu: String?
        let remove: String?
        let confirm: String?
        /// Absent from the page once the listing is gone. Used to confirm the
        /// end actually happened rather than trusting the click.
        let goneWhenEnded: String?
    }

    static let flows: [String: Flow] = [
        "poshmark": Flow(
            platform: "poshmark",
            label: "Poshmark",
            enabled: true,
            version: "2026.08.0",
            hosts: ["poshmark.com"],
            liveListingUrlPattern: "^https://[^/]*poshmark\\.(com|ca)/listing/[^/]+",
            navigatesTo: "^https://[^/]*poshmark\\.(com|ca)/edit-listing/",
            menu: "[data-et-name=\"edit_listing\"], button[data-test=\"listing-menu\"], button.listing__menu, [data-et-name=\"listing_options\"]",
            remove: "[data-et-name=\"delete\"], [data-test=\"delete-listing\"], [data-et-name=\"delete_listing\"], a[href*=\"delete\"]",
            confirm: "button[data-test=\"confirm-delete\"], button.btn--primary[data-et-name=\"yes\"], button[data-et-name=\"confirm\"], [data-test=\"modal-footer\"] button.btn--primary",
            goneWhenEnded: "button[data-test=\"listing-menu\"], button.listing__menu"
        ),
        "mercari": Flow(
            platform: "mercari",
            label: "Mercari",
            enabled: true,
            version: "2026.08.0",
            hosts: ["mercari.com"],
            liveListingUrlPattern: "^https://[^/]*mercari\\.com/(us/)?item/[^/]+",
            navigatesTo: nil,
            menu: "button[data-testid=\"MoreItemOptions\"], button[data-testid=\"ListingMenu\"], button[aria-label*=\"menu\"]",
            remove: "[data-testid=\"ItemOptions\"] [data-testid*=\"Delete\"], [data-testid=\"ItemOptions\"] [data-testid*=\"Remove\"], [data-testid=\"Delete\"], [data-testid=\"DeleteListing\"]",
            confirm: "button[data-testid=\"ConfirmDelete\"], button[type=\"submit\"]",
            goneWhenEnded: "button[data-testid=\"MoreItemOptions\"], button[data-testid=\"ListingMenu\"]"
        ),
        "grailed": Flow(
            platform: "grailed",
            label: "Grailed",
            enabled: false,
            version: "2026.07.0-draft",
            hosts: ["grailed.com"],
            liveListingUrlPattern: "^https://[^/]*grailed\\.com/listings/[^/]+",
            navigatesTo: nil,
            menu: "button[aria-label*=\"actions\"], button.listing-actions",
            remove: "button[data-action=\"delete\"], a[href*=\"delete\"]",
            confirm: "button[data-action=\"confirm-delete\"], button[type=\"submit\"]",
            goneWhenEnded: "button[aria-label*=\"actions\"], button.listing-actions"
        ),
        "vinted": Flow(
            platform: "vinted",
            label: "Vinted",
            enabled: false,
            version: "2026.08.0-draft",
            hosts: ["vinted.com", "vinted.co.uk", "vinted.fr", "vinted.de", "vinted.es", "vinted.it", "vinted.nl", "vinted.pl", "vinted.be", "vinted.at", "vinted.cz", "vinted.sk", "vinted.lt", "vinted.pt", "vinted.se", "vinted.ro", "vinted.hu", "vinted.lu", "vinted.hr", "vinted.gr", "vinted.dk", "vinted.fi"],
            liveListingUrlPattern: "^https://[^/]*vinted\\.[a-z.]+/items/\\d+",
            navigatesTo: nil,
            menu: "button[data-testid=\"item-action-menu\"], button[aria-label*=\"More\"], button.item-actions",
            remove: "[data-testid=\"item-delete\"], button[data-testid=\"delete-item\"], a[href*=\"delete\"]",
            confirm: "button[data-testid=\"modal-confirm-button\"], button[data-testid=\"item-delete-confirm\"], button[type=\"submit\"]",
            goneWhenEnded: "button[data-testid=\"item-action-menu\"], button.item-actions"
        ),
        "facebook": Flow(
            platform: "facebook",
            label: "Facebook Marketplace",
            enabled: false,
            version: "2026.08.0-draft",
            hosts: ["facebook.com", "fb.com"],
            liveListingUrlPattern: "^https://[^/]*facebook\\.com/marketplace/item/\\d+",
            navigatesTo: nil,
            menu: "div[aria-label=\"More options\"][role=\"button\"], div[aria-label*=\"More\"][role=\"button\"], [aria-label=\"Actions for this listing\"]",
            remove: "div[role=\"menuitem\"][aria-label*=\"Delete\"], div[role=\"menuitem\"][aria-label*=\"Remove\"]",
            confirm: "div[aria-label=\"Delete\"][role=\"button\"], div[aria-label=\"Confirm\"][role=\"button\"], button[type=\"submit\"]",
            goneWhenEnded: "div[aria-label=\"More options\"][role=\"button\"]"
        ),
    ]

    static func flow(for platform: String) -> Flow? {
        flows[platform]
    }

    /// Platforms this build will attempt. Everything else is refused with the
    /// reason, which is the honest answer and the one a seller can act on.
    static var runnable: [String] {
        flows.values.filter { $0.enabled }.map { $0.platform }.sorted()
    }
}
