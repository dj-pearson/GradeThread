import SwiftUI

/// Dynamic-Type-aware sizing for SF Symbol glyphs used as the content of
/// interactive controls (icon buttons, slot controls, …).
///
/// `Image(systemName:).font(.system(size: 20))` pins the glyph to a fixed
/// point size that ignores the user's Dynamic Type / accessibility text
/// setting — so at AX5 an icon button stays tiny while everything around it
/// grows. `@ScaledMetric` scales a base value with the active text size, which
/// is the supported way to make a fixed-size glyph track Dynamic Type.
///
///     Image(systemName: "barcode.viewfinder")
///         .scaledIconFont(size: 20)                 // grows freely
///
///     Image(systemName: "plus")
///         .scaledIconFont(size: 20, maxSize: 40)    // grows, capped to fit a fixed frame
///
/// Pass `maxSize` for glyphs that live inside a fixed-size frame (e.g. a 64×64
/// capture slot): the glyph still grows with Dynamic Type but is clamped so it
/// can't overflow the frame and break layout at the largest accessibility size.
struct ScaledIconFont: ViewModifier {
    @ScaledMetric private var scaledSize: CGFloat
    private let weight: Font.Weight
    private let maxSize: CGFloat?

    init(
        size: CGFloat,
        weight: Font.Weight = .regular,
        relativeTo textStyle: Font.TextStyle = .body,
        maxSize: CGFloat? = nil
    ) {
        self._scaledSize = ScaledMetric(wrappedValue: size, relativeTo: textStyle)
        self.weight = weight
        self.maxSize = maxSize
    }

    func body(content: Content) -> some View {
        content.font(.system(size: Self.resolve(scaled: scaledSize, maxSize: maxSize), weight: weight))
    }

    /// Pure clamp: the Dynamic-Type-scaled size, capped to `maxSize` when set so
    /// a glyph inside a fixed frame can't overflow at the largest text sizes
    /// (US-1152). Factored out so the clamp is unit-testable.
    static func resolve(scaled: CGFloat, maxSize: CGFloat?) -> CGFloat {
        maxSize.map { min(scaled, $0) } ?? scaled
    }
}

extension View {
    /// Apply a Dynamic-Type-scaling system font sized for an icon glyph. See
    /// ``ScaledIconFont``. Pass `maxSize` to clamp growth inside a fixed frame.
    func scaledIconFont(
        size: CGFloat,
        weight: Font.Weight = .regular,
        relativeTo textStyle: Font.TextStyle = .body,
        maxSize: CGFloat? = nil
    ) -> some View {
        modifier(ScaledIconFont(size: size, weight: weight, relativeTo: textStyle, maxSize: maxSize))
    }
}
