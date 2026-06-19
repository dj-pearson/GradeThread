import SwiftUI

/// US-641 — pending-changes inspector. Opened by tapping the ``SyncStatusBar``.
/// Lists each queued ``SyncEngine/PendingMutationSnapshot`` with its target,
/// kind, age, retry count and last error, and offers per-row Retry / Discard.
/// "Failed" mutations (those carrying a `lastError`) are visually separated from
/// in-flight/queued ones so the user can see exactly what's stuck and why.
struct PendingChangesView: View {
    let engine: SyncEngine
    @Environment(\.dismiss) private var dismiss

    @State private var rows: [SyncEngine.PendingMutationSnapshot] = []
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if rows.isEmpty {
                    ContentUnavailableView(
                        "All caught up",
                        systemImage: "checkmark.circle",
                        description: Text("Every change has synced to the server.")
                    )
                } else {
                    List {
                        if !failedRows.isEmpty {
                            Section("Failed — needs attention") {
                                ForEach(failedRows) { row in rowView(row) }
                            }
                        }
                        if !queuedRows.isEmpty {
                            Section("Queued") {
                                ForEach(queuedRows) { row in rowView(row) }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Pending changes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await reload() }
        }
    }

    private var failedRows: [SyncEngine.PendingMutationSnapshot] { rows.filter(\.isFailed) }
    private var queuedRows: [SyncEngine.PendingMutationSnapshot] { rows.filter { !$0.isFailed } }

    @ViewBuilder
    private func rowView(_ row: SyncEngine.PendingMutationSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: icon(for: row))
                    .foregroundStyle(row.isFailed ? Color.brandRed : Color.secondary)
                Text(title(for: row.kind)).font(.subheadline.weight(.medium))
                Spacer()
                Text(age(row.createdAt)).font(.caption).foregroundStyle(.secondary)
            }
            if let target = row.targetId {
                Text(target).font(.caption2.monospaced()).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            if let error = row.lastError {
                Text(error).font(.caption).foregroundStyle(Color.brandRed)
            }
            if row.retryCount > 0 {
                Text("Attempted \(row.retryCount) time\(row.retryCount == 1 ? "" : "s")")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                Task { await engine.discardMutation(id: row.id); await reload() }
            } label: { Label("Discard", systemImage: "trash") }
            Button {
                Task { await engine.retryMutation(id: row.id); await reload() }
            } label: { Label("Retry", systemImage: "arrow.clockwise") }
            .tint(Color.brandNavy)
        }
    }

    private func reload() async {
        let next = await engine.pendingMutations()
        await MainActor.run {
            rows = next
            isLoading = false
        }
    }

    private func icon(for row: SyncEngine.PendingMutationSnapshot) -> String {
        if row.isFailed { return "exclamationmark.triangle.fill" }
        switch row.kind {
        case MutationKind.uploadPhoto.rawValue, MutationKind.deletePhoto.rawValue: return "photo"
        case MutationKind.deleteInventoryItem.rawValue, MutationKind.deleteExpense.rawValue: return "trash"
        case MutationKind.createSale.rawValue: return "dollarsign.circle"
        case MutationKind.createExpense.rawValue: return "creditcard"
        default: return "tray.and.arrow.up"
        }
    }

    private func title(for kind: String) -> String {
        switch MutationKind(rawValue: kind) {
        case .createInventoryItem: return "Add item"
        case .updateInventoryItem: return "Edit item"
        case .deleteInventoryItem: return "Delete item"
        case .uploadPhoto: return "Upload photo"
        case .deletePhoto: return "Delete photo"
        case .createListing: return "Create listing"
        case .createSale: return "Record sale"
        case .createExpense: return "Add expense"
        case .deleteExpense: return "Delete expense"
        case .none: return kind
        }
    }

    private func age(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: .now)
    }
}
