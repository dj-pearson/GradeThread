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

    init(userId: UUID) {
        _store = State(initialValue: PaywallStore(userId: userId))
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
        .navigationTitle("Plans")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
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
    }

    @ViewBuilder
    private func trailing(for entry: IAPCatalogEntry) -> some View {
        if case let .subscription(plan, _) = entry.kind, store.isCurrentPlan(plan) {
            Text("Current")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.brandEmerald)
        } else if store.purchasingId == entry.productId {
            ProgressView()
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
        } else if store.purchaseError != nil {
            HapticFeedback.error()
        }
    }
}
