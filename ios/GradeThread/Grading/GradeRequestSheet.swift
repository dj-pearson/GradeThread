import SwiftData
import SwiftUI

/// The certified-grade request flow, presented as a sheet from the item
/// canvas. Walks the reseller through: readiness check → tier choice →
/// submit → live grading → the finished report with a shareable certificate.
struct GradeRequestSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    /// The item being graded. Updated optimistically on completion so the
    /// canvas + list reflect the new grade before the next sync pull.
    let item: LocalInventoryItem

    // Optional + created in `.task` (main-actor) rather than in the View's
    // init, mirroring ItemCanvasState — constructing a @MainActor store in a
    // View initializer trips main-actor isolation.
    @State private var store: GradeRequestStore?

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
        }
        .interactiveDismissDisabled(isWorking)
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
        case let .failed(message):
            failedContent(store, message)
        }
    }

    private var closeButtonTitle: String {
        switch store?.phase {
        case .completed?, .stillProcessing?: return "Done"
        default: return "Cancel"
        }
    }

    private var isWorking: Bool {
        switch store?.phase {
        case .submitting?, .processing?: return true
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
                        creditsBanner
                    }

                    submitButton(store)

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
            .foregroundStyle(.green)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Color.green.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
    }

    private func blockersBanner(_ validatedItem: GradingValidatedItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Not ready yet", systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.orange)
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
        .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
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
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(selected ? Color.brandNavy : Color.secondary.opacity(0.25), lineWidth: selected ? 2 : 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func planSummary(_ store: GradeRequestStore, user: GradingUserInfo) -> some View {
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
        .padding(14)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    /// What this grade costs the user: free if covered by an included
    /// Standard grade, otherwise the tier's credit cost.
    private func costLabel(_ store: GradeRequestStore, user: GradingUserInfo) -> String {
        if store.tier == .standard && user.includedRemaining > 0 {
            return "Included"
        }
        let credits = store.tier.creditCost
        return "\(credits) credit\(credits == 1 ? "" : "s")"
    }

    private var creditsBanner: some View {
        Label("Not enough grading credits for this tier. Buy a credit pack or upgrade your plan on the web to continue.", systemImage: "creditcard.trianglebadge.exclamationmark")
            .font(.caption)
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Color.brandRed.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
    }

    private func submitButton(_ store: GradeRequestStore) -> some View {
        Button {
            AppRouter.haptic()
            Task { await store.submit() }
        } label: {
            Label("Get certified grade", systemImage: "checkmark.seal.fill")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
        }
        .buttonStyle(.borderedProminent)
        .tint(Color.brandNavy)
        .disabled(!store.canSubmit)
    }

    // MARK: - Processing / still-processing

    private func processingContent(title: String, message: String) -> some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
                .tint(Color.brandNavy)
            Text(title).font(.headline)
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
    private func applyGradeToItem(_ report: GradeReportDTO, certificateURL: URL?) {
        item.gradeValue = report.overallScore
        item.gradeLabel = report.gradeTier
        if let certificateURL { item.certificateURL = certificateURL.absoluteString }
        if item.status == "cataloged" || item.status == "photographed" || item.status == "measured" {
            item.status = "graded"
        }
        item.updatedAt = .now
        try? modelContext.save()
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
