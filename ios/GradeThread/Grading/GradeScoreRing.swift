import SwiftUI

/// Circular 1–10 grade indicator. The ring fills proportional to the score
/// and is tinted by ``GradeScale``. Reused by the report view and (smaller)
/// elsewhere a certified grade is surfaced.
struct GradeScoreRing: View {
    let score: Double
    let tier: String
    var diameter: CGFloat = 96
    /// Animate the ring filling in on first appearance. Off for the small
    /// list/canvas chips where it'd be distracting.
    var animateOnAppear: Bool = true

    @State private var revealed = false

    /// US-655: a tier-tinted glow makes a high grade feel celebratory. Honors
    /// Reduce Transparency (the glow is a blurred translucent layer).
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    /// US-707: the ring (and the score font derived from its diameter) must
    /// grow with Dynamic Type. `typeScale` is 100 at the default content size
    /// and scales up with the user's setting; we clamp the factor so the small
    /// list/canvas chips don't blow out their rows at AX5.
    @ScaledMetric(relativeTo: .largeTitle) private var typeScale: CGFloat = 100
    private var effectiveDiameter: CGFloat {
        diameter * min(max(typeScale / 100, 1.0), 1.6)
    }

    private var color: Color { GradeScale.color(for: score) }
    private var fraction: Double { min(max(score / 10, 0), 1) }
    private var trimEnd: Double { (animateOnAppear && !revealed) ? 0 : fraction }
    /// Score the number renders. Starts at 0 and counts up to `score` under
    /// the same reveal animation as the ring fill.
    private var displayedScore: Double { (animateOnAppear && !revealed) ? 0 : score }

    /// Glow strength keyed to the tier — pristine (9.5+) blooms, mid grades are
    /// subtle, low grades barely glow.
    private var glowOpacity: Double {
        if score >= 9.5 { return 0.5 }
        if score >= 7.0 { return 0.28 }
        if score >= 5.0 { return 0.15 }
        return 0.10
    }

    var body: some View {
        ZStack {
            // US-655: tier-tinted radial glow behind the ring. Skipped under
            // Reduce Transparency; fades in with the same reveal animation as
            // the fill (so Reduce Motion suppresses the bloom too).
            if !reduceTransparency {
                Circle()
                    .fill(color)
                    .blur(radius: effectiveDiameter * 0.20)
                    .opacity(revealed || !animateOnAppear ? glowOpacity : 0)
                    .scaleEffect(0.92)
                    .allowsHitTesting(false)
            }
            Circle()
                .stroke(color.opacity(0.18), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: trimEnd)
                .stroke(
                    color,
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                CountingNumber(value: displayedScore)
                    // US-654: the hero grade number uses the Outfit display face.
                    // US-707: size derives from the Dynamic-Type-scaled diameter.
                    .font(.brandScore(effectiveDiameter * 0.30))
                    .foregroundStyle(color)
                Text("of 10")
                    .font(.custom(BrandFont.interMedium, size: effectiveDiameter * 0.11))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: effectiveDiameter, height: effectiveDiameter)
        .onAppear {
            guard animateOnAppear else { return }
            withAnimation(ReducedMotion.animation(.easeOut(duration: 0.7))) {
                revealed = true
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Grade \(String(format: "%.1f", score)) of 10, \(tier)")
    }

    private var lineWidth: CGFloat { effectiveDiameter * 0.09 }
}

/// A one-decimal number that animates between values: SwiftUI interpolates
/// `animatableData` so the text counts up when `value` changes inside a
/// `withAnimation`. Monospaced digits keep the width steady mid-count.
private struct CountingNumber: View, Animatable {
    var value: Double

    var animatableData: Double {
        get { value }
        set { value = newValue }
    }

    var body: some View {
        Text(String(format: "%.1f", max(0, value)))
            .monospacedDigit()
    }
}

/// Compact grade chip for inventory rows / canvas headers.
struct GradeChip: View {
    let score: Double
    let label: String?

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "checkmark.seal.fill")
                .font(.caption2)
            Text(String(format: "%.1f", score))
                .font(.caption2.weight(.bold))
            if let label, !label.isEmpty {
                Text(label)
                    .font(.caption2.weight(.medium))
                    .lineLimit(1)
            }
        }
        .foregroundStyle(GradeScale.color(for: score))
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(GradeScale.color(for: score).opacity(0.12))
        .clipShape(Capsule())
        // US-1151: collapse the decorative seal + digits into one element so
        // VoiceOver speaks just the explicit label, not "checkmark seal, 8.5".
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            label.map { "Certified grade \(String(format: "%.1f", score)), \($0)" }
                ?? "Certified grade \(String(format: "%.1f", score))")
    }
}
