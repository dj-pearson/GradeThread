import SwiftUI

/// US-1294: the integrity banner shown above a Digital Slab (and reusable on any
/// certificate-facing surface). Renders the ``CertVerification`` verdict — a
/// confirmed pass, a tamper warning, a "no integrity record" notice, or a
/// transient "couldn't verify" with a retry — so a tampered/unavailable
/// certificate is always a clear, visible non-pass state (AC3).
struct CertIntegrityBadge: View {
    let verification: CertVerification
    /// Invoked from the "Try again" affordance on a transient failure.
    var onRetry: (() -> Void)? = nil

    private var display: CertVerificationDisplay { verification.display }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if case .verifying = verification {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 22)
                    .accessibilityHidden(true)
            } else {
                Image(systemName: display.systemImage)
                    .font(.title3)
                    .foregroundStyle(tint)
                    .frame(width: 22)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(display.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(tint)
                Text(display.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if display.retryable, let onRetry {
                    Button("Try again") {
                        AppRouter.haptic()
                        onRetry()
                    }
                    .font(.caption.weight(.semibold))
                    .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous)
                .strokeBorder(tint.opacity(0.35), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(display.title). \(display.detail)")
    }

    private var tint: Color {
        switch display.tone {
        case .verified: return .brandEmerald
        case .danger:   return .brandRed
        case .warning:  return .brandAmber
        case .neutral:  return .brandNavy
        }
    }
}
