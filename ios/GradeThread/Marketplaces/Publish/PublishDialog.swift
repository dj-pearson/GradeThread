import SwiftUI

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
    @State private var showingSafari = false
    private let service = EbayPublishService()

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
                    Button("Close") { dismiss() }
                        .disabled(phase == .pushing)
                }
            }
        }
        .task { await runValidate() }
        .sheet(isPresented: $showingSafari) {
            if case let .succeeded(response) = phase,
               let url = URL(string: response.listingURL) {
                SafariView(url: url)
            }
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
                showRelistWarning: listingActive
            ) { edits in
                Task { await runPush(edits: edits, summary: summary) }
            }

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
                Button {
                    onPublished(response)
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
        let outcome = await service.validate(inventoryItemId: inventoryItemId)
        switch outcome {
        case .validated(let response):
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

    private func runPush(edits: ComposerEdits, summary: PublishSummary) async {
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
    let onPush: (ComposerEdits) -> Void

    /// US-981: proactively gate the push button when offline so it shows an
    /// offline state rather than firing a doomed round-trip (the parent's
    /// `runPush` keeps a tap-time backstop for the flap-mid-tap case).
    @Environment(NetworkMonitor.self) private var networkMonitor: NetworkMonitor?

    @State private var title: String
    @State private var condition: EbayCondition
    @State private var conditionDescription: String
    @State private var description: String
    /// US-1242: editable price, seeded from the validated summary. When the draft
    /// has no usable price the seller can set it inline here instead of being
    /// bounced to the canvas; otherwise the price stays read-only (the canvas is
    /// its home) and this just mirrors the summary value.
    @State private var priceInput: String

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

    /// US-969: keyboard Next/Return traversal across the editable text fields
    /// (the condition Picker and read-only price are skipped).
    @FocusState private var focusedField: Field?
    private enum Field: Hashable { case title, conditionNote, description, price }

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

    // US-674: listing templates, selectable to pre-fill the draft.
    @State private var templateStore = TemplateStore()
    /// US-972: a template the user picked that would overwrite existing content,
    /// pending confirmation before it's applied.
    @State private var pendingTemplate: ListingTemplate?

    private static let titleLimit = 80

    init(
        summary: PublishSummary,
        inventoryItemId: String,
        acquiredCost: Double?,
        pushLabel: String = "Push to eBay",
        showRelistWarning: Bool = false,
        onPush: @escaping (ComposerEdits) -> Void
    ) {
        self.summary = summary
        self.inventoryItemId = inventoryItemId
        self.acquiredCost = acquiredCost
        self.pushLabel = pushLabel
        self.showRelistWarning = showRelistWarning
        self.onPush = onPush
        _title = State(initialValue: String(summary.title.prefix(Self.titleLimit)))
        _condition = State(initialValue: EbayCondition.resolve(summary.condition))
        _conditionDescription = State(initialValue: summary.conditionDescription ?? "")
        _description = State(initialValue: summary.description)
        _priceInput = State(initialValue: summary.priceValue)
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if showRelistWarning {
                    relistWarningBanner
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

                let pushDisabled = trimmedTitle.isEmpty || priceInvalid || NetworkMonitor.isOffline(networkMonitor)
                Button {
                    onPush(ComposerEdits(
                        title: trimmedTitle,
                        condition: condition,
                        conditionDescription: conditionDescription,
                        description: description,
                        price: priceInput,
                        itemSpecifics: templateItemSpecifics,
                        ebayCategoryId: templateCategoryId,
                        returnPolicyId: templateReturnPolicyId,
                        shippingPolicyId: templateShippingPolicyId,
                        paymentPolicyId: templatePaymentPolicyId
                    ))
                } label: {
                    Text(pushLabel)
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(pushDisabled ? Color.secondary.opacity(0.3) : Color.brandNavy)
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                }
                .disabled(pushDisabled)
                .padding(.top, 4)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .scrollDismissesKeyboard(.interactively)
        .keyboardDoneToolbar()
        .task { await templateStore.load() }
        // US-1237: load comps from the ALWAYS-present composer body, not the comp
        // caption (conditionally rendered) — so the lookup fires even when there
        // are no comps yet to show / the price section's layout changes.
        .task { await loadComps() }
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
    /// the flow. When a price IS already set it stays read-only (the canvas is the
    /// price's home, US-1190) and this just displays it.
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
                    Text("Saved back to the item when you publish.")
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
