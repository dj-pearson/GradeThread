import SwiftUI

/// Batch certified-grading sheet, presented from the inventory multi-select
/// bar. Validates the whole selection, lets the user pick a tier, and submits
/// the ready items in one shot (blocked items are listed + skipped).
struct BulkGradeSheet: View {
    @Environment(\.dismiss) private var dismiss

    let itemIds: [String]
    /// Called after a successful submit so the list can clear selection +
    /// trigger a sync to pull the landing grades.
    let onSubmitted: () -> Void

    @State private var store: BulkGradeStore?

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
                    if validation.limitExceeded { creditsBanner }
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
                .foregroundStyle(ready > 0 ? .green : .secondary)
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
        return HStack {
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
        .padding(14)
        .cardStyle(.flush)  // US-691: unified card chrome
    }

    private var creditsBanner: some View {
        Label("Not enough grading credits for this batch at this tier. Buy a credit pack or upgrade on the web, or pick a cheaper tier.", systemImage: "creditcard.trianglebadge.exclamationmark")
            .font(.caption)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Color.brandRed.opacity(0.10), in: RoundedRectangle(cornerRadius: CornerRadius.control))
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
                    Text(item.blockers.first.map(humanize) ?? "Not ready")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: CornerRadius.control))
    }

    private func submitButton(_ store: BulkGradeStore) -> some View {
        let count = store.readyItems.count
        return Button {
            AppRouter.haptic()
            Task { await store.submit() }
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
