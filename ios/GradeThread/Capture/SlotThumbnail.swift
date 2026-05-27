import SwiftUI

/// One slot in the bottom strip. Renders either the captured thumbnail or
/// an empty state with the slot's SF Symbol + label. Active slot gets a
/// brand-navy ring; filled slots get a checkmark badge. While an upload
/// is in flight for the slot, a progress overlay covers the thumbnail.
struct SlotThumbnail: View {
    let slot: PhotoSlotType
    let capture: PhotoCapture?
    let isActive: Bool
    /// Upload phase for the photo in this slot, if any. nil = not
    /// uploading (either not started or already done).
    var uploadPhase: PhotoUploadTask.Phase? = nil

    /// Whether the slot reads as "captured". Separate accessor so the
    /// checkmark badge updates with `capture` without touching `isActive`.
    private var isFilled: Bool { capture != nil }

    private var uploadProgress: Double? {
        guard case let .uploading(progress) = uploadPhase else { return nil }
        return progress
    }

    private var uploadFailed: Bool {
        if case .failed = uploadPhase { return true }
        return false
    }

    private var uploadComplete: Bool {
        if case .uploaded = uploadPhase { return true }
        return false
    }

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
                    badgeOverlay
                }
                if let progress = uploadProgress {
                    progressOverlay(progress: progress)
                }
                if uploadFailed {
                    failureOverlay
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

    // MARK: - Overlays

    private var badgeOverlay: some View {
        VStack {
            HStack {
                Spacer()
                Image(systemName: uploadComplete ? "checkmark.circle.fill" : "circle.dashed")
                    .foregroundStyle(.white, uploadComplete ? Color.brandNavy : Color.gray)
                    .font(.system(size: 18))
                    .padding(4)
            }
            Spacer()
        }
    }

    private func progressOverlay(progress: Double) -> some View {
        // Dim the thumbnail + draw a ring-style progress indicator that
        // overlays the same position the badge uses, so the slot never
        // shows both at once.
        ZStack {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(.black.opacity(0.45))

            Circle()
                .stroke(.white.opacity(0.25), lineWidth: 3)
                .frame(width: 32, height: 32)
            Circle()
                .trim(from: 0, to: progress)
                .stroke(.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .frame(width: 32, height: 32)
                .rotationEffect(.degrees(-90))
                .animation(.linear(duration: 0.2), value: progress)
        }
    }

    private var failureOverlay: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(.red.opacity(0.45))
            VStack(spacing: 2) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                Text("Retry")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white)
            }
        }
    }

    private var accessibilityLabel: String {
        if let progress = uploadProgress {
            return "\(slot.label) — uploading \(Int(progress * 100)) percent"
        }
        if uploadFailed { return "\(slot.label) — upload failed, tap to retry" }
        if uploadComplete { return "\(slot.label) — uploaded" }
        if isFilled { return "\(slot.label) — captured" }
        if isActive { return "\(slot.label) — active slot" }
        return "\(slot.label) — empty"
    }
}
