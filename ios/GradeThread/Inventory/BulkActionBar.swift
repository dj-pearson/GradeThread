import SwiftUI

/// Floating bottom bar shown when one or more items are selected in
/// edit mode. Hosts stage-appropriate action buttons + a count badge.
struct BulkActionBar: View {
    let stage: InventoryStage
    let selectedCount: Int
    let onAction: (BulkAction) -> Void
    let onCancel: () -> Void

    var body: some View {
        let actions = BulkAction.actions(for: stage)
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 0) {
                Text("\(selectedCount)")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(.white)
                Text("selected")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.85))
            }
            .padding(.horizontal, 8)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(actions) { action in
                        Button {
                            onAction(action)
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: action.systemImage)
                                Text(action.label)
                            }
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(buttonBackground(for: action))
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            Button {
                onCancel()
            } label: {
                Image(systemName: "xmark")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(8)
                    .background(.white.opacity(0.15))
                    .clipShape(Circle())
            }
            .accessibilityLabel("Cancel selection")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color.brandNavy)
        .shadow(color: .black.opacity(0.25), radius: 10, x: 0, y: -2)
    }

    private func buttonBackground(for action: BulkAction) -> Color {
        if action.isDestructive { return Color.brandRed }
        return .white.opacity(0.18)
    }
}
