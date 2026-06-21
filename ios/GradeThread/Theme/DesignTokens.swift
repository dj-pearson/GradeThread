import SwiftUI

// MARK: - Design tokens (US-652)

/// One reusable style layer so cards, buttons, spacing and radii are declared
/// once instead of hand-rolled in ~100 places. Before this, the card treatment
/// (`secondarySystemGroupedBackground` + a `RoundedRectangle` clip) appeared
/// 103 times across 25 files with mixed radii (12/14/16) and padding (14/16).
///
/// Usage:
///   VStack { … }.cardStyle()                    // standard grouped card
///   VStack { … }.cardStyle(.flush)              // no inner padding (rows/lists)
///   Button("Save") { … }.buttonStyle(.brandPrimary)
///   Button("Cancel") { … }.buttonStyle(.brandSecondary)
///
/// New screens should reach for these rather than re-declaring chrome.

/// 4-pt spacing scale. Use the named steps so padding/stacks stay consistent.
enum Spacing {
    /// 4
    static let xxs: CGFloat = 4
    /// 8
    static let xs: CGFloat = 8
    /// 12
    static let sm: CGFloat = 12
    /// 16 — the default card / screen inset.
    static let md: CGFloat = 16
    /// 20
    static let lg: CGFloat = 20
    /// 24
    static let xl: CGFloat = 24
    /// 32
    static let xxl: CGFloat = 32
}

/// Unified corner radii. Cards settle on 16; inline controls/thumbnails on 12;
/// small chips/badges on 9. No more mixing 12/14/16 for the same element class.
enum CornerRadius {
    /// 16 — cards and sheets.
    static let card: CGFloat = 16
    /// 12 — buttons, controls, thumbnails.
    static let control: CGFloat = 12
    /// 9 — chips, badges, small tiles.
    static let chip: CGFloat = 9
    /// 999 — fully rounded (pills).
    static let pill: CGFloat = 999
}

// MARK: - Card

/// How a card lays out its own padding.
enum CardStylePadding {
    /// Standard 16-pt inset on all edges.
    case standard
    /// No inner padding — for cards that host their own `List`/rows and need
    /// edge-to-edge content (the card still clips + fills the background).
    case flush
    /// A custom uniform inset.
    case inset(CGFloat)

    var value: CGFloat? {
        switch self {
        case .standard: return Spacing.md
        case .flush: return nil
        case .inset(let v): return v
        }
    }
}

/// The canonical grouped-card chrome: a `secondarySystemGroupedBackground`
/// fill clipped to ``CornerRadius/card``. Replaces the hand-rolled
/// `.background(...).clipShape(RoundedRectangle(...))` pattern everywhere.
///
/// `.flush` is a pure chrome swap (background + clip only) so an existing card
/// that already declares its own `.padding`/`.frame` can migrate one-for-one
/// with no layout change beyond unifying the radius. `.standard` additionally
/// adds the 16-pt inset and full-width fill for brand-new screens.
struct CardStyleModifier: ViewModifier {
    var padding: CardStylePadding = .standard

    func body(content: Content) -> some View {
        switch padding {
        case .flush:
            content
                .background(Color(uiColor: .secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous))
        case .standard, .inset:
            content
                .padding(padding.value ?? Spacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous))
        }
    }
}

extension View {
    /// Applies the standard grouped-card chrome (see ``CardStyleModifier``).
    func cardStyle(_ padding: CardStylePadding = .standard) -> some View {
        modifier(CardStyleModifier(padding: padding))
    }
}

// MARK: - Buttons

/// Filled brand-navy primary button (CTA). Mirrors the web's primary button.
struct BrandPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.brandHeadline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Spacing.sm)
            .padding(.horizontal, Spacing.md)
            // US-1173: guarantee the 44pt hit-target floor regardless of label
            // length / Dynamic Type so every brand CTA stays comfortably tappable.
            .frame(minHeight: 44)
            .background(Color.brandNavy.opacity(isEnabled ? 1 : 0.4))
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// Tinted/outline secondary button — brand navy text on a tinted fill.
struct BrandSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.brandHeadline)
            .foregroundStyle(Color.brandNavy.opacity(isEnabled ? 1 : 0.4))
            .frame(maxWidth: .infinity)
            .padding(.vertical, Spacing.sm)
            .padding(.horizontal, Spacing.md)
            // US-1173: guarantee the 44pt hit-target floor regardless of label
            // length / Dynamic Type so every brand CTA stays comfortably tappable.
            .frame(minHeight: 44)
            .background(Color.brandNavy.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// Destructive filled button (brand red).
struct BrandDestructiveButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.brandHeadline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Spacing.sm)
            .padding(.horizontal, Spacing.md)
            // US-1173: guarantee the 44pt hit-target floor regardless of label
            // length / Dynamic Type so every brand CTA stays comfortably tappable.
            .frame(minHeight: 44)
            .background(Color.brandRed.opacity(isEnabled ? 1 : 0.4))
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == BrandPrimaryButtonStyle {
    /// Filled brand-navy CTA. `Button(...).buttonStyle(.brandPrimary)`.
    static var brandPrimary: BrandPrimaryButtonStyle { BrandPrimaryButtonStyle() }
}

extension ButtonStyle where Self == BrandSecondaryButtonStyle {
    /// Tinted secondary action. `Button(...).buttonStyle(.brandSecondary)`.
    static var brandSecondary: BrandSecondaryButtonStyle { BrandSecondaryButtonStyle() }
}

extension ButtonStyle where Self == BrandDestructiveButtonStyle {
    /// Filled brand-red destructive action.
    static var brandDestructive: BrandDestructiveButtonStyle { BrandDestructiveButtonStyle() }
}
