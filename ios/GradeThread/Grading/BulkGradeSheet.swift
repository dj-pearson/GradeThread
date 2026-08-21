import SwiftUI

/// Batch certified-grading sheet, presented from the inventory multi-select
/// bar. Validates the whole selection, lets the user pick a tier, and submits
/// the ready items in one shot (blocked items are listed + skipped).
struct BulkGradeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthStore.self) private var authStore

    let itemIds: [String]
    /// Called after a successful submit so the list can clear selection +
    /// trigger a sync to pull the landing grades.
    let onSubmitted: () -> Void

    @State private var store: BulkGradeStore?
    /// The two billing surfaces this sheet can present over itself. One
    /// optional driving ONE `.sheet(item:)`, because a view has a single sheet
    /// slot and chaining two `.sheet(isPresented:)` modifiers makes them
    /// compete for it — see ``ToolModule``.
    @State private var creditSheet: CreditSheet?

    /// Presented over the grading sheet when the seller needs credits.
    private enum CreditSheet: String, Identifiable {
        /// The in-app StoreKit paywall (credit packs + plans).
        case paywall
        /// US-809: the focused credit-pack purchase sheet, opened from the
        /// blocked banner so credits can be bought without leaving here.
        case packs

        var id: String { rawValue }
    }
    /// US-980: confirm before a tap spends paid grade credits for the batch.
    @State private var showSpendConfirm = false

    private var currentUserId: UUID? {
        if case let .signedIn(user) = authStore.phase { return user.id }
        return nil
    }

    var body: some View {
        NavigationStack {
            Group {
                if let store {
                    content(store)
                } else {
                    progress("Checking \(itemIds.count) items…")
                }
            }
            .navigationTitle("Grade \(itemIds.count) items")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(closeTitle) { dismiss() }
                }
            }
            .task {
                if store == nil { store = BulkGradeStore(itemIds: itemIds) }
                await store?.load()
            }
        }
        .interactiveDismissDisabled(store?.phase == .submitting)
        // Reloading on dismiss now covers BOTH surfaces rather than only the
        // paywall. `creditsPurchased()` already refreshes after a pack purchase,
        // so the extra load is a no-op there and closes the gap where a
        // cancelled pack sheet left a stale credit count on screen.
        .sheet(item: $creditSheet, onDismiss: { Task { await store?.load() } }) { which in
            switch which {
            case .paywall:
                if let userId = currentUserId {
                    NavigationStack { PaywallView(userId: userId) }
                } else {
                    // US-1522: re-sign-in prompt instead of a blank sheet.
                    SessionExpiredView { creditSheet = nil }
                }
            case .packs:
                if let userId = currentUserId {
                    CreditPackSheet(userId: userId) {
                        Task { await store?.creditsPurchased() }
                    }
                } else {
                    SessionExpiredView { creditSheet = nil }
                }
            }
        }
    }

    private var closeTitle: String {
        store?.phase == .done ? "Done" : "Cancel"
    }

    @ViewBuilder
    private func content(_ store: BulkGradeStore) -> some View {
        switch store.phase {
        case .loading:
            progress("Checking \(itemIds.count) items…")
        case .ready:
            readyContent(store)
        case .submitting:
            progress("Submitting for grading…")
        case .done:
            doneContent(store)
        case let .failed(message):
            failedContent(store, message)
        case let .empty(message):
            emptyContent(message)
        }
    }

    // US-1184: terminal "nothing to grade" state — no "Try again" to loop on.
    private func emptyContent(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Nothing to grade", systemImage: "tray")
        } description: {
            Text(message)
        } actions: {
            Button("Close") { dismiss() }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)
        }
    }

    // MARK: - Ready

    @ViewBuilder
    private func readyContent(_ store: BulkGradeStore) -> some View {
        if let validation = store.validation {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    readinessSummary(store)
                    tierPicker(store)
                    planSummary(store, user: validation.user)
                    if validation.limitExceeded { creditsBanner(store) }
                    if !store.blockedItems.isEmpty { blockedList(store) }
                    submitButton(store)
                }
                .padding(20)
            }
            .background(Color(uiColor: .systemGroupedBackground))
        } else {
            progress("Checking items…")
        }
    }

    private func readinessSummary(_ store: BulkGradeStore) -> some View {
        let ready = store.readyItems.count
        let total = itemIds.count
        return HStack(spacing: 12) {
            Image(systemName: ready == total ? "checkmark.circle.fill" : "checkmark.circle")
                .font(.brandTitle2)
                .foregroundStyle(ready > 0 ? .brandEmerald : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(ready) of \(total) ready to grade")
                    .font(.subheadline.weight(.semibold))
                if ready < total {
                    Text("Blocked items are skipped — fix them and try again.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)  // US-691: unified card chrome
    }

    private func tierPicker(_ store: BulkGradeStore) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Service tier")
                .font(.subheadline.weight(.semibold))
            Picker("Tier", selection: tierBinding(store)) {
                ForEach(GradeTierOption.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
            .pickerStyle(.segmented)
            Text("\(store.tier.blurb) · \(store.tier.turnaround)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func tierBinding(_ store: BulkGradeStore) -> Binding<GradeTierOption> {
        Binding(
            get: { store.tier },
            set: { newValue in Task { await store.selectTier(newValue) } }
        )
    }

    private func planSummary(_ store: BulkGradeStore, user: GradingUserInfo) -> some View {
        let credits = store.validation?.creditsRequired ?? 0
        return VStack(spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(user.includedRemaining) included grade\(user.includedRemaining == 1 ? "" : "s") left")
                        .font(.footnote.weight(.medium))
                    Text("\(user.creditBalance) credit\(user.creditBalance == 1 ? "" : "s") · \(user.plan.capitalized) plan")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(credits == 0 ? "Included" : "\(credits) credit\(credits == 1 ? "" : "s")")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.brandNavy)
                    Text("for this batch")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            if currentUserId != nil {
                Divider()
                buyCreditsButton
            }
        }
        .padding(14)
        .cardStyle(.flush)  // US-691: unified card chrome
    }

    /// In-app purchase entry point: opens the StoreKit paywall to buy grade
    /// credit packs (10/25/50/100) or change plan. Always visible so credits
    /// are buyable at the point of need (Guideline 3.1.1 — no steering to an
    /// external/web purchase for in-app digital content).
    private var buyCreditsButton: some View {
        Button {
            AppRouter.haptic()
            creditSheet = .paywall
        } label: {
            Label("Buy grade credits", systemImage: "cart.badge.plus")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(Color.brandNavy)
    }

    private func creditsBanner(_ store: BulkGradeStore) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Not enough grading credits for this batch at this tier. Buy a grade credit pack, or pick a cheaper tier.", systemImage: "creditcard.trianglebadge.exclamationmark")
                .font(.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
            creditTopUpControl(store)
        }
        .padding(12)
        .background(Color.brandRed.opacity(0.10), in: RoundedRectangle(cornerRadius: CornerRadius.control))
    }

    /// US-809: the buy/poll/retry affordance inside the blocked banner. Buying
    /// opens the focused credit-pack sheet; after a purchase the store polls the
    /// async grant ("Applying your credits…") and, on timeout, offers a recheck.
    @ViewBuilder
    private func creditTopUpControl(_ store: BulkGradeStore) -> some View {
        switch store.creditTopUp.state {
        case .awaitingGrant:
            HStack(spacing: 8) {
                ProgressView().tint(Color.brandNavy)
                Text("Applying your credits…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .timedOut:
            VStack(alignment: .leading, spacing: 8) {
                Text("Your credits are taking a moment to apply. They'll arrive shortly.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 10) {
                    buyCreditsBannerButton
                    Button("Check again") { Task { await store.recheckCredits() } }
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.bordered)
                        .tint(Color.brandNavy)
                }
            }
        default:
            buyCreditsBannerButton
        }
    }

    private var buyCreditsBannerButton: some View {
        Button {
            AppRouter.haptic()
            creditSheet = .packs
        } label: {
            Label("Buy credits", systemImage: "cart.badge.plus")
                .font(.caption.weight(.semibold))
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.brandNavy)
    }

    private func blockedList(_ store: BulkGradeStore) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Skipped (\(store.blockedItems.count))")
                .font(.subheadline.weight(.semibold))
            ForEach(store.blockedItems, id: \.inventoryItemId) { item in
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title ?? "Untitled item")
                        .font(.footnote.weight(.medium))
                        .lineLimit(1)
                    // US-1184: show ALL blockers (matching GradeRequestSheet) and
                    // let the reason wrap, so fixing the one shown blocker doesn't
                    // leave the item still mysteriously skipped.
                    Text(item.blockers.isEmpty
                         ? "Not ready"
                         : item.blockers.map(humanize).joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.brandAmber.opacity(0.08), in: RoundedRectangle(cornerRadius: CornerRadius.control))
    }

    private func submitButton(_ store: BulkGradeStore) -> some View {
        let count = store.readyItems.count
        let credits = store.validation?.creditsRequired ?? 0
        return Button {
            AppRouter.haptic()
            // US-980: gate a paid batch spend behind a single confirmation;
            // an Included (0-credit) batch still submits in one tap.
            if credits > 0 {
                showSpendConfirm = true
            } else {
                Task { await store.submit() }
            }
        } label: {
            Label(
                count > 0 ? "Grade \(count) item\(count == 1 ? "" : "s")" : "Nothing ready to grade",
                systemImage: "checkmark.seal.fill"
            )
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.brandNavy)
        .disabled(!store.canSubmit)
        .confirmationDialog(
            "Spend \(credits) credit\(credits == 1 ? "" : "s")?",
            isPresented: $showSpendConfirm,
            titleVisibility: .visible
        ) {
            Button("Grade \(count) item\(count == 1 ? "" : "s") for \(credits) credit\(credits == 1 ? "" : "s")") {
                Task { await store.submit() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Grading \(count) item\(count == 1 ? "" : "s") at the \(store.tier.label) tier will use \(credits) grade credit\(credits == 1 ? "" : "s") from your balance.")
        }
    }

    // MARK: - Done

    private func doneContent(_ store: BulkGradeStore) -> some View {
        let submitted = store.result?.submitted ?? 0
        let failed = store.result?.failed ?? 0
        return ContentUnavailableView {
            Label("\(submitted) submitted for grading", systemImage: "checkmark.seal.fill")
        } description: {
            Text(failed > 0
                 ? "\(failed) couldn't be submitted. The grades for the rest will appear on each item shortly."
                 : "Grades will appear on each item as they finish — usually within a few moments.")
        } actions: {
            Button("Done") {
                onSubmitted()
                dismiss()
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.brandNavy)
        }
    }

    // MARK: - Failed

    private func failedContent(_ store: BulkGradeStore, _ message: String) -> some View {
        ContentUnavailableView {
            Label("Couldn't grade these items", systemImage: "xmark.octagon")
        } description: {
            Text(message)
        } actions: {
            Button("Try again") { Task { await store.load() } }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)
            Button("Close") { dismiss() }
        }
    }

    // MARK: - Helpers

    private func progress(_ label: String) -> some View {
        VStack(spacing: 14) {
            ProgressView().tint(Color.brandNavy)
            Text(label).font(.subheadline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func humanize(_ blocker: String) -> String {
        blocker
            .replacingOccurrences(of: "garment_type", with: "garment type")
            .replacingOccurrences(of: "garment_category", with: "category")
    }
}
