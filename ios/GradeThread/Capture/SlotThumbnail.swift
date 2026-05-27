import SwiftUI

/// One slot in the bottom strip. Renders either the captured thumbnail or
/// an empty state with the slot's SF Symbol + label. Active slot gets a
/// brand-navy ring; filled slots get a checkmark badge.
struct SlotThumbnail: View {
    let slot: PhotoSlotType
    let capture: PhotoCapture?
    let isActive: Bool

    /// Whether the slot reads as "captured". Separate accessor so the
    /// checkmark badge updates with `capture` without touching `isActive`.
    private var isFilled: Bool { capture != nil }

    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.white.opacity(isFilled ? 0 : 0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(
                                isActive ? Color.brandNavy : Color.white.opacity(0.4),
                                lineWidth: isActive ? 3 : 1
                            )
                    )

                if let capture {
                    Image(uiImage: capture.thumbnail)
                        .resizable()
                        .scaledToFill()
                        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                } else {
                    Image(systemName: slot.systemImage)
                        .font(.system(size: 22, weight: .light))
                        .foregroundStyle(.white.opacity(isActive ? 0.9 : 0.6))
                }

                if isFilled {
                    VStack {
                        HStack {
                            Spacer()
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.white, Color.brandNavy)
                                .font(.system(size: 18))
                                .padding(4)
                        }
                        Spacer()
                    }
                }
            }
            .frame(width: 64, height: 64)

            Text(slot.label)
                .font(.caption2.weight(isActive ? .semibold : .regular))
                .foregroundStyle(.white)
                .lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    private var accessibilityLabel: String {
        if isFilled { return "\(slot.label) — captured" }
        if isActive { return "\(slot.label) — active slot" }
        return "\(slot.label) — empty"
    }
}
