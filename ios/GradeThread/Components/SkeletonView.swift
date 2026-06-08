import SwiftUI

/// A shimmering placeholder block for skeleton loading states. Renders a
/// muted rounded rectangle with a diagonal highlight that sweeps across it
/// while content loads — a more premium feel than a bare spinner.
///
/// Honors Reduce Motion: when it's on, the block is a static muted fill with
/// no sweep. Always `accessibilityHidden` — skeletons are decorative.
struct SkeletonBlock: View {
    var cornerRadius: CGFloat = 8
    @State private var animate = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        shape
            .fill(Color.secondary.opacity(0.18))
            .overlay {
                if !ReducedMotion.isEnabled {
                    GeometryReader { geo in
                        LinearGradient(
                            colors: [.clear, Color.white.opacity(0.45), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: geo.size.width * 0.6)
                        .offset(x: animate ? geo.size.width : -geo.size.width * 0.6)
                    }
                }
            }
            .clipShape(shape)
            .onAppear {
                guard !ReducedMotion.isEnabled else { return }
                withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
                    animate = true
                }
            }
            .accessibilityHidden(true)
    }
}

/// A circular shimmer placeholder (e.g. for the grade score ring).
struct SkeletonCircle: View {
    var diameter: CGFloat
    @State private var animate = false

    var body: some View {
        Circle()
            .fill(Color.secondary.opacity(0.18))
            .overlay {
                if !ReducedMotion.isEnabled {
                    GeometryReader { geo in
                        LinearGradient(
                            colors: [.clear, Color.white.opacity(0.45), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: geo.size.width * 0.6)
                        .offset(x: animate ? geo.size.width : -geo.size.width * 0.6)
                    }
                }
            }
            .clipShape(Circle())
            .frame(width: diameter, height: diameter)
            .onAppear {
                guard !ReducedMotion.isEnabled else { return }
                withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
                    animate = true
                }
            }
            .accessibilityHidden(true)
    }
}

/// US-656 — a reusable list-shaped skeleton (leading block + two text lines per
/// row) for the main-content loading state of list screens, replacing bare
/// spinners. Honors Reduce Motion via the underlying `SkeletonBlock`.
struct SkeletonRows: View {
    var count: Int = 6
    var showsLeadingBlock: Bool = true

    var body: some View {
        VStack(spacing: 16) {
            ForEach(0..<count, id: \.self) { _ in
                HStack(spacing: 12) {
                    if showsLeadingBlock {
                        SkeletonBlock(cornerRadius: CornerRadius.chip)
                            .frame(width: 44, height: 44)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        SkeletonLine(widthFraction: 0.6, height: 12)
                        SkeletonLine(widthFraction: 0.35, height: 10)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .top)
        .accessibilityHidden(true)
    }
}

/// A single shimmer text-line of a given width fraction.
struct SkeletonLine: View {
    var widthFraction: CGFloat = 1
    var height: CGFloat = 12

    var body: some View {
        GeometryReader { geo in
            SkeletonBlock(cornerRadius: height / 2)
                .frame(width: geo.size.width * widthFraction, height: height)
        }
        .frame(height: height)
    }
}
