import SwiftUI

/// Repricing automation (US-672): manage price-drop rules that run server-side
/// on a cadence, run them on demand, and review the applied-changes feed.
struct RepricingRulesView: View {
    @State private var store = RepricingRulesStore()
    @State private var editing: RuleEditorTarget?
    // US-1198: confirm before deleting a configured rule.
    @State private var pendingDelete: RepricingRule?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let currency = CurrencyFormatter()

    var body: some View {
        content
            .navigationTitle("Automation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { await store.runNow() }
                    } label: {
                        if store.isRunning {
                            ProgressView()
                        } else {
                            Label("Run now", systemImage: "play.circle")
                        }
                    }
                    .accessibilityHint("Applies all active price rules to your listings now")
                    .disabled(store.isRunning || store.isEmpty)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        editing = .new
                    } label: {
                        Image(systemName: "plus").accessibilityLabel("New rule")
                    }
                }
            }
            .task { await store.load() }
            .refreshable { await store.load() }
            .sheet(item: $editing) { target in
                RuleEditorSheet(existing: target.rule, store: store)
            }
            .overlay(alignment: .bottom) { bannerView }
            .task(id: store.banner) {
                guard store.banner != nil else { return }
                try? await Task.sleep(for: .seconds(2.5))
                withAnimation(ReducedMotion.animation(.default)) { store.banner = nil }
            }
            .alert(
                "Something went wrong",
                isPresented: Binding(
                    get: { store.actionError != nil },
                    set: { if !$0 { store.actionError = nil } }
                ),
                presenting: store.actionError
            ) { _ in
                Button("OK", role: .cancel) { store.actionError = nil }
            } message: { Text($0) }
            // US-1198: confirm before destroying a configured rule.
            .confirmationDialog(
                "Delete this rule?",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                presenting: pendingDelete
            ) { rule in
                Button("Delete", role: .destructive) {
                    Task { await store.delete(rule) }
                    pendingDelete = nil
                }
                Button("Cancel", role: .cancel) { pendingDelete = nil }
            } message: { rule in
                Text("“\(rule.name)” will be removed. This can't be undone.")
            }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading:
            ScrollView { SkeletonRows(count: 5) }

        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load rules", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
            }

        case .ready:
            list
        }
    }

    private var list: some View {
        List {
            if store.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("No automation rules yet")
                            .font(.subheadline.weight(.semibold))
                        Text("Create a rule to drop prices on stale inventory automatically — e.g. “drop 10% every 7 days, floor $9.99”. Rules run daily on the server and whenever you tap Run now.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button {
                            editing = .new
                        } label: {
                            Label("New rule", systemImage: "plus")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.brandNavy)
                        .padding(.top, 4)
                    }
                    .padding(.vertical, 4)
                }
            } else {
                Section("Rules") {
                    ForEach(store.rules) { rule in
                        RuleRow(rule: rule) {
                            Task { await store.toggleEnabled(rule) }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { editing = .edit(rule) }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                pendingDelete = rule
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
            }

            if !store.actions.isEmpty {
                Section("Recent changes") {
                    ForEach(store.actions) { action in
                        ActionRow(action: action, currency: currency)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var bannerView: some View {
        if let banner = store.banner {
            Text(banner)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(Color.brandNavy, in: Capsule())
                .padding(.bottom, 16)
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        }
    }
}

// MARK: - Rows

private struct RuleRow: View {
    let rule: RepricingRule
    let onToggle: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(rule.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(rule.actionSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(rule.scopeSummary)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            Spacer()
            Toggle("", isOn: Binding(get: { rule.enabled }, set: { _ in onToggle() }))
                .labelsHidden()
                .tint(Color.brandNavy)
        }
        .padding(.vertical, 2)
    }
}

private struct ActionRow: View {
    let action: RepricingAction
    let currency: CurrencyFormatter

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(action.title)
                    .font(.subheadline)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    Text(action.reasonLabel)
                    if let date = action.created {
                        Text("· \(date, format: .dateTime.month().day())")
                    }
                    if !action.ebaySynced {
                        Text("· local only")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Text(currency.formatDisplay(action.newDollars))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
                Text(currency.formatDisplay(action.oldDollars))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .strikethrough()
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Editor target

enum RuleEditorTarget: Identifiable {
    case new
    case edit(RepricingRule)

    var id: String {
        switch self {
        case .new: return "new"
        case .edit(let r): return r.id
        }
    }
    var rule: RepricingRule? {
        switch self {
        case .new: return nil
        case .edit(let r): return r
        }
    }
}
