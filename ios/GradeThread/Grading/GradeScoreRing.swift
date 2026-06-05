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

    private var color: Color { GradeScale.color(for: score) }
    private var fraction: Double { min(max(score / 10, 0), 1) }
    private var trimEnd: Double { (animateOnAppear && !revealed) ? 0 : fraction }
    /// Score the number renders. Starts at 0 and counts up to `score` under
    /// the same reveal animation as the ring fill.
    private var displayedScore: Double { (animateOnAppear && !revealed) ? 0 : score }

    var body: some View {
        ZStack {
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
                    .font(.system(size: diameter * 0.30, weight: .bold, design: .rounded))
                    .foregroundStyle(color)
                Text("of 10")
                    .font(.system(size: diameter * 0.11, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: diameter, height: diameter)
        .onAppear {
            guard animateOnAppear else { return }
            withAnimation(ReducedMotion.animation(.easeOut(duration: 0.7))) {
                revealed = true
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Grade \(String(format: "%.1f", score)) of 10, \(tier)")
    }

    private var lineWidth: CGFloat { diameter * 0.09 }
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
        .accessibilityLabel("Certified grade \(String(format: "%.1f", score))")
    }
}
