import Foundation

/// iOS StoreKit product catalog — OFFLINE FALLBACK ONLY.
///
/// The canonical source is the server map in
/// services/edge-functions/src/lib/appstore/products.ts, served at
/// GET /api/payments/catalog and fetched + cached at runtime by `CatalogService`
/// (see `PaywallStore.load()`). These hardcoded entries exist only so the paywall
/// still renders tier/credit mappings and reference prices when the catalog can't
/// be fetched AND StoreKit prices haven't loaded. Product ids MUST match the App
/// Store Connect identifiers and the server map exactly — the drift test
/// services/edge-functions/src/tests/iap-catalog-drift_test.ts fails the build if
/// the ids, credits, plan/interval, or `fallbackPrice` here diverge from the
/// server catalog. Apple controls the real charged price; `fallbackPrice` is
/// reference/offline display only.

enum IAPKind: Equatable {
    case subscription(plan: String, interval: String)
    case consumable(credits: Int)
}

struct IAPCatalogEntry: Identifiable, Equatable {
    let productId: String
    let kind: IAPKind
    let title: String
    let blurb: String
    let fallbackPrice: String
    /// Reference price in USD cents — mirrors the server `referencePriceCents`
    /// (lib/appstore/products.ts) and the `fallbackPrice` display string. Used to
    /// compute the yearly-vs-monthly savings badge (US-1177); Apple controls the
    /// real charged price, so this drives the *percentage* (a ratio that holds
    /// across the proportional Apple price tiers regardless of local currency).
    let referenceCents: Int
    var id: String { productId }
}

extension IAPKind {
    /// True for auto-renewing subscriptions (vs one-time consumable credit packs).
    var isSubscription: Bool {
        if case .subscription = self { return true }
        return false
    }

    /// Singular billing-period noun for an auto-renewing subscription
    /// ("month"/"year"), or nil for consumables. Mirrors the StoreKit
    /// `Product.subscription.subscriptionPeriod` for the product's interval and
    /// drives the per-row auto-renew disclosure required by App Store Guideline
    /// 3.1.2.
    var billingPeriodNoun: String? {
        guard case let .subscription(_, interval) = self else { return nil }
        switch interval {
        case "yearly": return "year"
        case "monthly": return "month"
        default: return interval
        }
    }
}

extension IAPCatalogEntry {
    var isSubscription: Bool { kind.isSubscription }

    /// Per-row disclosure line. For subscriptions: states the auto-renew cadence
    /// (Guideline 3.1.2); for consumables: marks the one-time nature so credit
    /// packs are visually distinguished from auto-renewing subscriptions.
    var renewalDisclosure: String {
        if let period = kind.billingPeriodNoun {
            return "Auto-renews every \(period)"
        }
        return "One-time purchase · credits never expire"
    }
}

enum IAPCatalog {
    static let all: [IAPCatalogEntry] = [
        IAPCatalogEntry(
            productId: "com.gradethread.sub.starter.monthly",
            kind: .subscription(plan: "starter", interval: "monthly"),
            title: "Starter", blurb: "250 listings · 200 AI actions · 10 grades/mo",
            fallbackPrice: "$29/mo", referenceCents: 2900),
        IAPCatalogEntry(
            productId: "com.gradethread.sub.starter.yearly",
            kind: .subscription(plan: "starter", interval: "yearly"),
            title: "Starter", blurb: "250 listings · 200 AI actions · 10 grades/mo",
            fallbackPrice: "$290/yr", referenceCents: 29000),
        IAPCatalogEntry(
            productId: "com.gradethread.sub.pro.monthly",
            kind: .subscription(plan: "pro", interval: "monthly"),
            title: "Pro", blurb: "1,000 listings · 750 AI actions · 30 grades · AutoLister",
            fallbackPrice: "$59/mo", referenceCents: 5900),
        IAPCatalogEntry(
            productId: "com.gradethread.sub.pro.yearly",
            kind: .subscription(plan: "pro", interval: "yearly"),
            title: "Pro", blurb: "1,000 listings · 750 AI actions · 30 grades · AutoLister",
            fallbackPrice: "$590/yr", referenceCents: 59000),
        IAPCatalogEntry(
            productId: "com.gradethread.sub.business.monthly",
            kind: .subscription(plan: "business", interval: "monthly"),
            title: "Business", blurb: "Unlimited listings · team seats · API · reconciliation",
            fallbackPrice: "$99/mo", referenceCents: 9900),
        IAPCatalogEntry(
            productId: "com.gradethread.sub.business.yearly",
            kind: .subscription(plan: "business", interval: "yearly"),
            title: "Business", blurb: "Unlimited listings · team seats · API · reconciliation",
            fallbackPrice: "$990/yr", referenceCents: 99000),
        IAPCatalogEntry(
            productId: "com.gradethread.credits.10", kind: .consumable(credits: 10),
            title: "10 grade credits", blurb: "Never expire",
            fallbackPrice: "$24.99", referenceCents: 2499),
        IAPCatalogEntry(
            productId: "com.gradethread.credits.25", kind: .consumable(credits: 25),
            title: "25 grade credits", blurb: "Never expire",
            fallbackPrice: "$59.99", referenceCents: 5999),
        IAPCatalogEntry(
            productId: "com.gradethread.credits.50", kind: .consumable(credits: 50),
            title: "50 grade credits", blurb: "Never expire",
            fallbackPrice: "$109.99", referenceCents: 10999),
        IAPCatalogEntry(
            productId: "com.gradethread.credits.100", kind: .consumable(credits: 100),
            title: "100 grade credits", blurb: "Never expire",
            fallbackPrice: "$199.99", referenceCents: 19999),
    ]

    /// Fail-closed classification (mirrors the server's classifyProduct).
    static func classify(_ productId: String) -> IAPKind? {
        all.first { $0.productId == productId }?.kind
    }

    static func entry(for productId: String) -> IAPCatalogEntry? {
        all.first { $0.productId == productId }
    }

    static var allIds: [String] { all.map(\.productId) }

    /// Subscription tiers for one billing interval, in display order.
    static func subscriptions(interval: String) -> [IAPCatalogEntry] {
        all.filter {
            if case let .subscription(_, i) = $0.kind { return i == interval }
            return false
        }
    }

    static var consumables: [IAPCatalogEntry] {
        all.filter {
            if case .consumable = $0.kind { return true }
            return false
        }
    }

    // MARK: - Yearly savings (US-1177)

    /// Rounded percent saved by paying yearly instead of 12 monthly payments,
    /// or nil when either price is missing/non-positive or yearly isn't actually
    /// cheaper. Pure — used both for the per-row "Save N%" badge and the interval
    /// nudge. The reference cents mirror the server catalog (and the displayed
    /// prices), so the percentage stays accurate across Apple's proportional
    /// price tiers regardless of the buyer's local currency.
    static func yearlySavingsPercent(monthlyCents: Int, yearlyCents: Int) -> Int? {
        guard monthlyCents > 0, yearlyCents > 0 else { return nil }
        let annualizedMonthly = monthlyCents * 12
        guard yearlyCents < annualizedMonthly else { return nil }
        let saved = Double(annualizedMonthly - yearlyCents) / Double(annualizedMonthly)
        let pct = Int((saved * 100).rounded())
        return pct > 0 ? pct : nil
    }

    /// Yearly savings for a plan tier ("starter"/"pro"/"business"), pairing its
    /// monthly + yearly products. Nil if either side is absent.
    static func yearlySavingsPercent(plan: String) -> Int? {
        let lower = plan.lowercased()
        func cents(_ interval: String) -> Int? {
            all.first {
                if case let .subscription(p, i) = $0.kind {
                    return p.lowercased() == lower && i == interval
                }
                return false
            }?.referenceCents
        }
        guard let monthly = cents("monthly"), let yearly = cents("yearly") else { return nil }
        return yearlySavingsPercent(monthlyCents: monthly, yearlyCents: yearly)
    }

    /// Savings to badge a specific row — only the yearly tier of a subscription
    /// surfaces one; everything else returns nil.
    static func yearlySavingsPercent(for entry: IAPCatalogEntry) -> Int? {
        guard case let .subscription(plan, interval) = entry.kind, interval == "yearly" else {
            return nil
        }
        return yearlySavingsPercent(plan: plan)
    }

    /// The best yearly savings across all tiers, for the "save up to N%" interval
    /// nudge. Nil when no tier offers a yearly discount.
    static var maxYearlySavingsPercent: Int? {
        subscriptions(interval: "yearly").compactMap { yearlySavingsPercent(for: $0) }.max()
    }
}
