import SwiftUI

/// General FlipDesk Automations surface (US-1135): list / create / edit / toggle
/// trigger → action rules, run them on demand, and preview/audit each rule via
/// dry-run + activity. Parity with the web Automations page; reuses the
/// repricing-rules UX patterns (phase switch, banner, swipe + toolbar actions).
struct AutomationsView: View {
    @State private var store = AutomationsStore()
    /// One optional driving ONE `.sheet(item:)`. A view has a single sheet
    /// slot, so two `.sheet` modifiers on it compete for that slot and the
    /// loser presents and is torn down in the same frame — see ``ToolModule``
    /// and `Scripts/check-chained-sheets.py`.
    @State private var sheet: AutomationRuleSheet?
    // US-1201: confirm before a swipe permanently deletes a configured rule.
    @State private var pendingDelete: AutomationRule?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        content
            .navigationTitle("Automations")
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
                    .accessibilityHint("Runs all active automation rules now")
                    .disabled(store.isRunning || !store.hasActiveRule)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        sheet = .editor(.new)
                    } label: {
                        Image(systemName: "plus").accessibilityLabel("New rule")
                    }
                }
            }
            .task { await store.load() }
            .refreshable { await store.load() }
            .sheet(item: $sheet) { item in
                switch item {
                case .editor(let target):
                    AutomationRuleEditorSheet(existing: target.rule, store: store)
                case .dryRun(let rule):
                    AutomationDryRunSheet(rule: rule, store: store)
                case .activity(let rule):
                    AutomationActivitySheet(rule: rule, store: store)
                }
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
            // US-1201: confirm rule deletion (it's irreversible).
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
                Label("Couldn't load automations", systemImage: "exclamationmark.triangle")
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
                        Text("Create a rule like “drop 10% after 30 days listed” and FlipDesk applies it for you. Use Dry run to preview which listings a rule would touch.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button {
                            sheet = .editor(.new)
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
                        RuleRow(rule: rule, isToggling: store.togglingIds.contains(rule.id)) {
                            Task { await store.toggleActive(rule) }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { sheet = .editor(.edit(rule)) }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                pendingDelete = rule
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                        .swipeActions(edge: .leading) {
                            Button {
                                sheet = .dryRun(rule)
                            } label: {
                                Label("Dry run", systemImage: "flask")
                            }
                            .tint(Color.brandNavy)
                        }
                        .contextMenu {
                            Button {
                                sheet = .dryRun(rule)
                            } label: {
                                Label("Dry run", systemImage: "flask")
                            }
                            Button {
                                sheet = .activity(rule)
                            } label: {
                                Label("Activity", systemImage: "clock.arrow.circlepath")
                            }
                            Button {
                                sheet = .editor(.edit(rule))
                            } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                        }
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

// MARK: - Row

private struct RuleRow: View {
    let rule: AutomationRule
    var isToggling: Bool = false
    let onToggle: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(rule.name)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    Text(rule.actionLabel)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.brandNavy)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Color.brandNavy.opacity(0.12), in: Capsule())
                }
                Text("When \(rule.triggerSummary), \(rule.actionSummary).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text(rule.scopeSummary)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            Spacer()
            Toggle("", isOn: Binding(get: { rule.isActive }, set: { _ in onToggle() }))
                .labelsHidden()
                .tint(Color.brandNavy)
                .disabled(isToggling) // US-1175: ignore taps while a toggle is in flight
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Editor target

enum AutomationEditorTarget: Identifiable {
    case new
    case edit(AutomationRule)

    var id: String {
        switch self {
        case .new: return "new"
        case .edit(let r): return r.id
        }
    }
    var rule: AutomationRule? {
        switch self {
        case .new: return nil
        case .edit(let r): return r
        }
    }
}

/// Secondary per-rule sheets (dry-run preview, activity log).
enum AutomationRuleSheet: Identifiable {
    /// Create or edit a rule.
    case editor(AutomationEditorTarget)
    case dryRun(AutomationRule)
    case activity(AutomationRule)

    var id: String {
        switch self {
        case .editor(let t): return "edit-\(t.id)"
        case .dryRun(let r): return "dry-\(r.id)"
        case .activity(let r): return "act-\(r.id)"
        }
    }
}

// MARK: - Dry-run sheet

private struct AutomationDryRunSheet: View {
    let rule: AutomationRule
    let store: AutomationsStore

    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .loading

    private enum Phase {
        case loading
        case loaded(AutomationDryRunResult)
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .loading:
                    ProgressView("Scanning listings…")
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Dry run failed", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try again") { Task { await run() } }
                            .buttonStyle(.borderedProminent)
                            .tint(Color.brandNavy)
                    }
                case .loaded(let result):
                    resultsList(result)
                }
            }
            .navigationTitle("Dry run")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await run() }
    }

    @ViewBuilder
    private func resultsList(_ result: AutomationDryRunResult) -> some View {
        if result.matches.isEmpty {
            ContentUnavailableView(
                "Nothing would change",
                systemImage: "checkmark.circle",
                description: Text("No listings match “\(rule.name)” right now (\(result.scanned) scanned). Nothing was applied.")
            )
        } else {
            List {
                Section {
                    Text("\(result.matches.count) listing\(result.matches.count == 1 ? "" : "s") would change (\(result.scanned) scanned). Nothing was applied.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("Affected") {
                    ForEach(result.matches) { match in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(match.displayTitle)
                                .font(.subheadline)
                                .lineLimit(1)
                            Text(changeSummary(match))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
    }

    private func changeSummary(_ m: AutomationDryRunMatch) -> String {
        switch m.actionType {
        case "price_drop_pct":
            if let next = m.newPriceCents {
                let floored = m.floored ? " (margin floor)" : ""
                return "\(AutomationFormat.money(m.currentPriceCents)) → \(AutomationFormat.money(next))\(floored)"
            }
            return "Price drop"
        case "set_promo_rate_pct":
            return "promo \(m.currentPromoRatePct ?? 0)% → \(m.newPromoRatePct ?? 0)%"
        default:
            return "Would be ended"
        }
    }

    private func run() async {
        phase = .loading
        do {
            let result = try await store.dryRun(rule)
            phase = .loaded(result)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

// MARK: - Activity sheet

private struct AutomationActivitySheet: View {
    let rule: AutomationRule
    let store: AutomationsStore

    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .loading

    private enum Phase: Equatable {
        case loading
        case loaded([AutomationActionRow])
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .loading:
                    ProgressView("Loading activity…")
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Couldn't load activity", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try again") { Task { await load() } }
                            .buttonStyle(.borderedProminent)
                            .tint(Color.brandNavy)
                    }
                case .loaded(let actions):
                    if actions.isEmpty {
                        ContentUnavailableView(
                            "No actions yet",
                            systemImage: "clock",
                            description: Text("“\(rule.name)” hasn't changed any listings yet.")
                        )
                    } else {
                        List(actions) { action in
                            ActivityRow(action: action)
                        }
                    }
                }
            }
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        phase = .loading
        do {
            let actions = try await store.activity(rule)
            phase = .loaded(actions)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

private struct ActivityRow: View {
    let action: AutomationActionRow

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(action.displayTitle)
                    .font(.subheadline)
                    .lineLimit(1)
                if let date = action.created {
                    Text(date, format: .dateTime.month().day())
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 6) {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !action.ebaySynced && action.actionType != "set_promo_rate_pct" {
                    Text("local only")
                        .font(.caption2)
                        .foregroundStyle(Color.brandAmber)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var summary: String {
        switch action.actionType {
        case "price_drop_pct":
            if let before = action.beforeJson?.priceCents, let after = action.afterJson?.priceCents {
                return "\(AutomationFormat.money(before)) → \(AutomationFormat.money(after))"
            }
            return "Price drop"
        case "set_promo_rate_pct":
            let before = action.beforeJson?.promoRatePct ?? 0
            let after = action.afterJson?.promoRatePct ?? 0
            return "promo \(before)% → \(after)%"
        default:
            return "Listing ended"
        }
    }
}
