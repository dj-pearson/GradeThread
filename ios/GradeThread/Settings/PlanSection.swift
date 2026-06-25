import StoreKit
import SwiftUI

/// Settings "Plan & credits" section: the user's FlipDesk plan, grade
/// credit balance, included grades remaining this month, and a way to manage
/// billing. App Store-billed subscribers manage natively (the system
/// manage-subscriptions sheet); existing web (Stripe) subscribers open web
/// billing to manage their sub; free users get ONLY the StoreKit
/// ``PaywallView`` — never web Stripe checkout (US-1207, Guideline 3.1.1).
struct PlanSection: View {
    @Environment(AuthStore.self) private var authStore
    @State private var store = PlanStore()
    @State private var activeSheet: ActiveSheet?
    @State private var showManageSubscriptions = false

    private static let billingURL = URL(string: "https://gradethread.com/dashboard/billing")!

    /// A single sheet selector. Stacking multiple `.sheet(isPresented:)`
    /// modifiers on one view makes SwiftUI tear the presentation down the
    /// instant either toggles — the sheet flashes open and immediately
    /// dismisses. One `.sheet(item:)` (like ProfileSection) presents reliably.
    private enum ActiveSheet: Identifiable {
        case paywall(UUID)
        case billing

        var id: String {
            switch self {
            case let .paywall(userId): return "paywall-\(userId.uuidString)"
            case .billing: return "billing"
            }
        }
    }

    private var userId: UUID? {
        if case let .signedIn(user) = authStore.phase { return user.id }
        return nil
    }

    /// True only once the plan has loaded AND the user is an entitled web
    /// (Stripe) subscriber. Gates the web-billing footer line (US-1207).
    private var isWebBilledSubscriber: Bool {
        if case let .ready(info) = store.phase { return info.isWebBilledSubscriber }
        return false
    }

    var body: some View {
        Section {
            switch store.phase {
            case .loading:
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(0..<3, id: \.self) { _ in
                        HStack {
                            SkeletonLine(widthFraction: 0.35, height: 12)
                            Spacer()
                            SkeletonBlock(cornerRadius: 6)
                                .frame(width: 64, height: 14)
                        }
                    }
                }
                .padding(.vertical, 4)
            case let .ready(info):
                readyRows(info)
            case let .failed(message):
                VStack(alignment: .leading, spacing: 6) {
                    Text("Couldn't load your plan.")
                        .font(.subheadline)
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Try again") { Task { await store.load() } }
                        .font(.subheadline)
                }
            }
        } header: {
            Text("Plan & credits")
        } footer: {
            // The "View past invoices on the web" line points at the Stripe
            // surface, so it's shown ONLY to existing web (Stripe) subscribers.
            // Free and App Store-billed users never see it (US-1207): free users
            // have no web billing, and App Store invoices live in the App Store.
            if isWebBilledSubscriber {
                Text("Buy grade credits or change your plan with “See plans & credits” above. View past invoices on the web.")
                    .font(.footnote)
            } else {
                Text("Buy grade credits or change your plan with “See plans & credits” above.")
                    .font(.footnote)
            }
        }
        .task { await store.load() }
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case let .paywall(userId):
                NavigationStack { PaywallView(userId: userId) }
            case .billing:
                SafariView(url: Self.billingURL).ignoresSafeArea()
            }
        }
        .manageSubscriptionsSheet(isPresented: $showManageSubscriptions)
        .onChange(of: showManageSubscriptions) { _, presented in
            // Reload the plan after the system sheet (cancel/auto-renew may have changed).
            if !presented { Task { await store.load() } }
        }
    }

    @ViewBuilder
    private func readyRows(_ info: PlanStore.PlanInfo) -> some View {
        LabeledContent("Plan", value: (info.flipdesk_plan ?? "free").capitalized)

        LabeledContent("Grade credits", value: "\(info.grade_credit_balance ?? 0)")

        if let usage = GradePlanLimits.includedUsage(
            plan: info.flipdesk_plan,
            gradesUsed: info.grades_used_this_month,
            resetAt: info.grade_reset_at
        ) {
            let remaining = max(0, usage.cap - usage.used)
            LabeledContent(
                "Included grades",
                value: "\(remaining) of \(usage.cap) left this month"
            )
        }

        if let userId {
            Button {
                AppRouter.haptic()
                activeSheet = .paywall(userId)
            } label: {
                Label("See plans & credits", systemImage: "sparkles")
            }
        }

        if info.billedOnAppStore {
            // App Store-billed: manage natively. Web billing can't manage this sub.
            Button {
                AppRouter.haptic()
                showManageSubscriptions = true
            } label: {
                Label("Manage subscription", systemImage: "creditcard")
            }
        } else if info.isWebBilledSubscriber {
            // Existing web (Stripe) subscriber: the Stripe portal to manage an
            // ALREADY-PURCHASED subscription lives on the web. This is the ONLY
            // state allowed to open web billing — gated by `isWebBilledSubscriber`
            // (billing_source == "stripe" + entitling status) so a free user
            // never reaches a page that can start a Stripe checkout (US-1207,
            // App Store Guideline 3.1.1 anti-steering).
            Button {
                AppRouter.haptic()
                activeSheet = .billing
            } label: {
                Label("Manage plan & billing", systemImage: "creditcard")
            }
        }
        // Free users (no active subscription) get no web billing entry at all:
        // "See plans & credits" above is their only purchase path, and it opens
        // the StoreKit ``PaywallView`` (IAP) — never web Stripe checkout.
    }
}
