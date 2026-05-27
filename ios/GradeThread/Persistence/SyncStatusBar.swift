import SwiftUI

/// Slim banner at the top of the main shell that reflects the sync state.
/// Disappears entirely when the engine is idle and the pending queue is
/// empty — quiet by default, loud only when something needs the user's
/// attention.
struct SyncStatusBar: View {
    @Environment(SyncStatusStore.self) private var status

    var body: some View {
        if let descriptor = descriptor {
            HStack(spacing: 8) {
                descriptor.icon
                Text(descriptor.label).font(.footnote.weight(.medium))
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .background(descriptor.background)
            .foregroundStyle(descriptor.foreground)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    private var descriptor: Descriptor? {
        switch status.phase {
        case .idle:
            return nil
        case .syncing:
            return Descriptor(
                label: "Syncing…",
                icon: AnyView(
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                ),
                background: Color.brandNavy,
                foreground: .white
            )
        case .pending:
            return Descriptor(
                label: "\(status.pendingCount) pending change\(status.pendingCount == 1 ? "" : "s")",
                icon: AnyView(Image(systemName: "tray.and.arrow.up")),
                background: Color.orange.opacity(0.15),
                foreground: .orange
            )
        case .offline:
            return Descriptor(
                label: "Offline — changes will sync when you reconnect",
                icon: AnyView(Image(systemName: "wifi.slash")),
                background: Color.secondary.opacity(0.15),
                foreground: .secondary
            )
        }
    }

    private struct Descriptor {
        let label: String
        let icon: AnyView
        let background: Color
        let foreground: Color
    }
}
