import SwiftUI

/// US-753: one shared item-status badge so a status looks identical across
/// Inventory, Sales, Money, and Marketplaces — replacing the per-screen
/// hand-rolled badges the app accumulated. The tone mapping mirrors the web
/// status system (US-728) and the prior InventoryRow colors (US-653):
/// pre-list prep reads steel-navy work-in-progress, drafted amber, listed
/// brand navy, sold/shipped/completed emerald, returned red.
struct StatusBadge: View {
    let status: String

    var body: some View {
        Text(Self.label(for: status))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Self.tone(for: status))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Self.tone(for: status).opacity(0.12))
            .clipShape(Capsule())
    }

    /// Human-readable label (snake_case → Title Case), e.g. "to_list" → "To List".
    static func label(for status: String) -> String {
        status
            .split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    /// Pipeline-phase color. Exposed statically so callers (e.g. an
    /// accessibility label) can reuse the same mapping without rebuilding it.
    static func tone(for status: String) -> Color {
        switch status {
        case "sold", "shipped", "completed":
            return .brandEmerald
        case "listed", "active":
            return .brandNavy
        case "drafted":
            return .brandAmber
        case "returned":
            return .brandRed
        case "sourced", "cataloged", "measured",
             "photographed", "grading", "graded", "comped":
            return .brandSteelNavy
        default:
            return .secondary
        }
    }
}
