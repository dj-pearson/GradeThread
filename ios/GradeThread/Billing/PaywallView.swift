import StoreKit
import SwiftUI

/// In-app paywall: subscription tiers (monthly/yearly) + credit packs, purchased
/// via StoreKit. Reuses `PaywallStore`. App Store-billed subscribers get a native
/// management card (renewal/auto-renew + the system manage-subscriptions sheet;
/// upgrade/downgrade by buying another tier). When an active Stripe subscription
/// owns the plan, subscription purchases are blocked with a "manage on web" link
/// (credit packs remain available).
struct PaywallView: View {
    @State private var store: PaywallStore
    @State private var showManageSubscriptions = false
    @State private var showWebBilling = false
    @Environment(\.dismiss) private var dismiss

    private static let billingURL = URL(string: "https://gradethread.com/dashboard/billing")!

    /// US-804: when set, the paywall is embedded as the final onboarding step. It
    /// pins an always-visible "Continue with Free" action, hides the dismiss
    /// toolbar, and reports purchase completion so the host can advance into the
    /// app. `nil` = the normal Settings paywall (behavior unchanged).
    private let onboarding: OnboardingConfig?

    /// US-804: callbacks the onboarding host injects to drive advancement. Kept on
    /// the view (not the store) so the store's purchase flow stays UI-agnostic.
    struct OnboardingConfig {
        /// Skip choosing a plan and start on the free tier.
        var onContinueFree: () -> Void
        /// A purchase verified successfully — the host decides whether to advance
        /// (it does for a subscription; a credit pack leaves the step open).
        var onPurchased: (IAPCatalogEntry) -> Void
    }

    init(userId: UUID) {
        _store = State(initialValue: PaywallStore(userId: userId))
        onboarding = nil
    }

    /// US-804: onboarding entry point — inject the store (so the host can build it
    /// once and reuse the live fetchers) plus the advance callbacks.
    init(store: PaywallStore, onboarding: OnboardingConfig) {
        _store = State(initialValue: store)
        self.onboarding = onboarding
    }

    var body: some View {
        List {
            switch store.phase {
            case .loading:
                loadingRow
            case .failed(let message):
                failed(message)
            case .ready:
                if store.managedOnAppStore { appStoreManagementSection }
                if store.managedOnWeb { managedBanner }
                intervalSection
                plansSection
                creditsSection
                legalSection
                restoreSection
            }
        }
        // US-804: pin "Continue with Free" so it's reachable without scrolling
        // the plan list — and visible during loading/failure too, so it can never
        // block entry to the app. No-op (EmptyView) in the normal Settings paywall.
        .safeAreaInset(edge: .bottom) { onboardingContinueBar }
        .navigationTitle(onboarding == nil ? "Plans" : "Choose your plan")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // The onboarding step has no dismiss affordance — the only exits are
            // "Continue with Free" or a purchase, both of which record the
            // show-once flag, so the step can't be skipped without being marked.
            if onboarding == nil {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .alert("Purchase failed", isPresented: Binding(
            get: { store.purchaseError != nil },
            set: { if !$0 { store.purchaseError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.purchaseError ?? "")
        }
        // Ask to Buy / SCA deferral: the purchase needs approval before it
        // completes; the transaction listener grants the entitlement once it's
        // approved (US-1144).
        .alert("Purchase pending approval", isPresented: Binding(
            get: { store.purchasePending },
            set: { if !$0 { store.purchasePending = false } }
        )) {
            Button("OK", role: .cancel) { store.purchasePending = false }
        } message: {
            Text("Your purchase needs approval before it completes. Once it's approved, your plan unlocks automatically — no need to buy again.")
        }
        // The 409 ACTIVE_STRIPE_SUBSCRIPTION dead-end: route to web billing
        // instead of surfacing a bare error.
        .alert("Subscription managed on the web", isPresented: Binding(
            get: { store.stripeConflict },
            set: { if !$0 { store.stripeConflict = false } }
        )) {
            Button("Manage on the web") {
                store.stripeConflict = false
                showWebBilling = true
            }
            Button("Not now", role: .cancel) { store.stripeConflict = false }
        } message: {
            Text("You have an active subscription billed on the web. Cancel it there before switching to App Store billing.")
        }
        .manageSubscriptionsSheet(isPresented: $showManageSubscriptions)
        .onChange(of: showManageSubscriptions) { _, presented in
            // Returning from the system sheet: the user may have toggled
            // auto-renew or cancelled — refresh the snapshot.
            if !presented { Task { await store.refreshBillingState() } }
        }
        .sheet(isPresented: $showWebBilling) {
            SafariView(url: Self.billingURL).ignoresSafeArea()
        }
        .task {
            if store.phase == .loading {
                Telemetry.event("paywall_opened")
                await store.load()
            }
        }
    }

    // MARK: - States

    private var loadingRow: some View {
        HStack { Spacer(); ProgressView(); Spacer() }
            .listRowBackground(Color.clear)
    }

    private func failed(_ message: String) -> some View {
        Section {
            ContentUnavailableView {
                Label("Couldn't load plans", systemImage: "creditcard.trianglebadge.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private var managedBanner: some View {
        Section {
            Label {
                Text("Your subscription is billed on the web and can't be changed here. Grade credit packs are still available below.")
                    .font(.footnote)
            } icon: {
                Image(systemName: "globe").foregroundStyle(Color.brandNavy)
            }
            Button {
                showWebBilling = true
            } label: {
                Label("Manage on the web", systemImage: "safari")
            }
        }
    }

    // MARK: - App Store management card

    private var appStoreManagementSection: some View {
        Section {
            if !store.currentPlan.isEmpty, store.currentPlan.lowercased() != "free" {
                LabeledContent("Current plan", value: store.currentPlan.capitalized)
            }
            if let renewal = store.subscriptionRenewalDate {
                LabeledContent(
                    store.autoRenewEnabled ? "Renews" : "Expires",
                    value: renewal.formatted(date: .abbreviated, time: .omitted))
            }
            LabeledContent("Auto-renew", value: store.autoRenewEnabled ? "On" : "Off")
            Button {
                showManageSubscriptions = true
            } label: {
                Label("Manage subscription", systemImage: "gear")
            }
        } header: {
            Text("Your subscription")
        } footer: {
            Text("Cancel or change auto-renew in the App Store. To upgrade or downgrade, pick another plan below.")
        }
    }

    // MARK: - Onboarding (US-804)

    /// Pinned bottom bar shown only in the onboarding step. Always visible —
    /// independent of the load/failure phase — so the user can always start on
    /// the free tier and is never blocked from entering the app.
    @ViewBuilder
    private var onboardingContinueBar: some View {
        if let onboarding {
            VStack(spacing: 0) {
                Divider()
                Button {
                    onboarding.onContinueFree()
                } label: {
                    Text("Continue with Free")
                        .font(.brandHeadline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.brandNavy)
                .padding(.horizontal, 20)
                .padding(.top, 6)
                .accessibilityHint("Skip choosing a plan and start on the free tier")
            }
            .background(.bar)
        }
    }

    // MARK: - Interval

    private var intervalSection: some View {
        Section {
            Picker("Billing", selection: Binding(
                get: { store.interval },
                set: { store.interval = $0 }
            )) {
                Text("Monthly").tag("monthly")
                Text("Yearly").tag("yearly")
            }
            .pickerStyle(.segmented)
        }
    }

    // MARK: - Plans

    private var plansSection: some View {
        Section {
            ForEach(IAPCatalog.subscriptions(interval: store.interval)) { entry in
                productRow(entry)
            }
        } header: {
            Text("Plans")
        } footer: {
            Text("Auto-renewing subscription. Your Apple ID is charged at confirmation and again at the start of each \(store.interval == "yearly" ? "year" : "month") unless you cancel at least 24 hours before the renewal date. Manage or cancel anytime in Settings › Apple ID › Subscriptions.")
        }
    }

    private var creditsSection: some View {
        Section {
            ForEach(IAPCatalog.consumables) { entry in
                productRow(entry)
            }
        } header: {
            Text("Grade credits")
        } footer: {
            Text("Credits never expire and work alongside any plan.")
        }
    }

    private func productRow(_ entry: IAPCatalogEntry) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title).font(.body.weight(.semibold))
                Text(entry.blurb).font(.caption).foregroundStyle(.secondary)
                Label {
                    Text(entry.renewalDisclosure)
                } icon: {
                    Image(systemName: entry.isSubscription
                        ? "arrow.triangle.2.circlepath" : "creditcard")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            trailing(for: entry)
        }
        // US-1173: stable per-product selector for the paywall UI test (US-1153).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("paywall.product.\(entry.id)")
    }

    @ViewBuilder
    private func trailing(for entry: IAPCatalogEntry) -> some View {
        if case let .subscription(plan, _) = entry.kind, store.isCurrentPlan(plan) {
            Text("Current")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.brandEmerald)
                // US-1151: VoiceOver reads "Current" with no context otherwise.
                .accessibilityLabel("\(entry.title), your current plan")
        } else if store.purchasingId == entry.productId {
            ProgressView()
                .accessibilityLabel("Purchasing \(entry.title)")
        } else {
            Button {
                Task { await buy(entry) }
            } label: {
                Text(store.price(for: entry))
                    .font(.callout.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
            .tint(.brandNavy)
            .disabled(!store.canPurchase(entry))
            // US-1151: the button's visible label is just the price; tell
            // VoiceOver which plan/pack it buys and what tapping does.
            .accessibilityLabel("\(entry.title), \(store.price(for: entry))")
            .accessibilityHint(entry.isSubscription
                ? "Subscribes to the \(entry.title) plan"
                : "Buys \(entry.title)")
        }
    }

    // MARK: - Legal (Guideline 3.1.2)

    private enum LegalLinks {
        static let terms = URL(string: "https://gradethread.com/terms")!
        static let privacy = URL(string: "https://gradethread.com/privacy")!
    }

    private var legalSection: some View {
        Section {
            Link(destination: LegalLinks.terms) {
                Label("Terms of Use", systemImage: "doc.text")
            }
            Link(destination: LegalLinks.privacy) {
                Label("Privacy Policy", systemImage: "hand.raised")
            }
        } footer: {
            Text("By subscribing you agree to our Terms of Use and Privacy Policy.")
        }
    }

    private var restoreSection: some View {
        Section {
            Button {
                Task { await store.restore(); HapticFeedback.light() }
            } label: {
                Label("Restore purchases", systemImage: "arrow.clockwise")
            }
            .accessibilityIdentifier("paywall.restore") // US-1173: stable UI-test selector
        } footer: {
            Text("Already subscribed on this Apple ID? Restore to re-link it.")
        }
    }

    // MARK: - Actions

    private func buy(_ entry: IAPCatalogEntry) async {
        let ok = await store.buy(entry)
        if ok {
            HapticFeedback.success()
            Telemetry.event("paywall_purchased", props: ["product": entry.productId])
            // US-804: the store already refreshed the billing snapshot inside
            // buy(); let the onboarding host advance (subscriptions) or stay
            // (credit packs).
            onboarding?.onPurchased(entry)
        } else if store.purchaseError != nil {
            HapticFeedback.error()
        }
    }
}
