import SwiftUI

/// Circular 1–10 grade indicator. The ring fills proportional to the score
/// and is tinted by ``GradeScale``. Reused by the report view and (smaller)
/// elsewhere a certified grade is surfaced.
struct GradeScoreRing: View {
    let score: Double
    let tier: String
    var diameter: CGFloat = 96

    private var color: Color { GradeScale.color(for: score) }
    private var fraction: Double { min(max(score / 10, 0), 1) }

    var body: some View {
        ZStack {
            Circle()
                .stroke(color.opacity(0.18), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(
                    color,
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                Text(String(format: "%.1f", score))
                    .font(.system(size: diameter * 0.30, weight: .bold, design: .rounded))
                    .foregroundStyle(color)
                Text("of 10")
                    .font(.system(size: diameter * 0.11, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: diameter, height: diameter)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Grade \(String(format: "%.1f", score)) of 10, \(tier)")
    }

    private var lineWidth: CGFloat { diameter * 0.09 }
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
