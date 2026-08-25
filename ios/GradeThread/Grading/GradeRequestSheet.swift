import SwiftData
import SwiftUI

/// The certified-grade request flow, presented as a sheet from the item
/// canvas. Walks the reseller through: readiness check → tier choice →
/// submit → live grading → the finished report with a shareable certificate.
struct GradeRequestSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Environment(AuthStore.self) private var authStore
    /// US-981: gate the network-only submit when offline. Optional so the sheet
    /// never crashes if presented outside the shell that injects it.
    @Environment(NetworkMonitor.self) private var networkMonitor: NetworkMonitor?

    /// The item being graded. Updated optimistically on completion so the
    /// canvas + list reflect the new grade before the next sync pull.
    let item: LocalInventoryItem

    // Optional + created in `.task` (main-actor) rather than in the View's
    // init, mirroring ItemCanvasState — constructing a @MainActor store in a
    // View initializer trips main-actor isolation.
    @State private var store: GradeRequestStore?
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
    /// US-980: confirm before a tap spends paid grade credits, so a mis-tap
    /// can't charge real money with no undo. Free/Included grades skip this.
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
                    centeredProgress("Checking this item…")
                }
            }
            .navigationTitle("Certified grade")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(closeButtonTitle) { dismiss() }
                }
            }
            .task {
                if store == nil { store = GradeRequestStore(inventoryItemId: item.id) }
                await store?.load()
            }
            // US-1229: cancel the in-flight submit/poll task when the sheet is
            // dismissed so it stops hitting the status endpoint every backoff
            // interval for the rest of the ~2-minute poll window.
            .onDisappear { store?.stop() }
        }
        .interactiveDismissDisabled(isWorking)
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
                    // US-1522: session expired between opening the sheet and
                    // tapping buy-credits — a re-sign-in prompt, not a blank sheet.
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

    @ViewBuilder
    private func content(_ store: GradeRequestStore) -> some View {
        switch store.phase {
        case .loading:
            centeredProgress("Checking this item…")
        case .ready:
            readyContent(store)
        case .submitting:
            centeredProgress("Submitting for grading…")
        case .processing:
            processingContent(
                title: "Grading in progress",
                message: "Our AI is analyzing the photos. This usually takes a few moments."
            )
        case .stillProcessing:
            stillProcessingContent
        case .completed:
            completedContent(store)
        case .pendingReview:
            pendingReviewContent(store)
        case let .needsPhotos(message):
            needsPhotosContent(store, message)
        case let .failed(message):
            failedContent(store, message)
        }
    }

    private var closeButtonTitle: String {
        switch store?.phase {
        case .completed?, .pendingReview?, .stillProcessing?, .needsPhotos?: return "Done"
        // US-1176: dismissing while polling doesn't abort the grade (it lands via
        // sync), so make that explicit rather than the ambiguous "Cancel".
        case .processing?: return "Continue in background"
        default: return "Cancel"
        }
    }

    /// US-1176: only the initial submit blocks dismissal — once the grade is
    /// accepted and we're polling (.processing), it's already running
    /// server-side and lands via the next sync (as .stillProcessing explains),
    /// so the user shouldn't be trapped waiting out the poll window.
    private var isWorking: Bool {
        switch store?.phase {
        case .submitting?: return true
        default: return false
        }
    }

    // MARK: - Ready (readiness + tier + submit)

    @ViewBuilder
    private func readyContent(_ store: GradeRequestStore) -> some View {
        if let validation = store.validation, let validatedItem = validation.item {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if validatedItem.ready {
                        readyBanner
                    } else {
                        blockersBanner(validatedItem)
                    }

                    tierPicker(store)
                    planSummary(store, user: validation.user)

                    if validation.limitExceeded {
                        creditsBanner(store)
                    }

                    if NetworkMonitor.isOffline(networkMonitor) {
                        OfflineNotice(intent: .blocked, detail: "to request a certified grade")
                    }

                    submitButton(store, user: validation.user)

                    Text("You'll get a 1–10 condition grade across five factors, an AI summary, and a public certificate you can link from your listing.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(20)
            }
            .background(Color(uiColor: .systemGroupedBackground))
        } else {
            centeredProgress("Checking this item…")
        }
    }

    private var readyBanner: some View {
        Label("This item is ready to grade", systemImage: "checkmark.circle.fill")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.brandEmerald)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Color.brandEmerald.opacity(0.10), in: RoundedRectangle(cornerRadius: CornerRadius.control))
    }

    private func blockersBanner(_ validatedItem: GradingValidatedItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Not ready yet", systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.brandAmber)
            ForEach(validatedItem.blockers, id: \.self) { blocker in
                Text("• \(humanize(blocker))")
                    .font(.footnote)
                    .foregroundStyle(.primary)
            }
            if !validatedItem.requiredPhotoTypesMissing.isEmpty {
                Text("Add these photos from the + tab: \(validatedItem.requiredPhotoTypesMissing.map(photoLabel).joined(separator: ", ")).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.brandAmber.opacity(0.10), in: RoundedRectangle(cornerRadius: CornerRadius.control))
    }

    private func tierPicker(_ store: GradeRequestStore) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Service tier")
                .font(.subheadline.weight(.semibold))
            ForEach(GradeTierOption.allCases) { option in
                tierRow(store, option: option)
            }
        }
    }

    private func tierRow(_ store: GradeRequestStore, option: GradeTierOption) -> some View {
        let selected = store.tier == option
        return Button {
            AppRouter.haptic()
            Task { await store.selectTier(option) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Color.brandNavy : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(option.label).font(.subheadline.weight(.semibold))
                        Text(option.turnaround)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    Text(option.blurb)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous)
                    .stroke(selected ? Color.brandNavy : Color.secondary.opacity(0.25), lineWidth: selected ? 2 : 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func planSummary(_ store: GradeRequestStore, user: GradingUserInfo) -> some View {
        VStack(spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(user.includedRemaining) included grade\(user.includedRemaining == 1 ? "" : "s") left")
                        .font(.footnote.weight(.medium))
                    Text("\(user.creditBalance) credit\(user.creditBalance == 1 ? "" : "s") · \(user.plan.capitalized) plan")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(costLabel(store, user: user))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
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
    /// credit packs (10/25/50/100) or change plan. Always visible in the grade
    /// flow so credits are buyable at the point of need (Guideline 3.1.1 — no
    /// steering to an external/web purchase for in-app digital content).
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

    /// Whether this grade spends paid credits (vs. being covered by an
    /// included Standard grade). Drives the spend-confirmation gate.
    private func isPaidGrade(_ store: GradeRequestStore, user: GradingUserInfo) -> Bool {
        !(store.tier == .standard && user.includedRemaining > 0)
    }

    /// What this grade costs the user: free if covered by an included
    /// Standard grade, otherwise the tier's credit cost.
    private func costLabel(_ store: GradeRequestStore, user: GradingUserInfo) -> String {
        if !isPaidGrade(store, user: user) {
            return "Included"
        }
        let credits = store.tier.creditCost
        return "\(credits) credit\(credits == 1 ? "" : "s")"
    }

    private func creditsBanner(_ store: GradeRequestStore) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Not enough grading credits for this tier. Buy a grade credit pack, or pick a cheaper tier.", systemImage: "creditcard.trianglebadge.exclamationmark")
                .font(.caption)
                .foregroundStyle(.primary)
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
    private func creditTopUpControl(_ store: GradeRequestStore) -> some View {
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

    private func submitButton(_ store: GradeRequestStore, user: GradingUserInfo) -> some View {
        let paid = isPaidGrade(store, user: user)
        let credits = store.tier.creditCost
        return Button {
            AppRouter.haptic()
            // US-980: gate a paid spend behind a confirmation; free/Included
            // grades still submit in one tap.
            if paid {
                showSpendConfirm = true
            } else {
                store.submit()
            }
        } label: {
            Label("Get certified grade", systemImage: "checkmark.seal.fill")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.brandNavy)
        .disabled(!store.canSubmit || NetworkMonitor.isOffline(networkMonitor))
        .confirmationDialog(
            "Spend \(credits) credit\(credits == 1 ? "" : "s")?",
            isPresented: $showSpendConfirm,
            titleVisibility: .visible
        ) {
            Button("Grade for \(credits) credit\(credits == 1 ? "" : "s")") {
                store.submit()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This \(store.tier.label) grade will use \(credits) grade credit\(credits == 1 ? "" : "s") from your balance.")
        }
    }

    // MARK: - Processing / still-processing

    private func processingContent(title: String, message: String) -> some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
                .tint(Color.brandNavy)
            Text(title).font(.brandHeadline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var stillProcessingContent: some View {
        ContentUnavailableView {
            Label("Still grading", systemImage: "clock.badge.checkmark")
        } description: {
            Text("This grade is taking a little longer than usual. It'll appear on this item automatically as soon as it's ready — no need to resubmit.")
        } actions: {
            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)
        }
    }

    // MARK: - Pending human review (mandatory review)

    /// The AI grade is produced but withheld until a GradeThread reviewer
    /// finalizes it. We show the provisional score (when returned) and explain
    /// it'll go live automatically — never an endless "grading in progress".
    private func pendingReviewContent(_ store: GradeRequestStore) -> some View {
        ContentUnavailableView {
            Label("Submitted for human review", systemImage: "person.fill.checkmark")
        } description: {
            if let report = store.report {
                Text("Your preliminary grade is \(String(format: "%.1f", report.overallScore)) · \(report.gradeTier). A GradeThread expert is reviewing it before it becomes official — the certificate goes live and the grade appears on this item automatically once review is complete. No need to resubmit.")
            } else {
                Text("\(GradingJourneyCopy.humanReviewWhat) \(GradingJourneyCopy.humanReviewCertificate) \(GradingJourneyCopy.humanReviewCost) It appears on this item automatically once review is done — no need to resubmit.")
            }
        } actions: {
            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)
        }
    }

    // MARK: - Completed

    @ViewBuilder
    private func completedContent(_ store: GradeRequestStore) -> some View {
        if let report = store.report {
            GradeReportView(
                report: report,
                certificateURL: store.certificateURL,
                title: item.title
            )
            .onAppear {
                applyGradeToItem(report, certificateURL: store.certificateURL)
                // US-701: announce the grade so VoiceOver lands on the result
                // instead of silently replacing the progress view.
                A11yAnnounce.screenChanged(
                    focusing: "Grade \(String(format: "%.1f", report.overallScore)) of 10, \(report.gradeTier)")
            }
        } else {
            centeredProgress("Loading report…")
        }
    }

    // MARK: - Needs clearer photos (quality abstention)

    /// The AI declined to grade because a core photo is unusable (commonly an
    /// illegible tag). NOT a failure — no grade or charge resulted; the seller
    /// retakes the flagged photos and resubmits. Distinct, non-alarming styling
    /// (a camera prompt, not a red error octagon) so it reads as actionable
    /// guidance rather than a hard failure.
    private func needsPhotosContent(_ store: GradeRequestStore, _ message: String) -> some View {
        ContentUnavailableView {
            Label("Clearer photos needed", systemImage: "camera.fill")
        } description: {
            Text(message)
        } actions: {
            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)
        }
    }

    // MARK: - Failed

    private func failedContent(_ store: GradeRequestStore, _ message: String) -> some View {
        ContentUnavailableView {
            Label("Couldn't grade this item", systemImage: "xmark.octagon")
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

    private func centeredProgress(_ label: String) -> some View {
        VStack(spacing: 14) {
            ProgressView().tint(Color.brandNavy)
            Text(label).font(.subheadline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Optimistically mirror the new grade onto the cached item so the
    /// canvas + list update immediately. A real sync pull (kicked here)
    /// fills in anything we didn't set.
    ///
    /// US-1209: a low-confidence grade (< ``GradeScale/gradeReviewConfidenceThreshold``)
    /// is routed to a human reviewer server-side, so it is NOT a certified,
    /// shareable result yet. We still surface the score/tier so the report can
    /// render the "flagged for human review" copy, but we hold back the
    /// certificate URL and the "graded" status until review clears — so the
    /// same item can't simultaneously read as "Pending review" and "Certified".
    /// The server merge is authoritative (SyncMergeActor): it likewise won't
    /// supply a `certificate_url`/`status = graded` for an unreviewed grade, so
    /// the next pull keeps the provisional state until the review lands.
    private func applyGradeToItem(_ report: GradeReportDTO, certificateURL: URL?) {
        GradeApplication.stamp(report, certificateURL: certificateURL, onto: item)
        modelContext.saveOrLog("applyGradeToItem")
        NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
    }

    private func humanize(_ blocker: String) -> String {
        blocker
            .replacingOccurrences(of: "garment_type", with: "garment type")
            .replacingOccurrences(of: "garment_category", with: "category")
    }

    private func photoLabel(_ type: String) -> String {
        switch type {
        case "tag": return "tag"
        case "front": return "front"
        case "back": return "back"
        default: return type.replacingOccurrences(of: "_", with: " ")
        }
    }
}
