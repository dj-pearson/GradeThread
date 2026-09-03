import GradeThreadCore
import SwiftUI

/// US-1522: a listing URL is presentable only when it's non-empty and parses to a
/// real URL — otherwise "View on eBay" is disabled and the Safari sheet never
/// opens blank. File-private free function so both PublishDialog (the response
/// section + Safari sheet) and any nested view can call it without a struct-scope
/// mismatch.
private func validListingURL(_ raw: String) -> URL? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : URL(string: trimmed)
}

/// End-to-end publish flow shown as a sheet from ItemCanvasView.
/// State machine: validating → review (blockers OR summary card) →
/// pushing → success (listing URL + open) | failure (error + retry).
struct PublishDialog: View {
    @Environment(\.dismiss) private var dismiss
    /// Optional so the dialog never crashes if presented outside the shell that
    /// injects it (previews/tests). Drives the offline pre-check (US-1006).
    @Environment(NetworkMonitor.self) private var networkMonitor: NetworkMonitor?

    let inventoryItemId: String
    /// Cost basis for the live profit estimate in the composer (nil when unknown).
    var acquiredCost: Double? = nil
    /// Relist mode: the item was previously listed (ended draft, or a still-live
    /// listing being replaced). Sends `relist` to the push so a live listing is
    /// ended first and a brand-new one is created.
    var relist: Bool = false
    /// True when the item still has a LIVE eBay listing. Shows a warning that
    /// relisting ends the current listing and creates a new one.
    var listingActive: Bool = false
    let onPublished: (PushResponse) -> Void

    @State private var phase: Phase = .validating
    /// US-1648: guards `onPublished` to fire exactly once for a successful
    /// publish regardless of how the sheet is dismissed (Done / Close / swipe).
    @State private var didNotifyPublished = false
    @State private var showingSafari = false
    /// US-828/US-1511: aspect values the server will omit from the eBay payload
    /// (value-validation), shown as composer warnings. Set by runValidate.
    @State private var aspectWarnings: [String] = []
    /// US-1890/US-1896/US-1974: advisory title-quality + picture-standards
    /// findings from the pre-flight. Non-blocking (unlike `.blocked`), but the
    /// seller should see them while they can still act. Set by runValidate.
    @State private var qualityWarnings: [String] = []
    /// US-1895/US-1974: recommended-aspect coverage for the composer meter.
    @State private var recommendedCoverage: AspectCoverage?
    /// US-1897 (AC5): the server-computed Listing Quality Score + breakdown from
    /// the same pre-flight. Advisory — it never gates the push; a blocked score
    /// only ever reflects a blocker the `blockers` array already reports.
    @State private var qualityScore: ListingQualityScore?
    /// US-1513: the composer reported edits that differ from the validated
    /// summary. Ratchets up only (a revert-to-original stays true) and resets on
    /// a fresh validate — conservative on purpose, so a resumed composer that
    /// re-seeds from the merged summary keeps its swipe guard.
    @State private var composerDirty = false
    /// US-1513: Close tapped while the composer holds unsaved edits — confirm
    /// before discarding instead of silently dropping what the seller typed.
    @State private var showingCloseConfirmation = false
    /// US-1972: what the composer currently holds, so the close confirmation can
    /// offer to SAVE the edits instead of only discarding them. Kept up to date
    /// by the form (see ``ComposerSnapshot``).
    @State private var composerSnapshot: ComposerSnapshot?
    /// US-1970/US-1971: the draft's saved Best Offer + schedule choices, fetched
    /// alongside validate so the composer's controls seed synchronously in
    /// `ComposerForm.init` (an async post-init seed would trip the dirty ratchet).
    @State private var draftSettings: ListingDraftSettings = .none
    /// US-1972: bumped after a successful save so the composer re-inits and
    /// re-baselines its dirty check against what's now persisted.
    @State private var composerGeneration = 0
    /// US-1972: transient "Draft saved" / "Scheduled for …" confirmation.
    @State private var saveBanner: String?
    @State private var isSaving = false
    /// US-1972: a save failure is shown inline — it must NOT tear down the
    /// composer (the seller's edits are still in the form and still savable).
    @State private var saveError: String?
    private let service = EbayPublishService()
    private let draftService = ListingDraftService()

    private enum Phase: Equatable {
        case validating
        case readyToPush(PublishSummary)
        case blocked([String])
        case pushing
        case succeeded(PushResponse)
        case failed(message: String, retry: RetryAction)
    }

    /// What the failure card's "Try again" does. A failure during the
    /// validate phase re-runs validation from scratch; a failure during the
    /// push phase resumes the composer with the user's edits intact so a
    /// transient blip never restarts at `runValidate` and wipes them (US-1006).
    private enum RetryAction: Equatable {
        case revalidate
        case resumeComposer(PublishSummary)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                content
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
            .navigationTitle(relist ? "Relist on eBay" : "Publish to eBay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        // US-1513: typed-but-unpushed edits get a confirm; every
                        // other phase closes immediately as before.
                        if case .readyToPush = phase, composerDirty {
                            showingCloseConfirmation = true
                        } else {
                            // US-1648: apply a successful publish before closing so
                            // Close (like Done) doesn't leave the item 'unpublished'.
                            notifyPublishedIfNeeded()
                            dismiss()
                        }
                    }
                    .disabled(phase == .pushing)
                }
            }
        }
        // US-1513: a swipe-down used to discard typed title/note/description —
        // and worse, dismiss MID-PUSH (Close is disabled but the gesture wasn't):
        // the push continued server-side but `onPublished` never ran, so the item
        // looked unpublished until the next sync. EbaySyncModal pattern.
        .interactiveDismissDisabled(interactiveDismissBlocked)
        // US-1648: swipe-to-dismiss on a success card skips the Done button, so
        // back-stop onPublished here (one-shot) — otherwise a swiped-away success
        // leaves the item locally unpublished (US-1513 desync).
        .onDisappear { notifyPublishedIfNeeded() }
        // US-1972: closing used to offer only Discard/Keep-editing, so a typed
        // description, condition note, or promo choice was lost unless the seller
        // saw a publish all the way through. Save is now the first (and default)
        // option whenever the composer's edits are actually savable.
        .confirmationDialog(
            "Save your edits?",
            isPresented: $showingCloseConfirmation,
            titleVisibility: .visible
        ) {
            if let snapshot = composerSnapshot, snapshot.canSave,
               case let .readyToPush(summary) = phase {
                Button("Save & close") {
                    Task { await saveAndClose(edits: snapshot.edits, summary: summary) }
                }
            }
            Button("Discard & close", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text(closeConfirmationMessage)
        }
        .task { await runValidate() }
        // US-1972: transient save confirmation — the FlipDesk actionBanner
        // convention (brandNavy capsule, 2.5s auto-dismiss via `.task(id:)`).
        .overlay(alignment: .bottom) { saveBannerView }
        .task(id: saveBanner) {
            guard saveBanner != nil else { return }
            try? await Task.sleep(for: .seconds(2.5))
            saveBanner = nil
        }
        .sheet(isPresented: $showingSafari) {
            if case let .succeeded(response) = phase,
               let url = validListingURL(response.listingURL) {
                SafariView(url: url)
            }
        }
    }

    /// US-1648: fire `onPublished` exactly once for a successful publish, no
    /// matter which dismiss path runs (Done, toolbar Close, or swipe) — so the
    /// item's optimistic local apply always runs and it's never left showing
    /// 'unpublished' after it actually published (US-1513 desync).
    private func notifyPublishedIfNeeded() {
        guard !didNotifyPublished, case let .succeeded(response) = phase else { return }
        didNotifyPublished = true
        onPublished(response)
    }

    /// US-1513: swipe-to-dismiss is blocked while a push is in flight (dismissal
    /// mid-push orphans `onPublished`) or while the composer holds unsaved edits.
    /// Success/blocked/failure cards stay swipe-dismissable — they all have
    /// explicit buttons and nothing typed left to lose.
    private var interactiveDismissBlocked: Bool {
        if phase == .pushing { return true }
        if case .readyToPush = phase { return composerDirty }
        return false
    }

    /// US-1972: name what each close option costs. When the edits can't be saved
    /// as they stand (no title, no price, contradictory Best Offer) there's no
    /// Save button to explain — so say why it isn't on offer rather than leave
    /// the seller looking for it.
    private var closeConfirmationMessage: String {
        if composerSnapshot?.canSave == true {
            return "Saving keeps your edits on the draft so you can publish later. Discarding loses them."
        }
        return "Your edits can\u{2019}t be saved yet — keep editing to fix what\u{2019}s flagged, or discard them."
    }

    @ViewBuilder
    private var saveBannerView: some View {
        if let saveBanner {
            Text(saveBanner)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.brandNavy, in: Capsule())
                .padding(.bottom, 20)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityAddTraits(.isStaticText)
        }
    }

    // MARK: - Phase bodies

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .validating:
            // US-692: initial content load → skeleton, not a bare spinner.
            validatingSkeleton

        case .readyToPush(let summary):
            ComposerForm(
                summary: summary,
                inventoryItemId: inventoryItemId,
                acquiredCost: acquiredCost,
                pushLabel: relist ? "Relist on eBay" : "Push to eBay",
                showRelistWarning: listingActive,
                aspectWarnings: aspectWarnings,
                qualityWarnings: qualityWarnings,
                recommendedCoverage: recommendedCoverage,
                qualityScore: qualityScore,
                draftSettings: draftSettings,
                isSaving: isSaving,
                saveError: saveError,
                onDirty: { composerDirty = true },
                onSnapshot: { composerSnapshot = $0 },
                onSave: { edits in
                    Task { await runSaveDraft(edits: edits, summary: summary) }
                },
                onPush: { edits in
                    Task { await runPush(edits: edits, summary: summary) }
                }
            )
            // US-1972: re-init (and so re-seed + re-baseline) the composer after
            // a save persists new Best Offer / schedule values.
            .id(composerGeneration)

        case .blocked(let blockers):
            blockersCard(blockers)

        case .pushing:
            loadingCard(text: "Sending to eBay…")

        case .succeeded(let response):
            successCard(response)

        case .failed(let message, let retry):
            failureCard(message: message, retry: retry)
        }
    }

    // MARK: - Reusable card builders

    /// US-692: skeleton of the composer form while the publish pre-flight runs,
    /// instead of a centered spinner.
    private var validatingSkeleton: some View {
        VStack(alignment: .leading, spacing: 16) {
            SkeletonLine(widthFraction: 0.4, height: 14)
            SkeletonBlock(cornerRadius: CornerRadius.control).frame(height: 44)
            SkeletonLine(widthFraction: 0.55, height: 14)
            SkeletonBlock(cornerRadius: CornerRadius.control).frame(height: 88)
            SkeletonBlock(cornerRadius: CornerRadius.control).frame(height: 44)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("Checking the listing")
    }

    private func loadingCard(text: String) -> some View {
        VStack(spacing: 12) {
            ProgressView().tint(Color.brandNavy).scaleEffect(1.2)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .cardStyle(.flush)
    }

    private func summaryCard(_ summary: PublishSummary) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Ready to publish")
                .font(.brandHeadline)
            Group {
                LabeledContent("Title", value: summary.title)
                if let condition = summary.condition {
                    LabeledContent("Condition", value: humanCondition(condition))
                }
                LabeledContent("Price") {
                    Text("\(summary.currency ?? "USD") \(MoneyFieldValidation.twoDecimalDisplay(summary.priceValue))")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.brandNavy)
                }
            }
            .font(.subheadline)
            Divider()
            Text("Description preview")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(summary.description)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(8)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }

    private func blockersCard(_ blockers: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Fix these before pushing", systemImage: "exclamationmark.triangle.fill")
                .font(.brandHeadline)
                .foregroundStyle(.brandAmber)
            ForEach(Array(blockers.enumerated()), id: \.offset) { _, blocker in
                Label(blocker, systemImage: "circle.fill")
                    .labelStyle(.titleAndIcon)
                    .font(.subheadline)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.secondary)
            }
            // US-1897 (AC5): the breakdown belongs here most of all — a blocked
            // listing is capped at 40, and this is the only place that says
            // WHICH surface fixes each thing costing it points.
            if let score = qualityScore {
                Divider().padding(.vertical, 2)
                QualityScoreCard(score: score)
            }
            Button("Close") { dismiss() }
                .font(.subheadline.weight(.semibold))
                .padding(.top, 4)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }

    private func successCard(_ response: PushResponse) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .scaledIconFont(size: 48)  // US-1152: scale with Dynamic Type
                .foregroundStyle(.brandEmerald)
            Text("Live on eBay")
                .font(.brandTitle2)
            Text("Listing \(response.listingId)")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            if response.syncPending {
                // US-783/US-1511: the listing IS live but the local bookkeeping
                // write was queued for the next sync — without this line the item
                // not flipping to "listed" in-app reads as a failed publish.
                Label(
                    "It\u{2019}s live on eBay — FlipDesk is finishing the sync here, so it may take a moment to show as listed.",
                    systemImage: "clock.arrow.2.circlepath"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
                .accessibilityElement(children: .combine)
            }
            HStack(spacing: 10) {
                Button {
                    showingSafari = true
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "safari")
                        Text("View on eBay")
                    }
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.brandNavy)
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
                }
                // US-1522: don't offer "View on eBay" when the listing URL is
                // missing/invalid — the Safari sheet would present blank.
                .disabled(validListingURL(response.listingURL) == nil)
                Button {
                    notifyPublishedIfNeeded()
                    dismiss()
                } label: {
                    Text("Done")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Color.secondary.opacity(0.15))
                        .foregroundStyle(.primary)
                        .clipShape(Capsule())
                }
            }
            // US-1061: first-publish "manage in FlipDesk" disclaimer. Self-hides
            // once dismissed (server-side flag on the users row, per user).
            EbayPublishDisclaimerCard()
        }
        .padding(20)
        .frame(maxWidth: .infinity)
        .cardStyle(.flush)
    }

    private func failureCard(message: String, retry: RetryAction) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "xmark.octagon.fill")
                .scaledIconFont(size: 40)  // US-1152: scale with Dynamic Type
                .foregroundStyle(.red)
            Text("Publish failed")
                .font(.brandHeadline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 10) {
                Button("Try again") {
                    switch retry {
                    case .revalidate:
                        Task { await runValidate() }
                    case .resumeComposer(let summary):
                        // Restore the composer pre-filled with the user's edits
                        // instead of re-validating from scratch (US-1006).
                        phase = .readyToPush(summary)
                    }
                }
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.brandNavy)
                .foregroundStyle(.white)
                .clipShape(Capsule())

                Button("Close") { dismiss() }
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.secondary.opacity(0.15))
                    .foregroundStyle(.primary)
                    .clipShape(Capsule())
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity)
        .cardStyle(.flush)
    }

    private func primaryButton(label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(Color.brandNavy)
                .foregroundStyle(.white)
                .clipShape(Capsule())
        }
    }

    // MARK: - Flow

    private func runValidate() async {
        phase = .validating
        // US-1513: a fresh validate rebuilds the composer from the server truth,
        // so the dirty ratchet starts over.
        composerDirty = false
        saveError = nil
        // US-1970/US-1971: fetch the draft's saved Best Offer + schedule
        // concurrently with validate — the composer seeds from both at once, so
        // serializing them would just add a round-trip to the skeleton. A failed
        // read degrades to `.none` (the summary's own defaults), never blocks.
        async let settings = try? draftService.fetchSettings(inventoryItemId: inventoryItemId)
        let outcome = await service.validate(inventoryItemId: inventoryItemId)
        draftSettings = await settings ?? .none
        switch outcome {
        case .validated(let response):
            // US-828/US-1511: warnings ride alongside the summary — they don't
            // block, but the seller should see "X won't be sent" BEFORE pushing.
            aspectWarnings = (response.aspectDiagnostics ?? []).map(\.warningLine)
            // US-1974: the server's advisory title-quality / picture findings and
            // recommended-specifics coverage ride along the same way — the edge
            // has always sent them; iOS dropped them in the decoder.
            qualityWarnings = response.warnings ?? []
            recommendedCoverage = response.recommendedCoverage
            // US-1897 (AC5): the score rides the same response. Set BEFORE the
            // branch below so it is available on the blocked path too — a
            // blocked listing is exactly the one whose breakdown names the fix.
            qualityScore = response.qualityScore
            if response.blockers.isEmpty, let summary = response.summary {
                phase = .readyToPush(summary)
            } else {
                phase = .blocked(response.blockers)
            }
        case .blockers(let blockers):
            phase = .blocked(blockers)
        case .noOfferId:
            phase = .failed(
                message: "No active eBay offer linked. Sync from Marketplaces, then try again.",
                retry: .revalidate
            )
        case .planLimit(let message):
            phase = .failed(message: message, retry: .revalidate)
        case .failed(let message):
            phase = .failed(message: message, retry: .revalidate)
        case .pushed, .priceUpdated, .ended:
            // Wrong outcome shape for validate — shouldn't happen.
            phase = .failed(message: "Unexpected response from server.", retry: .revalidate)
        }
    }

    /// US-1972: persist the composer's edits WITHOUT publishing — the standalone
    /// "Save draft" action, and the commit step for a scheduled publish (US-1971:
    /// scheduling saves `scheduled_publish_at` and lets the scheduled-publish
    /// worker do the push when it's due, so there's deliberately no push here).
    ///
    /// Unlike a failed push this never changes `phase`: the composer stays up
    /// with the seller's edits intact and the error inline, because a failed save
    /// is retryable in place and tearing the form down would lose the edits.
    ///
    /// Returns whether the draft actually persisted, so ``saveAndClose`` only
    /// dismisses on a real save.
    @discardableResult
    private func runSaveDraft(edits: ComposerEdits, summary: PublishSummary) async -> Bool {
        guard !isSaving else { return false }

        // The draft write goes straight to Supabase (no offline queue on this
        // path), so a doomed round-trip is worth pre-empting.
        if let networkMonitor, !networkMonitor.isConnected {
            saveError = "You're offline. Your edits are still here — reconnect and save again."
            HapticFeedback.warning()
            return false
        }

        isSaving = true
        saveError = nil
        defer { isSaving = false }

        let editedPrice = edits.price.trimmingCharacters(in: .whitespacesAndNewlines)
        let priceValue = editedPrice.isEmpty ? summary.priceValue : editedPrice

        do {
            try await draftService.saveDraft(
                inventoryItemId: inventoryItemId,
                priceValue: priceValue,
                edits: edits
            )
        } catch {
            saveError = FriendlyErrorCopy.actionMessage(
                for: error,
                fallback: "Couldn't save your draft. Please try again."
            )
            HapticFeedback.error()
            return false
        }

        // Advance the baseline to what we just wrote, so the composer re-seeds
        // from the truth and a subsequent save computes its schedule edit
        // against the NEW value rather than re-writing (or re-clearing) it.
        draftSettings = draftSettings.applying(edits)
        phase = .readyToPush(PublishSummary.merging(edits, into: summary))
        composerDirty = false
        composerGeneration += 1
        saveBanner = Self.saveConfirmation(for: edits.schedule, settings: draftSettings)
        HapticFeedback.success()
        Telemetry.breadcrumb("Saved listing draft", category: "publish")
        return true
    }

    /// US-1972: "Save & close" from the close confirmation. A FAILED save leaves
    /// the composer up with its error inline rather than closing — closing on a
    /// failure would lose exactly the edits the seller tapped Save to keep.
    private func saveAndClose(edits: ComposerEdits, summary: PublishSummary) async {
        if await runSaveDraft(edits: edits, summary: summary) {
            dismiss()
        }
    }

    /// The confirmation copy for a save — naming the scheduled instant when one
    /// is set, so "Schedule publish" visibly did something.
    private static func saveConfirmation(
        for schedule: ComposerScheduleEdit,
        settings: ListingDraftSettings
    ) -> String {
        if let scheduled = settings.scheduledPublishAt, schedule != .clear {
            let when = ScheduledDropScheduling.formatInZone(
                scheduled, timeZoneIdentifier: ScheduledDropScheduling.detectTimezone()
            )
            return "Scheduled to publish \(when)"
        }
        return "Draft saved"
    }

    private func runPush(edits: ComposerEdits, summary: PublishSummary) async {
        // US-1497: entry guard — a second push while one is already in flight is
        // dropped. In relist mode each push ends+recreates the live listing, so a
        // double-tap would create a duplicate live listing (watchers reset). The
        // composer also folds a synchronous `isPushing` into `pushDisabled`; this
        // is the defense in depth for the async window before that flips.
        guard phase != .pushing else { return }
        // The composer state we restore if a transient failure forces a retry,
        // so the user never re-types title/condition/description (US-1006).
        let resume = RetryAction.resumeComposer(PublishSummary.merging(edits, into: summary))

        // Offline pre-check: don't fire a doomed round-trip. Surface friendly
        // offline copy and let "Try again" resume the composer with edits intact
        // (saveDraft hasn't run yet, so nothing is lost — they live in `resume`).
        if let networkMonitor, !networkMonitor.isConnected {
            phase = .failed(
                message: "You're offline. Your edits are kept here — reconnect and tap Try again.",
                retry: resume
            )
            HapticFeedback.warning()
            return
        }

        phase = .pushing
        Telemetry.breadcrumb("Publishing to eBay", category: "publish")

        // US-1242: prefer an inline price fix over the (possibly zero) summary
        // price so a draft published with no price set on the canvas can be
        // corrected right here instead of dead-ending.
        let editedPrice = edits.price.trimmingCharacters(in: .whitespacesAndNewlines)
        let priceValue = editedPrice.isEmpty ? summary.priceValue : editedPrice

        // Persist composer edits to the listings draft first; the push
        // re-reads the publish context server-side, so these reach eBay.
        do {
            try await ListingDraftService().saveDraft(
                inventoryItemId: inventoryItemId,
                priceValue: priceValue,
                edits: edits
            )
        } catch {
            // Keep the user's edits on retry — a transient save failure must not
            // wipe what they typed (US-1006). FriendlyErrorCopy maps offline/raw
            // URLError failures to friendly copy.
            phase = .failed(
                message: FriendlyErrorCopy.actionMessage(
                    for: error,
                    fallback: "Couldn't save your edits. Please try again."
                ),
                retry: resume
            )
            HapticFeedback.error()
            return
        }

        // US-1970/US-1971: the edits are now persisted, so advance the baseline.
        // If the push below fails, "Try again" rebuilds the composer — which
        // re-seeds its Best Offer boxes from these settings. Leaving them stale
        // would revert the seller's typed thresholds on retry (US-1006).
        draftSettings = draftSettings.applying(edits)

        let outcome = await service.push(inventoryItemId: inventoryItemId, relist: relist)
        switch outcome {
        case .pushed(let response):
            phase = .succeeded(response)
            HapticFeedback.success()
            Telemetry.breadcrumb(
                "Publish succeeded \(response.listingId)",
                category: "publish"
            )
            Telemetry.event(TelemetryEvent.listingPublished, props: [
                "listing_id": response.listingId,
            ])
            // US-199: a successful publish is the canonical "user got
            // value" moment — record it for the review-prompt gate and
            // optionally fire SKStoreReviewController.
            ReviewPromptService.shared.recordPublish()
            ReviewPromptService.shared.maybePrompt()
        case .blockers(let blockers):
            // A genuine 422 still routes to the blockers card (US-1006 AC3).
            phase = .blocked(blockers)
            HapticFeedback.warning()
        case .noOfferId:
            phase = .failed(
                message: "eBay couldn't link the offer. Try again or check Marketplaces.",
                retry: resume
            )
            HapticFeedback.error()
        case .planLimit(let message):
            // Plan/usage cap (US-805) — surface the upgrade copy; "Try again"
            // resumes the composer so edits aren't lost if they upgrade.
            phase = .failed(message: message, retry: resume)
            HapticFeedback.warning()
        case .failed(let message):
            phase = .failed(message: message, retry: resume)
            HapticFeedback.error()
        case .validated, .priceUpdated, .ended:
            phase = .failed(message: "Unexpected response from server.", retry: resume)
            HapticFeedback.error()
        }
    }

    private func humanCondition(_ raw: String) -> String {
        raw.split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }
}

/// Editable publish composer shown in the `readyToPush` phase. Pre-fills
/// from the server's ``PublishSummary``; lets the user tune the eBay title
/// (80-char cap), condition, condition note, and description before the
/// push. The edits flow back to the parent, which persists them to the
/// listings draft + pushes.
private struct ComposerForm: View {
    let summary: PublishSummary
    let inventoryItemId: String
    let acquiredCost: Double?
    /// Label for the primary action button (e.g. "Push to eBay" / "Relist on eBay").
    var pushLabel: String = "Push to eBay"
    /// When true, show a banner warning that the item is still live and
    /// relisting ends the current listing + creates a new one.
    var showRelistWarning: Bool = false
    /// US-828/US-1511: "X won't be sent" lines from the validate pre-flight —
    /// non-blocking, but the seller should see them before committing.
    var aspectWarnings: [String] = []
    /// US-1890/US-1896/US-1974: advisory title-quality + picture-standards
    /// findings from the pre-flight. Rendered as guidance beside the title, NOT
    /// as blockers — publishing stays available with every one of them showing.
    var qualityWarnings: [String] = []
    /// US-1895/US-1974: recommended-specifics coverage for the meter. Nil (or
    /// `total == 0`) when the server couldn't resolve the category spec, in
    /// which case the meter stays hidden rather than reading a misleading 0/0.
    var recommendedCoverage: AspectCoverage?
    /// US-1897 (AC5): the 0–100 Listing Quality Score + component breakdown from
    /// the pre-flight. Nil when an older edge omitted it, in which case the card
    /// stays hidden rather than rendering a confident zero.
    var qualityScore: ListingQualityScore?
    /// US-1970/US-1971: the draft's saved Best Offer + schedule, used to seed
    /// those controls from the seller's own choices rather than the server's
    /// resolved suggestion (see ``ListingDraftSettings``).
    var draftSettings: ListingDraftSettings = .none
    /// US-1972: a save is in flight — disables both commit buttons.
    var isSaving: Bool = false
    /// US-1972: inline save failure, shown without tearing the composer down.
    var saveError: String?
    /// US-1513: fired (once or more) when the composer's fields first differ
    /// from the validated summary — the parent uses it to block swipe-dismiss.
    var onDirty: () -> Void = {}
    /// US-1972: reports what the form holds after every edit, so the parent's
    /// close confirmation can offer to save it.
    var onSnapshot: (ComposerSnapshot) -> Void = { _ in }
    /// US-1971/US-1972: persist the edits without publishing.
    let onSave: (ComposerEdits) -> Void
    let onPush: (ComposerEdits) -> Void

    /// US-981: proactively gate the push button when offline so it shows an
    /// offline state rather than firing a doomed round-trip (the parent's
    /// `runPush` keeps a tap-time backstop for the flap-mid-tap case).
    @Environment(NetworkMonitor.self) private var networkMonitor: NetworkMonitor?
    /// US-1972: drives the background autosave (see ``autosaveOnBackground``).
    @Environment(\.scenePhase) private var scenePhase

    @State private var title: String
    @State private var condition: EbayCondition
    @State private var conditionDescription: String
    @State private var description: String
    /// US-1242: editable price, seeded from the validated summary. When the draft
    /// has no usable price the seller can set it inline here instead of being
    /// bounced to the canvas; otherwise the price stays read-only (the canvas is
    /// its home) and this just mirrors the summary value.
    @State private var priceInput: String
    /// US-1512: Promoted Listings disclosure. Every publish otherwise silently
    /// attaches an ad at the server-resolved rate — the seller sees (and can
    /// adjust or opt out of) that rate here, mirroring the web composer (US-561).
    /// Seeded from `summary.promotedAdRate` (nil = previously opted out).
    @State private var promoteEnabled: Bool
    @State private var promoRateText: String
    /// US-1970: Best Offer toggle + the two auto-clear threshold boxes.
    /// US-2405: a blank box means NO threshold — the offer waits for the seller.
    /// Nothing is suggested or derived on their behalf.
    @State private var bestOffer: ComposerBestOffer
    /// US-1971: scheduled publish. Off = publish immediately on Push.
    @State private var scheduleEnabled: Bool
    @State private var scheduleDate: Date
    /// US-1975: listing format (fixed price / auction), the auction terms, and
    /// the multi-variant matrix. The server has consumed all of these since
    /// US-568; iOS had no UI for them, so every iOS publish was a fixed-price
    /// single-variant listing regardless of what the draft said.
    @State private var formatChoice: ComposerFormatChoice

    // US-1497: synchronous in-flight guard (the CounterOfferSheet isSubmitting
    // pattern). Set true on tap BEFORE `onPush`, so the button disables in the
    // same run loop and a fast second tap can't fire a second push (which in
    // relist mode would end+recreate the live listing → duplicate/watcher reset).
    // No manual reset: this form is torn down the moment the push starts (the
    // parent switches to the `.pushing` card) and rebuilt fresh on any retry.
    @State private var isPushing = false

    // US-1264: template-applied fields that aren't free-text composer inputs.
    // They're set by `apply(_:)` and ride along in `ComposerEdits` so the push's
    // saveDraft persists them onto the listing draft (matching AutoLister, which
    // applies the same template fields server-side). Empty/nil = no template
    // applied, so the draft's existing values are left untouched.
    @State private var templateItemSpecifics: [String: String] = [:]
    @State private var templateCategoryId: String?
    @State private var templateReturnPolicyId: String?
    @State private var templateShippingPolicyId: String?
    @State private var templatePaymentPolicyId: String?

    // ── US-3102: per-listing business policies and quantity ─────────────────
    //
    // The three ids above already reach the draft (`ComposerEdits`) and publish
    // has always honoured them — they were only ever SET by an applied
    // template. So changing shipping for one heavy item meant leaving the phone.
    /// Loaded policies, nil until the first read finishes.
    @State private var policies: EbayPoliciesResponse?
    @State private var policiesError: String?
    @State private var isSyncingPolicies = false
    /// US-3102: units to list. Fixed-price, single-SKU listings only — a
    /// variation matrix carries a quantity per variant already.
    @State private var quantity: Int

    /// US-969: keyboard Next/Return traversal across the editable text fields
    /// (the condition Picker and read-only price are skipped).
    @FocusState private var focusedField: Field?
    private enum Field: Hashable {
        case title, conditionNote, description, price
        // US-1970: the two Best Offer threshold boxes (.decimalPad — no Return
        // key, so they rely on the form's shared keyboard Done toolbar).
        case bestOfferAccept, bestOfferDecline
        // US-1975: the auction term boxes (also .decimalPad).
        case auctionStart, auctionReserve, auctionBuyItNow
    }

    /// US-1242: the validated summary had no usable price (zero/blank/unparseable),
    /// so the composer offers inline price entry. Computed from the immutable
    /// summary so the inline field doesn't vanish the moment a valid price is typed.
    private var summaryPriceMissing: Bool {
        Money.cents(CurrencyFormatter().parse(summary.priceValue) ?? 0) <= 0
    }

    /// Current effective price is still not a positive amount (gates Push).
    private var priceInvalid: Bool {
        Money.cents(CurrencyFormatter().parse(priceInput) ?? 0) <= 0
    }

    // AI copy generation.
    @State private var isGenerating = false
    @State private var aiError: String?
    private let copyService: ListingCopyGenerating = ListingCopyService()

    // US-1167: surface eBay comp context right at the publish decision (the
    // price is set on the canvas, so this is an informational sanity-check).
    @State private var comps: CompStats?
    @State private var compsLoaded = false

    private func loadComps() async {
        guard !compsLoaded else { return }
        compsLoaded = true
        // US-1237: scope the comp lookup to the LIVE composer title (what the
        // seller is actually about to publish) plus the item's brand/size — the
        // same dimensions the item-canvas comps search uses — instead of the
        // server summary title with nil brand/size, which over-broadens results.
        let lookupTitle = trimmedTitle.isEmpty ? summary.title : trimmedTitle
        if let lookup = try? await CompsService().lookup(
            title: lookupTitle, brand: summary.brand, size: summary.size
        ) {
            comps = lookup.stats
        }
    }

    /// US-1507: resolve which eBay store this publish will list on. Only shown
    /// when more than one store is connected — single-store sellers don't need
    /// telling. Mirrors BulkPricingStore.loadAccountContext (US-1216).
    private func loadPublishAccountNote() async {
        guard let accounts = try? await BulkPricingService().ebayAccounts(),
              accounts.count > 1,
              let name = (accounts.first(where: \.isPrimary) ?? accounts.first)?.displayName
        else { return }
        publishAccountNote = showRelistWarning
            ? "The new listing goes live on \(name) (your primary store). Change it in Marketplaces \u{2192} eBay accounts."
            : "This will list on \(name) (your primary store). Change it in Marketplaces \u{2192} eBay accounts."
    }

    /// US-1167 / type-check budget: build the comp line outside the view body so
    /// the (large) ComposerForm body stays simple. Returns nil when there are no
    /// usable comps.
    private var compContextLabel: String? {
        guard let stats = comps, stats.count > 0, let median = stats.median else { return nil }
        // US-1237: format the median through the currency-aware formatter, pinned
        // to the COMP's currency (eBay returns it in the marketplace currency),
        // so it never renders with the wrong symbol.
        let amount = CurrencyFormatter(currencyCode: stats.currency).formatDisplay(median)
        let plural = stats.count == 1 ? "" : "s"
        // US-1237: the price beside this line is in the listing's currency. If the
        // comp currency differs we must NOT imply a direct comparison — flag the
        // comp currency explicitly so the seller reads it as a different unit.
        let listingCurrency = summary.currency ?? "USD"
        if stats.currency != listingCurrency {
            return "Active comps (\(stats.currency)): median \(amount) across \(stats.count) listing\(plural)"
        }
        return "Active comps: median \(amount) across \(stats.count) listing\(plural)"
    }

    // US-1507: multi-store sellers — name the eBay store this publish targets.
    // Publishing always resolves the PRIMARY connection (per-listing threading
    // only applies to listings that already exist), so without this note a
    // seller with two stores can unknowingly list on the wrong one. Same
    // US-1216 pattern (and account source) as the bulk-pricing editor;
    // best-effort — a lookup failure just leaves the banner hidden.
    @State private var publishAccountNote: String?

    // US-674: listing templates, selectable to pre-fill the draft.
    @State private var templateStore = TemplateStore()
    /// US-3102: the policy list behind the three pickers. Shared, so opening the
    /// composer twice in one session costs one load.
    private let policiesService: EbayPoliciesProviding = EbayPoliciesService.shared
    /// US-972: a template the user picked that would overwrite existing content,
    /// pending confirmation before it's applied.
    @State private var pendingTemplate: ListingTemplate?

    /// US-1974: one definition of eBay's cap, shared with the title-quality meter.
    private static let titleLimit = ComposerTitleQuality.limit

    init(
        summary: PublishSummary,
        inventoryItemId: String,
        acquiredCost: Double?,
        pushLabel: String = "Push to eBay",
        showRelistWarning: Bool = false,
        aspectWarnings: [String] = [],
        qualityWarnings: [String] = [],
        recommendedCoverage: AspectCoverage? = nil,
        qualityScore: ListingQualityScore? = nil,
        draftSettings: ListingDraftSettings = .none,
        isSaving: Bool = false,
        saveError: String? = nil,
        onDirty: @escaping () -> Void = {},
        onSnapshot: @escaping (ComposerSnapshot) -> Void = { _ in },
        onSave: @escaping (ComposerEdits) -> Void,
        onPush: @escaping (ComposerEdits) -> Void
    ) {
        self.summary = summary
        self.inventoryItemId = inventoryItemId
        self.acquiredCost = acquiredCost
        self.pushLabel = pushLabel
        self.showRelistWarning = showRelistWarning
        self.aspectWarnings = aspectWarnings
        self.qualityWarnings = qualityWarnings
        self.recommendedCoverage = recommendedCoverage
        self.qualityScore = qualityScore
        self.draftSettings = draftSettings
        self.isSaving = isSaving
        self.saveError = saveError
        self.onDirty = onDirty
        self.onSnapshot = onSnapshot
        self.onSave = onSave
        self.onPush = onPush
        _title = State(initialValue: String(summary.title.prefix(Self.titleLimit)))
        _condition = State(initialValue: EbayCondition.resolve(summary.condition))
        _conditionDescription = State(initialValue: summary.conditionDescription ?? "")
        _description = State(initialValue: summary.description)
        _priceInput = State(initialValue: summary.priceValue)
        _promoteEnabled = State(initialValue: summary.promotedAdRate != nil)
        _promoRateText = State(initialValue: Self.seedRateText(summary.promotedAdRate))
        // US-1970: the toggle mirrors the resolved publish; the threshold boxes
        // seed ONLY from the seller's saved overrides. Seeding them from the
        // summary's resolved values would pin a comp-derived suggestion into the
        // override column the moment the seller saved anything at all.
        _bestOffer = State(initialValue: ComposerBestOffer(
            enabled: summary.bestOfferEnabled,
            autoAcceptText: Self.seedCentsText(draftSettings.autoAcceptCents),
            autoDeclineText: Self.seedCentsText(draftSettings.autoDeclineCents)
        ))
        // US-1971: an already-scheduled draft reopens with its schedule showing.
        _scheduleEnabled = State(initialValue: draftSettings.scheduledPublishAt != nil)
        _scheduleDate = State(initialValue: draftSettings.scheduledPublishAt ?? Self.defaultScheduleDate())
        _formatChoice = State(
            initialValue: Self.seededFormatChoice(summary: summary, settings: draftSettings)
        )
        // US-3102: the draft's own quantity when it has one, else one unit —
        // which is what `listings.quantity` defaults to and what the great
        // majority of second-hand listings are.
        _quantity = State(initialValue: max(1, min(999, draftSettings.quantity ?? 1)))
    }

    /// US-1975: what the format editor starts from. The SELECTOR reads the
    /// summary — the draft-settings fetch fails soft to `.none`, and misreading
    /// an auction draft as fixed price would silently rewrite its format on the
    /// next save. The auction PRICE boxes and the matrix read the seller's own
    /// saved columns for the mirror-image reason: `summary.auctionStartPrice`
    /// falls back to the listing price and `summary.variations` is already
    /// normalized (an in-progress matrix comes back null), so seeding from either
    /// would pin or discard something the seller never chose (US-1512/US-1970).
    /// Also the baseline the dirty check compares against, so it mirrors `init`.
    private static func seededFormatChoice(
        summary: PublishSummary, settings: ListingDraftSettings
    ) -> ComposerFormatChoice {
        ComposerFormatChoice(
            format: summary.composerFormat,
            startPriceText: seedCentsText(settings.auctionStartPriceCents),
            reservePriceText: seedCentsText(settings.auctionReservePriceCents),
            buyItNowText: seedCentsText(settings.auctionBuyItNowPriceCents),
            duration: AuctionDuration.normalize(settings.auctionDuration),
            variations: settings.variations.map(ComposerVariations.init(payload:))
        )
    }

    /// US-1970: cents → an editable, LOCALE-formatted string that round-trips
    /// back through `CurrencyFormatter().parse`. `String(format: "%.2f", …)`
    /// would always emit a "." separator, which a comma-decimal locale then
    /// misreads (US-1236).
    private static func seedCentsText(_ cents: Int?) -> String {
        guard let cents, cents > 0 else { return "" }
        return DraftEditRow.priceString2dp(Double(cents) / 100)
    }

    /// US-1971: where the date picker starts for a not-yet-scheduled draft — the
    /// soonest peak-buying evening slot, the same preset the Scheduled Drops
    /// surface offers, rather than "right now" (which would mean nothing).
    private static func defaultScheduleDate() -> Date {
        let preset = ScheduledDropScheduling.presets.first { $0.id == "tonight-7pm" }
            ?? ScheduledDropScheduling.presets[0]
        return ScheduledDropScheduling.nextPresetDate(
            preset, timeZoneIdentifier: ScheduledDropScheduling.detectTimezone()
        )
    }

    /// US-1512: what the rate box starts as — the server-resolved rate, or empty
    /// when opted out.
    private static func seedRateText(_ rate: Double?) -> String {
        rate.map(PromotedAdRate.format) ?? ""
    }

    /// US-1513: any field differing from the validated summary it was seeded
    /// from. Template application and a promo change count — they're all work
    /// the seller would lose to a stray swipe.
    private var isDirty: Bool {
        title != String(summary.title.prefix(Self.titleLimit))
            || condition != EbayCondition.resolve(summary.condition)
            || conditionDescription != (summary.conditionDescription ?? "")
            || description != summary.description
            || priceInput != summary.priceValue
            || !templateItemSpecifics.isEmpty
            || templateCategoryId != nil
            || templateReturnPolicyId != nil
            || templateShippingPolicyId != nil
            || templatePaymentPolicyId != nil
            || promoteEnabled != (summary.promotedAdRate != nil)
            || (promoteEnabled && promoRateText != Self.seedRateText(summary.promotedAdRate))
            || bestOffer != Self.seededBestOffer(summary: summary, settings: draftSettings)
            || scheduleEdit != .unchanged
            || formatChoice != Self.seededFormatChoice(summary: summary, settings: draftSettings)
    }

    /// US-1970: what the Best Offer controls were seeded with — the baseline the
    /// dirty check compares against. Mirrors `init`.
    private static func seededBestOffer(
        summary: PublishSummary, settings: ListingDraftSettings
    ) -> ComposerBestOffer {
        ComposerBestOffer(
            enabled: summary.bestOfferEnabled,
            autoAcceptText: seedCentsText(settings.autoAcceptCents),
            autoDeclineText: seedCentsText(settings.autoDeclineCents)
        )
    }

    /// US-1971: the schedule change to persist. Only a real difference from the
    /// saved value writes the column, so re-saving an unchanged schedule is a
    /// no-op rather than a redundant (and drift-prone) rewrite.
    private var scheduleEdit: ComposerScheduleEdit {
        let saved = draftSettings.scheduledPublishAt
        guard scheduleEnabled else {
            // Turning the toggle OFF cancels a saved drop; there's nothing to
            // cancel when none was saved.
            return saved != nil ? .clear : .unchanged
        }
        // Sub-second equality: the picker works in minutes, and the value we
        // seeded came back from the DB with its own sub-second precision, so an
        // exact `==` would report a phantom edit on every reopen.
        if let saved, abs(saved.timeIntervalSince(scheduleDate)) < 1 { return .unchanged }
        return .at(scheduleDate)
    }

    /// The effective listing price in cents — what the Best Offer thresholds are
    /// validated against.
    private var effectivePriceCents: Int {
        Int((Money.cents(CurrencyFormatter().parse(priceInput) ?? 0) * 100).rounded())
    }

    /// US-1970: the blocking Best Offer problem, if any.
    private var bestOfferError: String? {
        BestOfferValidation.error(bestOffer, priceCents: effectivePriceCents)
    }

    /// US-1975: the blocking format problem, if any (bad auction terms, or a
    /// matrix the server would silently drop back to a single-SKU listing).
    private var formatError: String? {
        ListingFormatValidation.error(formatChoice, priceCents: effectivePriceCents)
    }

    /// US-1975: the Best Offer choice this composer sends. eBay rejects Best
    /// Offer on an auction and the server suppresses it (`format === "FIXED_PRICE"`
    /// in the publish path), so an auction sends nil — leaving the columns alone
    /// rather than persisting terms that can never apply.
    private var effectiveBestOffer: ComposerBestOffer? {
        formatChoice.allowsBestOffer ? bestOffer : nil
    }

    /// The edits both commit paths (Save and Push) send up. Built once here so
    /// a scheduled save and an immediate push can never disagree about what the
    /// composer holds.
    private func currentEdits(schedule: ComposerScheduleEdit) -> ComposerEdits {
        ComposerEdits(
            title: trimmedTitle,
            condition: condition,
            conditionDescription: conditionDescription,
            description: description,
            price: priceInput,
            itemSpecifics: templateItemSpecifics,
            ebayCategoryId: templateCategoryId,
            returnPolicyId: templateReturnPolicyId,
            shippingPolicyId: templateShippingPolicyId,
            paymentPolicyId: templatePaymentPolicyId,
            // US-1512: only carry a promo choice when the control was actually
            // shown; an unparseable rate falls back to the category suggestion
            // server-side (persisted as null).
            promoteEnabled: summary.promotedAdRateKnown ? promoteEnabled : nil,
            promoRatePct: summary.promotedAdRateKnown && promoteEnabled
                ? PromotedAdRate.parse(promoRateText)
                : nil,
            bestOffer: effectiveBestOffer,
            schedule: schedule,
            listingFormat: formatChoice,
            quantity: showsQuantity ? quantity : nil
        )
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// US-1972: the composer's edits are complete enough to persist. Gates both
    /// commit buttons and the close confirmation's Save — a blank title or
    /// non-positive price would be rejected by `saveDraft` anyway (US-789).
    private var canSave: Bool {
        !trimmedTitle.isEmpty && !priceInvalid && bestOfferError == nil && formatError == nil
    }

    /// US-1972: what the parent needs to save this form on the seller's behalf
    /// when they close mid-edit.
    private var snapshot: ComposerSnapshot {
        ComposerSnapshot(edits: currentEdits(schedule: scheduleEdit), canSave: canSave)
    }

    /// US-1972: bank the seller's edits when the app is backgrounded, so a
    /// termination while suspended can't take them. Best-effort by nature — iOS
    /// allows the write only a few seconds — and it deliberately writes nothing
    /// the seller hasn't confirmed (see ``ComposerAutosave/shouldAutosave``).
    private func autosaveOnBackground() {
        guard ComposerAutosave.shouldAutosave(
            isDirty: isDirty,
            canSave: canSave,
            busy: isSaving || isPushing,
            schedule: scheduleEdit
        ) else { return }
        onSave(currentEdits(schedule: .unchanged))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if showRelistWarning {
                    relistWarningBanner
                }

                if let note = publishAccountNote {
                    // US-1507: which store this listing goes live on.
                    Label(note, systemImage: "info.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .combine)
                }

                if !aspectWarnings.isEmpty {
                    // US-828/US-1511: values the server will drop from the eBay
                    // payload — shown up front so "why isn't Material on my
                    // listing?" never needs a support round-trip.
                    VStack(alignment: .leading, spacing: 4) {
                        Label("Some specifics won\u{2019}t be sent", systemImage: "exclamationmark.triangle")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.brandAmber)
                        ForEach(aspectWarnings, id: \.self) { line in
                            Text(line)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Color.brandAmber.opacity(0.10), in: RoundedRectangle(cornerRadius: CornerRadius.control))
                    .accessibilityElement(children: .combine)
                }

                aiCopyButton

                if !templateStore.templates.isEmpty {
                    templateMenu
                }

                fieldGroup("Title") {
                    // US-970: warn as the 80-char cap nears (amber) and at the
                    // cap (red), plus an explicit at-limit note so characters
                    // truncated past the cap are never silently swallowed.
                    let titleFeedback = TitleLimitFeedback(count: title.count, limit: Self.titleLimit)
                    HStack {
                        Spacer()
                        Text(titleFeedback.counterText)
                            .font(.caption2)
                            .foregroundStyle(Self.counterColor(titleFeedback.level))
                    }
                    TextField("Listing title", text: $title, axis: .vertical)
                        .lineLimit(1...3)
                        .textFieldStyle(.roundedBorder)
                        .focused($focusedField, equals: .title)
                        .submitLabel(.next)
                        .onSubmit { focusedField = .conditionNote }
                        .onChange(of: title) { _, newValue in
                            if newValue.count > Self.titleLimit {
                                title = String(newValue.prefix(Self.titleLimit))
                            }
                        }
                    if let note = titleFeedback.atLimitNote {
                        Text(note)
                            .font(.caption2)
                            .foregroundStyle(.brandAmber)
                    }
                    titleQualityMeter
                }

                recommendedCoverageMeter

                // US-1897 (AC5): the score sits under the findability meters it
                // summarises, above the fields — a seller reads "72, and photos
                // are costing you 14" before they start editing, not after.
                if let qualityScore {
                    QualityScoreCard(score: qualityScore)
                }

                fieldGroup("Condition") {
                    Picker("Condition", selection: $condition) {
                        ForEach(EbayCondition.allCases) { option in
                            Text(option.label).tag(option)
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(Color.brandNavy)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                fieldGroup("Condition note") {
                    TextField("e.g. light wear at cuffs", text: $conditionDescription, axis: .vertical)
                        .lineLimit(1...3)
                        .textFieldStyle(.roundedBorder)
                        .focused($focusedField, equals: .conditionNote)
                        .submitLabel(.next)
                        .onSubmit { focusedField = .description }
                }

                fieldGroup("Description") {
                    TextField("Listing description", text: $description, axis: .vertical)
                        .lineLimit(4...12)
                        .textFieldStyle(.roundedBorder)
                        .focused($focusedField, equals: .description)
                        .submitLabel(.done)
                        .onSubmit { focusedField = nil }
                }

                priceSection
                quantitySection
                formatSection
                bestOfferSection
                scheduleSection
                policiesSection
                promoSection
                profitEstimate
                // US-1167: comp context (median + spread) from eBay so the seller
                // can sanity-check the price before publishing. The string is built
                // in `compContextLabel` (not inline) to keep this large Form body
                // within the Swift type-checker's budget.
                if let compContextLabel {
                    HStack(spacing: 6) {
                        Image(systemName: "chart.bar.xaxis").font(.caption2)
                        Text(compContextLabel)
                    }
                    .font(.caption2)
                    .foregroundStyle(Color.brandNavy)
                }

                if NetworkMonitor.isOffline(networkMonitor) {
                    OfflineNotice(intent: .blocked, detail: "to publish to eBay")
                }

                if let saveError {
                    Label(saveError, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(Color.brandRed)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .combine)
                }

                actionButtons
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .scrollDismissesKeyboard(.interactively)
        .keyboardDoneToolbar()
        // US-1513: report the first divergence from the validated summary so the
        // parent can block swipe-dismiss (the parent ratchets — see composerDirty).
        .onChange(of: isDirty) { _, dirty in
            if dirty { onDirty() }
        }
        // US-1972: keep the parent's copy of the edits current, so Close can
        // offer to save them.
        .onChange(of: snapshot, initial: true) { _, next in
            onSnapshot(next)
        }
        // US-1972: no work loss when the seller takes a call mid-edit.
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .background { autosaveOnBackground() }
        }
        .task { await templateStore.load() }
        // US-1237: load comps from the ALWAYS-present composer body, not the comp
        // caption (conditionally rendered) — so the lookup fires even when there
        // are no comps yet to show / the price section's layout changes.
        .task { await loadComps() }
        .task { await loadPublishAccountNote() }
        // US-3102: the policy list for the three pickers. Cached for fifteen
        // minutes, so reopening the composer does not re-ask.
        .task { await loadPolicies() }
        // US-972: applying a template overwrites the condition note (and adds
        // boilerplate to the description) — confirm before replacing the user's
        // existing content rather than silently clobbering it.
        .confirmationDialog(
            "Apply \(pendingTemplate?.name ?? "template")?",
            isPresented: Binding(
                get: { pendingTemplate != nil },
                set: { if !$0 { pendingTemplate = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingTemplate
        ) { template in
            Button("Apply template") {
                apply(template)
                pendingTemplate = nil
            }
            Button("Cancel", role: .cancel) { pendingTemplate = nil }
        } message: { _ in
            Text("This appends the template's boilerplate to your description and replaces your condition note. Your current description text is kept above the boilerplate.")
        }
    }

    // MARK: - Templates (US-674)

    private var templateMenu: some View {
        Menu {
            ForEach(templateStore.templates) { template in
                Button {
                    AppRouter.haptic()
                    requestApply(template)
                } label: {
                    if template.isDefault {
                        Label(template.name, systemImage: "star.fill")
                    } else {
                        Text(template.name)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "doc.on.doc")
                Text("Apply template")
                    .font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Color.brandNavy.opacity(0.12))
            .foregroundStyle(Color.brandNavy)
            .clipShape(Capsule())
        }
        .accessibilityLabel("Apply a saved listing template")
    }

    /// US-972: gate ``apply(_:)`` behind a confirmation when there's existing
    /// content the template would change (a condition note, or description text
    /// the boilerplate would be appended to). With nothing to lose, apply
    /// straight away so the common empty-composer case stays one tap.
    private func requestApply(_ template: ListingTemplate) {
        let hasContentAtRisk =
            !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !conditionDescription.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if hasContentAtRisk {
            pendingTemplate = template
        } else {
            apply(template)
        }
    }

    /// Pre-fill the composer from a template. Boilerplate is appended to the
    /// description; condition + note overwrite only when the template sets them
    /// (US-1268). US-1264: also applies the template's item specifics, eBay
    /// category, and the three business policies — so applying a template in the
    /// composer sets the FULL field set AutoLister applies server-side, not just
    /// description/condition. The non-text fields aren't shown in the composer
    /// UI; they're persisted onto the listing draft at push (see ComposerEdits).
    /// The actual transform is the pure ``ComposerTemplateApply`` so it's tested
    /// without the view.
    private func apply(_ template: ListingTemplate) {
        let applied = ComposerTemplateApply.apply(
            template: template,
            description: description,
            condition: condition,
            conditionDescription: conditionDescription,
            itemSpecifics: templateItemSpecifics,
            ebayCategoryId: templateCategoryId,
            returnPolicyId: templateReturnPolicyId,
            shippingPolicyId: templateShippingPolicyId,
            paymentPolicyId: templatePaymentPolicyId
        )
        description = applied.description
        condition = applied.condition
        conditionDescription = applied.conditionDescription
        templateItemSpecifics = applied.itemSpecifics
        templateCategoryId = applied.ebayCategoryId
        templateReturnPolicyId = applied.returnPolicyId
        templateShippingPolicyId = applied.shippingPolicyId
        templatePaymentPolicyId = applied.paymentPolicyId
        HapticFeedback.success()
    }

    /// Shown when relisting an item whose eBay listing is still live: pushing
    /// ends the current listing and creates a new one (new item #, watchers
    /// reset).
    private var relistWarningBanner: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.brandAmber)
            VStack(alignment: .leading, spacing: 4) {
                Text("This item is still live on eBay.")
                    .font(.subheadline.weight(.semibold))
                Text("Relisting ends the current listing and publishes a new one — the eBay item number resets and watchers/views start over.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.brandAmber.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
    }

    // MARK: - Quality guidance (US-1974)

    /// US-1974: the title-quality meter the web composer has shown since
    /// US-1892 — an 80-char utilization bar (green only in the 70–80 sweet spot)
    /// plus the server's non-blocking title findings.
    ///
    /// Everything here is ADVISORY: it renders inside the composer with Push
    /// still enabled, and reads as guidance (a meter, `.secondary` copy, an
    /// explicit "won't stop you publishing" note) rather than the amber
    /// `exclamationmark.triangle.fill` "Fix these before pushing" card that hard
    /// blockers get — those replace the composer entirely.
    @ViewBuilder
    private var titleQualityMeter: some View {
        let utilization = ComposerTitleQuality.utilization(title)
        VStack(alignment: .leading, spacing: 6) {
            ProgressView(value: Double(utilization.pct), total: 100)
                .progressViewStyle(.linear)
                .tint(Self.utilizationColor(utilization.band))
                .accessibilityLabel("Title length")
                .accessibilityValue(Self.utilizationHint(utilization))
            Text(Self.utilizationHint(utilization))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            if !qualityWarnings.isEmpty {
                ForEach(qualityWarnings, id: \.self) { warning in
                    Label(warning, systemImage: "lightbulb")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .symbolRenderingMode(.hierarchical)
                }
                Text("These won\u{2019}t stop you publishing.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// US-1974: recommended-specifics coverage (US-1895's `recommendedCoverage`).
    /// Also advisory — MISSING REQUIRED specifics are a publish blocker and never
    /// reach this composer; these only lift findability, so the meter explains
    /// where to fill them rather than gating the push.
    @ViewBuilder
    private var recommendedCoverageMeter: some View {
        if let coverage = recommendedCoverage, coverage.isMeaningful {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Recommended specifics")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(coverage.filled)/\(coverage.total)")
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(coverage.isComplete ? Color.brandEmerald : .secondary)
                }
                ProgressView(value: Double(coverage.pct), total: 100)
                    .progressViewStyle(.linear)
                    .tint(coverage.isComplete ? Color.brandEmerald : Color.brandNavy)
                    .accessibilityLabel("Recommended specifics filled")
                    .accessibilityValue("\(coverage.filled) of \(coverage.total)")
                if !coverage.missing.isEmpty {
                    // Ranked by eBay's 30-day buyer search volume, so the first
                    // few are the ones actually worth the seller's time.
                    Text("Most-searched still empty: \(coverage.missing.prefix(6).joined(separator: ", ")). Fill them in the item's specifics — buyers filter on these.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }

    /// US-1974: the utilization band's color — LOCKSTEP with the web meter
    /// (emerald in the 70–80 sweet spot, red at the cap, amber otherwise).
    private static func utilizationColor(_ band: ComposerTitleQuality.Band) -> Color {
        switch band {
        case .good: return .brandEmerald
        case .full: return .brandRed
        case .low, .empty: return .brandAmber
        }
    }

    /// One line naming what the bar is telling the seller.
    private static func utilizationHint(_ utilization: ComposerTitleQuality.Utilization) -> String {
        switch utilization.band {
        case .empty:
            return "Add a title — it\u{2019}s what buyers search."
        case .low:
            let room = ComposerTitleQuality.greenMin - utilization.used
            return "Using \(utilization.used) of \(utilization.limit) characters. Add about \(room) more — eBay ranks on the full title."
        case .good:
            return "Good length (\(utilization.used)/\(utilization.limit)) — you\u{2019}re using the search surface well."
        case .full:
            return "At eBay\u{2019}s \(utilization.limit)-character cap."
        }
    }

    /// US-970: map the title-counter level to a brand color — plain until the
    /// cap nears, amber as it approaches, red at the cap.
    private static func counterColor(_ level: TitleLimitFeedback.Level) -> Color {
        switch level {
        case .normal: return .secondary
        case .approaching: return .brandAmber
        case .atLimit: return .brandRed
        }
    }

    @ViewBuilder
    private func fieldGroup<Content: View>(
        _ label: String, @ViewBuilder _ content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
        }
    }

    // MARK: - AI copy

    private var aiCopyButton: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                AppRouter.haptic()
                Task { await generate() }
            } label: {
                HStack(spacing: 6) {
                    if isGenerating {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "sparkles")
                    }
                    Text(isGenerating ? "Writing…" : "Write title & description with AI")
                        .font(.subheadline.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(Color.brandNavy.opacity(0.12))
                .foregroundStyle(Color.brandNavy)
                .clipShape(Capsule())
            }
            .disabled(isGenerating)

            if let aiError {
                Text(aiError)
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
    }

    private func generate() async {
        isGenerating = true
        aiError = nil
        defer { isGenerating = false }
        do {
            let copy = try await copyService.generate(itemId: inventoryItemId)
            title = String(copy.title.prefix(Self.titleLimit))
            description = copy.description
            HapticFeedback.success()
        } catch {
            aiError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    // MARK: - Price (US-1242)

    /// Price entry. When the validated draft has no usable price the seller can
    /// set it right here — a zero-price draft used to dead-end the dialog with
    /// "set a price on the item canvas" and a disabled Push, bouncing them out of
    /// the flow. When a price IS already set this displays it read-only: the
    /// number shown is the server-RESOLVED publish price (US-1504 — a real
    /// item.target_price wins over an AutoLister AI estimate, so this is never the
    /// stale estimate once the seller set a target), and the item canvas / target
    // ── US-3102: quantity ────────────────────────────────────────────────────

    /// Whether a single quantity is a meaningful thing to ask for.
    ///
    /// Hidden on an auction (eBay auctions are one unit by definition) and on a
    /// variation matrix (each variant already carries its own). Showing it in
    /// either case would offer a control whose value the server discards, which
    /// is worse than not offering it — the seller sets a number and nothing
    /// happens.
    private var showsQuantity: Bool {
        !formatChoice.isAuction && formatChoice.variations == nil
    }

    @ViewBuilder
    private var quantitySection: some View {
        if showsQuantity {
            VStack(alignment: .leading, spacing: 4) {
                Stepper(value: $quantity, in: 1...999) {
                    HStack {
                        Text("Quantity")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("\(quantity)")
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                    }
                }
                .accessibilityLabel(Text("Quantity to list"))
                .accessibilityValue(Text("\(quantity)"))
                if quantity > 1 {
                    // Said because the alternative is a seller listing five of
                    // something they own one of, and finding out when it sells.
                    Text("Listing \(quantity) units of this item.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // ── US-3102: business policies ───────────────────────────────────────────

    /// The three per-listing policy pickers.
    ///
    /// Nil means "use the account default", which is what publish already falls
    /// back to — so the picker's first row is a real choice rather than an empty
    /// state, and the great majority of listings never leave it.
    @ViewBuilder
    private var policiesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Shipping & returns")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    Task { await syncPolicies() }
                } label: {
                    if isSyncingPolicies {
                        ProgressView().controlSize(.mini)
                    } else {
                        Text("Sync policies").font(.caption)
                    }
                }
                .disabled(isSyncingPolicies)
            }

            policyPicker(
                title: String(localized: "Shipping"),
                type: "fulfillment",
                selection: $templateShippingPolicyId
            )
            policyPicker(
                title: String(localized: "Payment"),
                type: "payment",
                selection: $templatePaymentPolicyId
            )
            policyPicker(
                title: String(localized: "Returns"),
                type: "return",
                selection: $templateReturnPolicyId
            )

            if let policiesError {
                // The same posture EbaySyncModal takes: name the reconnect,
                // never a raw status code.
                Label(policiesError, systemImage: "exclamationmark.triangle")
                    .font(.caption2)
                    .foregroundStyle(Color.brandAmber)
                    .fixedSize(horizontal: false, vertical: true)
            } else if policies?.policies.isEmpty == true {
                Text("No business policies on this eBay account yet. Publish uses your account defaults.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func policyPicker(
        title: String,
        type: String,
        selection: Binding<String?>
    ) -> some View {
        let options = policies?.options(ofType: type) ?? []
        Picker(title, selection: selection) {
            Text("Use account default").tag(String?.none)
            ForEach(options) { policy in
                Text(policy.policyName).tag(String?.some(policy.policyId))
            }
        }
        .pickerStyle(.menu)
        .disabled(options.isEmpty)
    }

    /// Load the policies for the pickers. Failures are shown, not thrown: a
    /// composer that cannot reach the policy list must still publish, because
    /// publish falls back to the account defaults on its own.
    private func loadPolicies() async {
        do {
            policies = try await policiesService.policies(forceRefresh: false)
            policiesError = nil
        } catch {
            policiesError = Self.policiesFailureCopy(error)
        }
    }

    private func syncPolicies() async {
        isSyncingPolicies = true
        defer { isSyncingPolicies = false }
        do {
            policies = try await policiesService.sync()
            policiesError = nil
        } catch {
            policiesError = Self.policiesFailureCopy(error)
        }
    }

    /// What to say when the policy list will not load.
    ///
    /// A 401/403 here means the eBay connection is what needs fixing, and
    /// saying "unauthorized" sends the seller looking for a GradeThread problem.
    /// Pure and static so the mapping is testable.
    static func policiesFailureCopy(_ error: Error) -> String {
        if let apiError = error as? EdgeAPIError {
            switch apiError {
            case .unauthorized, .forbidden, .workspaceAccessRevoked:
                return String(localized: "Reconnect eBay in Marketplaces to load your shipping and return policies.")
            default:
                break
            }
        }
        return String(localized: "Couldn't load your eBay policies. Publish will use your account defaults.")
    }

    /// price is where you change it.
    @ViewBuilder
    private var priceSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            if summaryPriceMissing {
                Text("Price")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    Text(summary.currency ?? "USD")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    TextField("0.00", text: $priceInput)
                        .keyboardType(.decimalPad)
                        .textFieldStyle(.roundedBorder)
                        .focused($focusedField, equals: .price)
                }
                if priceInvalid {
                    Label("Enter a price greater than 0 to publish.", systemImage: "exclamationmark.triangle")
                        .font(.caption2)
                        .foregroundStyle(Color.brandRed)
                } else {
                    // US-1648: the price now persists with the listing draft on
                    // Save (the UPDATE branch writes listing_price), not only at
                    // publish — so the old "…when you publish" copy was false.
                    Text("Saved with the listing.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            } else {
                HStack {
                    Text("Price")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(summary.currency ?? "USD") \(MoneyFieldValidation.twoDecimalDisplay(priceInput))")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.brandNavy)
                }
                Text("Edit price on the item canvas.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Actions (US-1972)

    /// The composer's commit row. A scheduled listing's primary action SAVES
    /// (the scheduled-publish worker does the push when it comes due), so "Push
    /// to eBay" is deliberately replaced rather than shown alongside — offering
    /// both would let one tap contradict the schedule the seller just set.
    @ViewBuilder
    private var actionButtons: some View {
        let offline = NetworkMonitor.isOffline(networkMonitor)
        let busy = isPushing || isSaving
        let commitDisabled = !canSave || offline || busy

        VStack(spacing: 8) {
            if scheduleEnabled {
                Button {
                    guard !busy else { return }
                    onSave(currentEdits(schedule: scheduleEdit))
                } label: {
                    primaryLabel(
                        scheduleEdit == .unchanged ? "Keep this schedule" : "Schedule publish",
                        disabled: commitDisabled
                    )
                }
                .disabled(commitDisabled)
            } else {
                Button {
                    // US-1497: flip the guard synchronously before handing off, so
                    // the button is disabled before the async push even starts.
                    guard !isPushing else { return }
                    isPushing = true
                    onPush(currentEdits(schedule: scheduleEdit))
                } label: {
                    primaryLabel(pushLabel, disabled: commitDisabled)
                }
                .disabled(commitDisabled)
            }

            // US-1972: the standalone save — always available, so composer work
            // can be banked without publishing. Hidden when scheduling, where
            // the primary button already IS a save.
            if !scheduleEnabled {
                Button {
                    guard !busy else { return }
                    onSave(currentEdits(schedule: scheduleEdit))
                } label: {
                    HStack(spacing: 6) {
                        if isSaving { ProgressView().controlSize(.small) }
                        Text(isSaving ? "Saving…" : "Save draft")
                    }
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color.secondary.opacity(0.15))
                    .foregroundStyle(commitDisabled ? Color.secondary : Color.brandNavy)
                    .clipShape(Capsule())
                }
                .disabled(commitDisabled)
                .accessibilityHint("Saves your edits without publishing to eBay")
            }
        }
        .padding(.top, 4)
    }

    private func primaryLabel(_ text: String, disabled: Bool) -> some View {
        HStack(spacing: 6) {
            if isSaving { ProgressView().controlSize(.small).tint(.white) }
            Text(text)
        }
        .font(.subheadline.weight(.semibold))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(disabled ? Color.secondary.opacity(0.3) : Color.brandNavy)
        .foregroundStyle(.white)
        .clipShape(Capsule())
    }

    // MARK: - Listing format + variations (US-1975)

    /// Format selector, the auction terms, and the multi-variant matrix. Auction
    /// and variations are mutually exclusive (eBay has no multi-variation
    /// auction), so choosing one clears the other — the web composer's rule.
    @ViewBuilder
    private var formatSection: some View {
        fieldGroup("Listing format") {
            Picker("Listing format", selection: formatBinding) {
                ForEach(ComposerListingFormat.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
            .pickerStyle(.segmented)

            if formatChoice.isAuction {
                auctionFields
            } else {
                variationsControl
            }

            if let formatError {
                Label(formatError, systemImage: "exclamationmark.triangle")
                    .font(.caption2)
                    .foregroundStyle(Color.brandRed)
                    .accessibilityElement(children: .combine)
            }
        }
    }

    /// Switching to auction drops the variation matrix rather than leaving it to
    /// be silently ignored at publish.
    private var formatBinding: Binding<ComposerListingFormat> {
        Binding(
            get: { formatChoice.format },
            set: { next in
                formatChoice.format = next
                if next == .auction { formatChoice.variations = nil }
            }
        )
    }

    @ViewBuilder
    private var auctionFields: some View {
        Text("Bidding runs for the duration you pick. The winning bid is the sale price — buyers can\u{2019}t send offers on an auction.")
            .font(.caption2)
            .foregroundStyle(.secondary)
        thresholdField(
            label: "Starting bid",
            text: $formatChoice.startPriceText,
            // The server starts the auction at the listing price when this is
            // blank, so show that resolution rather than an empty hint.
            placeholder: summary.auctionStartPrice ?? summary.priceValue,
            field: .auctionStart
        )
        thresholdField(
            label: "Reserve (optional)",
            text: $formatChoice.reservePriceText,
            placeholder: nil,
            field: .auctionReserve
        )
        thresholdField(
            label: "Buy It Now (optional)",
            text: $formatChoice.buyItNowText,
            placeholder: nil,
            field: .auctionBuyItNow
        )
        Picker("Duration", selection: $formatChoice.duration) {
            ForEach(AuctionDuration.all, id: \.self) { value in
                Text(AuctionDuration.label(value)).tag(value)
            }
        }
        .pickerStyle(.menu)
        .tint(Color.brandNavy)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The multi-variant toggle + matrix. Enabling it forces fixed price (the
    /// selector above is already fixed price whenever this is reachable).
    @ViewBuilder
    private var variationsControl: some View {
        Toggle(isOn: variationsToggle) {
            Text("Multi-variant (sizes / colors)")
                .font(.subheadline)
        }
        .tint(Color.brandNavy)

        if let binding = Binding($formatChoice.variations) {
            VariationMatrixEditor(variations: binding, currency: summary.currency ?? "USD")
        } else {
            Text("One listing, one SKU. Turn this on to sell several sizes or colors under a single listing.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var variationsToggle: Binding<Bool> {
        Binding(
            get: { formatChoice.variations != nil },
            set: { on in
                formatChoice.variations = on ? ComposerVariations.seeded() : nil
                if on { formatChoice.format = .fixedPrice }
            }
        )
    }

    // MARK: - Best Offer (US-1970)

    /// Best Offer toggle + optional auto-accept / auto-decline thresholds. The
    /// server has always accepted these (and derives sensible defaults from the
    /// comp range); until now the phone had no way to set them, so every offer
    /// waited on the seller.
    @ViewBuilder
    private var bestOfferSection: some View {
        // US-1975: eBay allows no Best Offer on an auction (the server drops the
        // terms), so the control is hidden rather than left to look effective.
        if formatChoice.allowsBestOffer {
            bestOfferControls
        }
    }

    @ViewBuilder
    private var bestOfferControls: some View {
        fieldGroup("Best Offer") {
            Toggle(isOn: $bestOffer.enabled) {
                Text("Accept offers")
                    .font(.subheadline)
            }
            .tint(Color.brandNavy)

            if bestOffer.enabled {
                Text("Buyers can send offers. Set thresholds to clear them automatically, or leave blank to use the suggested ones and review each offer yourself.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                thresholdField(
                    label: "Auto-accept at or above",
                    text: $bestOffer.autoAcceptText,
                    placeholder: summary.bestOfferAutoAccept,
                    field: .bestOfferAccept
                )
                thresholdField(
                    label: "Auto-decline at or below",
                    text: $bestOffer.autoDeclineText,
                    placeholder: summary.bestOfferAutoDecline,
                    field: .bestOfferDecline
                )
                if let bestOfferError {
                    Label(bestOfferError, systemImage: "exclamationmark.triangle")
                        .font(.caption2)
                        .foregroundStyle(Color.brandRed)
                        .accessibilityElement(children: .combine)
                }
            } else {
                Text("Buyers can only buy at the listed price.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func thresholdField(
        label: String,
        text: Binding<String>,
        placeholder: String?,
        field: Field
    ) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Text(summary.currency ?? "USD")
                .font(.caption)
                .foregroundStyle(.secondary)
            // The placeholder is the server's resolved suggestion, so a blank
            // box reads as "we'll use this" rather than "nothing set".
            TextField(placeholder.map(Self.suggestionPlaceholder) ?? "Optional", text: text)
                .keyboardType(.decimalPad)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 110)
                .focused($focusedField, equals: field)
                .accessibilityLabel(label)
        }
    }

    /// Render the server's suggested threshold as a locale-formatted hint. It
    /// arrives as an eBay money string (always "."-separated), so it's parsed
    /// and re-formatted rather than shown verbatim.
    private static func suggestionPlaceholder(_ raw: String) -> String {
        guard let value = Double(raw) else { return raw }
        return DraftEditRow.priceString2dp(value)
    }

    // MARK: - Scheduled publish (US-1971)

    /// Schedule the publish for a peak-buying slot instead of pushing now. The
    /// draft's `scheduled_publish_at` drives the existing scheduled-publish
    /// worker, and the listing then shows up on the Scheduled Drops surface —
    /// whose empty state has always told sellers to set this here.
    @ViewBuilder
    private var scheduleSection: some View {
        fieldGroup("Schedule publish") {
            Toggle(isOn: $scheduleEnabled) {
                Text("Publish later")
                    .font(.subheadline)
            }
            .tint(Color.brandNavy)

            if scheduleEnabled {
                DatePicker(
                    "Publish at",
                    selection: $scheduleDate,
                    in: Date.now...,
                    displayedComponents: [.date, .hourAndMinute]
                )
                .font(.subheadline)
                .tint(Color.brandNavy)
                Menu {
                    ForEach(ScheduledDropScheduling.presets) { preset in
                        Button {
                            AppRouter.haptic()
                            scheduleDate = ScheduledDropScheduling.nextPresetDate(
                                preset, timeZoneIdentifier: ScheduledDropScheduling.detectTimezone()
                            )
                        } label: {
                            Text("\(preset.label) — \(preset.hint)")
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "clock.badge.checkmark")
                        Text("Use a peak-time slot")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(Color.brandNavy)
                }
                Text("Goes live \(ScheduledDropScheduling.formatInZone(scheduleDate, timeZoneIdentifier: ScheduledDropScheduling.detectTimezone())). It stays a draft until then and appears under Tools → Scheduled Drops.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if draftSettings.scheduledPublishAt != nil {
                // The toggle was switched off on an already-scheduled draft —
                // say what saving will do, since "off" alone is ambiguous.
                Text("Saving cancels the scheduled publish. The draft stays.")
                    .font(.caption2)
                    .foregroundStyle(Color.brandAmber)
            }
        }
    }

    // MARK: - Promoted Listings (US-1512)

    /// The ad rate the publish will actually apply given the current controls:
    /// nil when opted out (or the control isn't shown), the parsed adjusted
    /// rate, else the server-resolved rate the box was seeded with.
    private var effectivePromoRate: Double? {
        guard summary.promotedAdRateKnown, promoteEnabled else { return nil }
        return PromotedAdRate.parse(promoRateText) ?? summary.promotedAdRate
    }

    /// Discloses the Promoted Listings ad the publish attaches by default, with
    /// an adjust/opt-out control (mirrors web US-561). Only rendered when the
    /// server resolved a rate — an older edge that omits the field must not be
    /// misread as "opted out".
    @ViewBuilder
    private var promoSection: some View {
        if summary.promotedAdRateKnown {
            fieldGroup("Promoted Listings") {
                Toggle(isOn: $promoteEnabled) {
                    Text("Promote this listing")
                        .font(.subheadline)
                }
                .tint(Color.brandNavy)
                if promoteEnabled {
                    let seeded = Self.seedRateText(summary.promotedAdRate)
                    HStack(spacing: 6) {
                        TextField(seeded.isEmpty ? "8" : seeded, text: $promoRateText)
                            .keyboardType(.decimalPad)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 80)
                            .accessibilityLabel("Promoted Listings ad rate percent")
                        Text("% ad rate")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Text("eBay charges this percent of the sale price only if the item sells through the ad. Leave blank to use eBay's suggested rate.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else {
                    Text("No ad will be attached to this listing.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Profit estimate

    @ViewBuilder
    private var profitEstimate: some View {
        // Locale-tolerant parse so "24,99"/"$25" estimate correctly, then
        // cents-normalize through `Money` so the figure rounds identically to
        // the listing price that's persisted/pushed AND to the Money tab's
        // realized net for an equivalent completed sale (US-1002). 0 is fine
        // here (display-only — the insert path validates before persisting, US-789).
        // US-1242: read the editable `priceInput` so an inline price fix updates
        // the estimate live (equals the summary price when nothing was edited).
        let price = Money.cents(CurrencyFormatter().parse(priceInput) ?? 0)
        let estimate = ListingProfit.estimate(price: price, costBasis: acquiredCost)
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text("Est. net profit")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                VStack(alignment: .trailing, spacing: 1) {
                    Text("\(Self.dollars(estimate.netCents)) · \(Int(estimate.marginPctCents(price: price).rounded()))% margin")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(profitColor(estimate))
                    Text(profitDetail(estimate))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            // US-1512: the ad fee applies only on an ad-attributed sale, so it's
            // a labeled footnote rather than folded into the net (which stays a
            // mirror of the web estimate — see ListingProfit.promotedAdFee).
            if let rate = effectivePromoRate, price > 0 {
                let fee = Money.cents(ListingProfit.promotedAdFee(price: price, ratePct: rate))
                Text("Promoted ad: \(PromotedAdRate.format(rate))% (~\(Self.dollars(fee))) also comes out if it sells through the ad.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func profitColor(_ estimate: ListingProfit) -> Color {
        if estimate.netCents < 0 { return .brandRed }
        if estimate.marginPct < 20 { return .brandAmber }
        return .brandEmerald
    }

    private func profitDetail(_ estimate: ListingProfit) -> String {
        var parts = ["eBay fees ~\(Self.dollars(estimate.feesCents))"]
        if acquiredCost == nil {
            parts.append("add cost for true margin")
        }
        return parts.joined(separator: " · ")
    }

    private static func dollars(_ amount: Double) -> String {
        // US-1155: locale/override currency symbol rather than a hardcoded "$".
        CurrencyFormatter().formatDisplay(amount)
    }
}

/// US-1975: the size/color matrix editor. Each row is one purchasable
/// combination with its own quantity and (optional) price — the shape
/// `publishVariationListing` turns into an eBay inventory_item_group.
private struct VariationMatrixEditor: View {
    @Binding var variations: ComposerVariations
    let currency: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            variesByRow
            ForEach($variations.variants) { $variant in
                VariantRow(
                    variant: $variant,
                    specifications: variations.specifications,
                    currency: currency,
                    onRemove: removeAction(for: variant.id)
                )
            }
            addButton
            Text("Leave a variant\u{2019}s price blank to sell it at the listing price. eBay needs at least two in-stock variants — with fewer, this publishes as a single listing.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var variesByRow: some View {
        HStack(spacing: 10) {
            ForEach(ComposerVariations.specOptions, id: \.self) { spec in
                Toggle(isOn: specBinding(spec)) {
                    Text("Varies by \(spec)")
                        .font(.caption.weight(.semibold))
                }
                .toggleStyle(.button)
                .tint(Color.brandNavy)
            }
        }
    }

    private var addButton: some View {
        Button {
            AppRouter.haptic()
            var aspects: [String: String] = [:]
            for spec in variations.specifications { aspects[spec] = "" }
            variations.variants.append(ComposerVariant(aspects: aspects))
        } label: {
            Label("Add variant", systemImage: "plus")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.brandNavy)
        }
    }

    /// Turning a varies-by spec on/off rewrites every row's aspect set, keeping
    /// the values already typed for the specs that survive. At least one spec has
    /// to remain — a matrix that varies by nothing isn't a variation listing.
    private func specBinding(_ spec: String) -> Binding<Bool> {
        Binding(
            get: { variations.specifications.contains(spec) },
            set: { on in
                let next = on
                    ? variations.specifications + [spec]
                    : variations.specifications.filter { $0 != spec }
                guard !next.isEmpty else { return }
                variations = ComposerVariations(
                    specifications: next,
                    variants: variations.variants.map { variant in
                        var aspects: [String: String] = [:]
                        for name in next { aspects[name] = variant.aspects[name] ?? "" }
                        var copy = variant
                        copy.aspects = aspects
                        return copy
                    }
                )
            }
        )
    }

    /// Removing the last row would leave a matrix with nothing to re-enable it
    /// from, so the final row keeps no delete control (turn multi-variant off
    /// instead). Returned as an optional action so the row can't type-infer its
    /// way into an always-enabled button.
    private func removeAction(for id: UUID) -> (() -> Void)? {
        guard variations.variants.count > 1 else { return nil }
        return { variations.variants.removeAll { $0.id == id } }
    }

    private struct VariantRow: View {
        @Binding var variant: ComposerVariant
        let specifications: [String]
        let currency: String
        /// nil when this is the last row — a matrix with no rows has nothing to
        /// re-enable it from.
        var onRemove: (() -> Void)?

        var body: some View {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(specifications, id: \.self) { spec in
                    HStack(spacing: 6) {
                        Text(spec)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(width: 52, alignment: .leading)
                        TextField(spec, text: aspectBinding(spec))
                            .textFieldStyle(.roundedBorder)
                            .accessibilityLabel("Variant \(spec)")
                    }
                }
                HStack(spacing: 6) {
                    Text("Qty")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("1", text: $variant.quantityText)
                        .keyboardType(.numberPad)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 56)
                        .accessibilityLabel("Variant quantity")
                    Text(currency)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("Listing price", text: $variant.priceText)
                        .keyboardType(.decimalPad)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Variant price")
                    if let onRemove {
                        Button(role: .destructive) {
                            AppRouter.haptic()
                            onRemove()
                        } label: {
                            Image(systemName: "trash")
                                .scaledIconFont(size: 14, maxSize: 22)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Remove variant")
                    }
                }
            }
            .padding(8)
            .background(
                RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous)
                    .fill(Color.secondary.opacity(0.08))
            )
        }

        private func aspectBinding(_ spec: String) -> Binding<String> {
            Binding(
                get: { variant.aspects[spec] ?? "" },
                set: { variant.aspects[spec] = $0 }
            )
        }
    }
}

/// US-1061: one-time, dismissable "manage this item in FlipDesk" notice shown on
/// the user's FIRST successful eBay publish. FlipDesk is the source of truth for
/// a published listing — it syncs with eBay through the eBay API, so editing the
/// item directly on eBay can be overwritten on the next sync or desync the two
/// sides. The dismissed flag lives on the users row (RLS-scoped to the owner),
/// so the notice shows only once and survives a device change.
private struct EbayPublishDisclaimerCard: View {
    @Environment(\.openURL) private var openURL
    @State private var loaded = false
    /// Default to dismissed so the card never flashes before the flag loads.
    @State private var dismissed = true
    @State private var saving = false

    private static let helpURL = URL(string: "https://gradethread.com/faq")!

    var body: some View {
        Group {
            if loaded && !dismissed {
                content
            }
        }
        .task { await load() }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Manage this item in FlipDesk", systemImage: "info.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.brandNavy)
            Text("FlipDesk is now the source of truth for this listing. It syncs with eBay through the eBay API, so editing the item directly on eBay — photos, price, title, item specifics, or ending and relisting — can be overwritten on the next sync or leave the two sides out of step. Make every change here in FlipDesk and let it push the update to eBay.")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Button("Learn more") { openURL(Self.helpURL) }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
                Spacer()
                Button {
                    Task { await persistDismissal() }
                } label: {
                    HStack(spacing: 4) {
                        if saving { ProgressView().controlSize(.small) }
                        Text("Got it")
                    }
                    .font(.caption.weight(.semibold))
                }
                .disabled(saving)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.brandNavy.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private struct FlagRow: Decodable {
        let dismissed_ebay_publish_disclaimer: Bool
    }

    private func load() async {
        // RLS scopes the SELECT to the caller, so no explicit user filter needed.
        do {
            let rows: [FlagRow] = try await SupabaseShared.client
                .from("users")
                .select("dismissed_ebay_publish_disclaimer")
                .limit(1)
                .execute()
                .value
            dismissed = rows.first?.dismissed_ebay_publish_disclaimer ?? true
        } catch {
            // On error, stay hidden rather than nag the user.
            dismissed = true
        }
        loaded = true
    }

    private struct DismissUpdate: Encodable {
        let dismissed_ebay_publish_disclaimer: Bool
    }

    private func persistDismissal() async {
        saving = true
        defer { saving = false }
        do {
            let userId = try await SupabaseShared.client.auth.session.user.id.uuidString
            try await SupabaseShared.client
                .from("users")
                .update(DismissUpdate(dismissed_ebay_publish_disclaimer: true))
                .eq("id", value: userId)
                .execute()
        } catch {
            // Hide locally regardless; it re-surfaces on a later publish.
        }
        dismissed = true
    }
}
