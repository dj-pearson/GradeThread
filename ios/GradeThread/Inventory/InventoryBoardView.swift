import SwiftData
import SwiftUI

/// US-813: the inventory view-mode toggle (list ↔ kanban board), mirroring the
/// web `InventoryViewSwitcher`. Persisted in the parent view's `@State`.
enum InventoryViewMode: String, CaseIterable, Identifiable {
    case list
    case board

    var id: String { rawValue }

    var label: String {
        switch self {
        case .list:  return "List"
        case .board: return "Board"
        }
    }

    var systemImage: String {
        switch self {
        case .list:  return "list.bullet"
        case .board: return "rectangle.split.3x1"
        }
    }
}

/// US-813: horizontally-scrollable kanban board for the inventory pipeline. One
/// column per ``PipelineBoard`` status (mirrors the web `FlipdeskPipelinePage`),
/// each column lazily rendering its item cards. Tapping a card pushes the item
/// canvas via the hosting `NavigationStack`; a per-card "Move to…" context menu
/// performs an optimistic stage move whose server write + revert is owned by the
/// parent (``BulkActionExecutor/moveStatus(_:to:)``).
///
/// Performance: the outer `LazyHStack` realizes only visible columns and each
/// column's `LazyVStack` realizes only visible cards, so a 500+-item catalog
/// scrolls without building every card up front. The status grouping recomputes
/// only when the item set actually changes (see ``signature``) rather than on
/// every `body` pass.
struct InventoryBoardView: View {
    /// Already search/criteria-filtered items across every stage.
    let items: [LocalInventoryItem]
    /// Performs the stage move (optimistic write + server + revert + toast). The
    /// parent owns failure surfacing; the board just invokes it.
    let onMove: (LocalInventoryItem, String) async -> Void

    /// Memoized status→items grouping, rebuilt only when ``signature`` changes —
    /// the lighter US-1017 memo pattern (a plain `@State` value refreshed via
    /// `.onChange(initial:)` instead of recomputing every `body`).
    @State private var grouped: [String: [LocalInventoryItem]] = [:]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 12) {
                ForEach(PipelineBoard.columns) { column in
                    BoardColumn(
                        column: column,
                        items: grouped[column.status] ?? [],
                        onMove: onMove
                    )
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .frame(maxHeight: .infinity)
        .background(Color(uiColor: .systemGroupedBackground))
        .onChange(of: signature, initial: true) {
            grouped = PipelineBoard.group(items, status: \.status)
        }
    }

    /// Cheap content signature folding each row's `id` + `status` (the only
    /// fields the grouping reads) so a move re-buckets but unrelated renders
    /// reuse the cache.
    private var signature: Int {
        var hasher = Hasher()
        hasher.combine(items.count)
        for item in items {
            hasher.combine(item.id)
            hasher.combine(item.status)
        }
        return hasher.finalize()
    }
}

// MARK: - Column

private struct BoardColumn: View {
    let column: PipelineColumn
    let items: [LocalInventoryItem]
    let onMove: (LocalInventoryItem, String) async -> Void

    /// Cap the cards realized per column so a runaway single stage (e.g. 1,000
    /// sourced items) can't stall layout. Mirrors the web `COLUMN_CAP`.
    private static let cap = 50

    /// US-1185: items beyond the cap used to be an unreachable "+N more" label.
    /// Tapping it now reveals the rest so capped items can be opened/moved.
    @State private var showingAll = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if items.isEmpty {
                emptyState
            } else {
                cards
            }
        }
        .frame(width: 264, alignment: .top)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous))
        // Collapse back to the cap when this column drops below it (e.g. items
        // moved out) so the expanded state doesn't get stuck.
        .onChange(of: items.count) { _, count in
            if count <= Self.cap { showingAll = false }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(StatusBadge.tone(for: column.status))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(column.label)
                    .font(.subheadline.weight(.semibold))
                Text("Next: \(column.nextAction)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Text("\(items.count)")
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Color.secondary.opacity(0.12), in: Capsule())
        }
        .padding(12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(column.label), \(items.count) items")
    }

    private var emptyState: some View {
        Text("No items")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 36)
    }

    private var cards: some View {
        let visible = showingAll ? items : Array(items.prefix(Self.cap))
        return ScrollView(.vertical, showsIndicators: false) {
            LazyVStack(spacing: 8) {
                ForEach(visible, id: \.id) { item in
                    NavigationLink(value: item) {
                        BoardCard(item: item)
                    }
                    .buttonStyle(.plain)
                    .contextMenu { moveMenu(for: item) }
                }
                if items.count > Self.cap {
                    Button {
                        withAnimation { showingAll.toggle() }
                    } label: {
                        Text(showingAll ? "Show fewer" : "+\(items.count - Self.cap) more")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Color.brandNavy)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(10)
        }
    }

    @ViewBuilder
    private func moveMenu(for item: LocalInventoryItem) -> some View {
        Menu {
            ForEach(PipelineBoard.columns.filter { $0.status != item.status }) { target in
                Button {
                    Task { await onMove(item, target.status) }
                } label: {
                    Label(target.label, systemImage: "arrow.right.circle")
                }
            }
        } label: {
            Label("Move to…", systemImage: "arrow.left.arrow.right")
        }
    }
}

// MARK: - Card

private struct BoardCard: View {
    let item: LocalInventoryItem
    // US-1517: shared cached formatter — one card per visible board cell.
    private var currencyFormatter: CurrencyFormatter { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.title)
                .font(.caption.weight(.semibold))
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .foregroundStyle(.primary)
            if let subtitle {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            HStack(spacing: 6) {
                if let priceLabel {
                    Text(priceLabel)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if let grade = item.gradeValue {
                    Text(String(format: "%.1f", grade))
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.brandNavy, in: Capsule())
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .systemBackground))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(StatusBadge.tone(for: item.status))
                .frame(width: 3)
        }
        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.chip, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Opens the item. Touch and hold to move it to another stage.")
    }

    private var subtitle: String? {
        let parts = [item.brand, item.size].compactMap { $0?.boardTrimmed }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var priceLabel: String? {
        if let listing = item.listingPrice { return currencyFormatter.formatDisplay(listing) }
        if let target = item.targetPrice { return currencyFormatter.formatDisplay(target) }
        if let cost = item.acquiredPrice { return currencyFormatter.formatDisplay(cost) }
        return nil
    }

    private var accessibilityLabel: String {
        var parts: [String] = [item.title]
        if let subtitle { parts.append(subtitle) }
        if let priceLabel { parts.append(priceLabel) }
        if let grade = item.gradeValue { parts.append("Grade \(String(format: "%.1f", grade))") }
        parts.append("Status \(StatusBadge.label(for: item.status))")
        return parts.joined(separator: ". ")
    }
}

private extension String {
    var boardTrimmed: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
