import SwiftUI

/// End-to-end publish flow shown as a sheet from ItemCanvasView.
/// State machine: validating → review (blockers OR summary card) →
/// pushing → success (listing URL + open) | failure (error + retry).
struct PublishDialog: View {
    @Environment(\.dismiss) private var dismiss

    let inventoryItemId: String
    /// Cost basis for the live profit estimate in the composer (nil when unknown).
    var acquiredCost: Double? = nil
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
        case failed(message: String)
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
            .navigationTitle("Publish to eBay")
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
            loadingCard(text: "Checking the listing…")

        case .readyToPush(let summary):
            ComposerForm(
                summary: summary,
                inventoryItemId: inventoryItemId,
                acquiredCost: acquiredCost
            ) { edits in
                Task { await runPush(edits: edits, priceValue: summary.priceValue) }
            }

        case .blocked(let blockers):
            blockersCard(blockers)

        case .pushing:
            loadingCard(text: "Sending to eBay…")

        case .succeeded(let response):
            successCard(response)

        case .failed(let message):
            failureCard(message: message)
        }
    }

    // MARK: - Reusable card builders

    private func loadingCard(text: String) -> some View {
        VStack(spacing: 12) {
            ProgressView().tint(Color.brandNavy).scaleEffect(1.2)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func summaryCard(_ summary: PublishSummary) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Ready to publish")
                .font(.headline)
            Group {
                LabeledContent("Title", value: summary.title)
                if let condition = summary.condition {
                    LabeledContent("Condition", value: humanCondition(condition))
                }
                LabeledContent("Price") {
                    Text("\(summary.currency ?? "USD") \(summary.priceValue)")
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
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func blockersCard(_ blockers: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Fix these before pushing", systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.orange)
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
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func successCard(_ response: PushResponse) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(.green)
            Text("Live on eBay")
                .font(.title3.weight(.semibold))
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
        }
        .padding(20)
        .frame(maxWidth: .infinity)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func failureCard(message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "xmark.octagon.fill")
                .font(.system(size: 40))
                .foregroundStyle(.red)
            Text("Publish failed")
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 10) {
                Button("Try again") {
                    Task { await runValidate() }
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
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
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
            phase = .failed(message: "No active eBay offer linked. Sync from Marketplaces, then try again.")
        case .failed(let message):
            phase = .failed(message: message)
        case .pushed, .priceUpdated, .ended:
            // Wrong outcome shape for validate — shouldn't happen.
            phase = .failed(message: "Unexpected response from server.")
        }
    }

    private func runPush(edits: ComposerEdits, priceValue: String) async {
        phase = .pushing
        Telemetry.breadcrumb("Publishing to eBay", category: "publish")

        // Persist composer edits to the listings draft first; the push
        // re-reads the publish context server-side, so these reach eBay.
        do {
            try await ListingDraftService().saveDraft(
                inventoryItemId: inventoryItemId,
                priceValue: priceValue,
                edits: edits
            )
        } catch {
            phase = .failed(message: "Couldn't save your edits: \(error.localizedDescription)")
            HapticFeedback.error()
            return
        }

        let outcome = await service.push(inventoryItemId: inventoryItemId)
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
            phase = .blocked(blockers)
            HapticFeedback.warning()
        case .noOfferId:
            phase = .failed(message: "eBay couldn't link the offer. Try again or check Marketplaces.")
            HapticFeedback.error()
        case .failed(let message):
            phase = .failed(message: message)
            HapticFeedback.error()
        case .validated, .priceUpdated, .ended:
            phase = .failed(message: "Unexpected response from server.")
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
    let onPush: (ComposerEdits) -> Void

    @State private var title: String
    @State private var condition: EbayCondition
    @State private var conditionDescription: String
    @State private var description: String

    // AI copy generation.
    @State private var isGenerating = false
    @State private var aiError: String?
    private let copyService: ListingCopyGenerating = ListingCopyService()

    private static let titleLimit = 80

    init(
        summary: PublishSummary,
        inventoryItemId: String,
        acquiredCost: Double?,
        onPush: @escaping (ComposerEdits) -> Void
    ) {
        self.summary = summary
        self.inventoryItemId = inventoryItemId
        self.acquiredCost = acquiredCost
        self.onPush = onPush
        _title = State(initialValue: String(summary.title.prefix(Self.titleLimit)))
        _condition = State(initialValue: EbayCondition.resolve(summary.condition))
        _conditionDescription = State(initialValue: summary.conditionDescription ?? "")
        _description = State(initialValue: summary.description)
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                aiCopyButton

                fieldGroup("Title") {
                    HStack {
                        Spacer()
                        Text("\(title.count)/\(Self.titleLimit)")
                            .font(.caption2)
                            .foregroundStyle(title.count >= Self.titleLimit ? .orange : .secondary)
                    }
                    TextField("Listing title", text: $title, axis: .vertical)
                        .lineLimit(1...3)
                        .textFieldStyle(.roundedBorder)
                        .onChange(of: title) { _, newValue in
                            if newValue.count > Self.titleLimit {
                                title = String(newValue.prefix(Self.titleLimit))
                            }
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
                }

                fieldGroup("Description") {
                    TextField("Listing description", text: $description, axis: .vertical)
                        .lineLimit(4...12)
                        .textFieldStyle(.roundedBorder)
                }

                HStack {
                    Text("Price")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(summary.currency ?? "USD") \(summary.priceValue)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.brandNavy)
                }
                profitEstimate
                Text("Edit price on the item canvas.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Button {
                    onPush(ComposerEdits(
                        title: trimmedTitle,
                        condition: condition,
                        conditionDescription: conditionDescription,
                        description: description
                    ))
                } label: {
                    Text("Push to eBay")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(trimmedTitle.isEmpty ? Color.secondary.opacity(0.3) : Color.brandNavy)
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                }
                .disabled(trimmedTitle.isEmpty)
                .padding(.top, 4)
            }
            .padding(14)
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
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

    // MARK: - Profit estimate

    @ViewBuilder
    private var profitEstimate: some View {
        let price = Double(summary.priceValue) ?? 0
        let estimate = ListingProfit.estimate(price: price, costBasis: acquiredCost)
        HStack(alignment: .firstTextBaseline) {
            Text("Est. net profit")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Text("\(Self.dollars(estimate.net)) · \(Int(estimate.marginPct.rounded()))% margin")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(profitColor(estimate))
                Text(profitDetail(estimate))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func profitColor(_ estimate: ListingProfit) -> Color {
        if estimate.net < 0 { return .red }
        if estimate.marginPct < 20 { return .orange }
        return .green
    }

    private func profitDetail(_ estimate: ListingProfit) -> String {
        var parts = ["eBay fees ~\(Self.dollars(estimate.fees))"]
        if acquiredCost == nil {
            parts.append("add cost for true margin")
        }
        return parts.joined(separator: " · ")
    }

    private static func dollars(_ amount: Double) -> String {
        "$" + String(format: "%.2f", amount)
    }
}
