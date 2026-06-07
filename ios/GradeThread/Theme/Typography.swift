import SwiftUI

// MARK: - Brand typography (US-654)

/// The brand type scale. Display/headline surfaces use **Outfit** (the display
/// face); body, UI, and data rows use **Inter**. Both are bundled as static
/// weights (instanced from the OFL variable fonts) and referenced here by their
/// exact PostScript names — `Font.custom` resolves those directly.
///
/// Graceful fallback: if a face ever fails to load, `Font.custom` silently
/// falls back to the system font at the same size, so the UI never goes blank.
/// Every token is built with `relativeTo:` so it still scales with Dynamic Type
/// (US-192 accessibility), matching the system text-style it shadows.
enum BrandFont {
    // PostScript names of the bundled faces (see project.yml UIAppFonts).
    static let outfitRegular  = "Outfit-Regular"
    static let outfitSemiBold = "Outfit-SemiBold"
    static let outfitBold     = "Outfit-Bold"
    static let interRegular   = "Inter-Regular"
    static let interMedium    = "Inter-Medium"
    static let interBold      = "Inter-Bold"
}

extension Font {
    // ── Display face (Outfit) ────────────────────────────────────────────
    /// Large hero numbers / titles (e.g. the grade-score ring, certificate title).
    static let brandLargeTitle = Font.custom(BrandFont.outfitBold, size: 34, relativeTo: .largeTitle)
    static let brandTitle      = Font.custom(BrandFont.outfitBold, size: 28, relativeTo: .title)
    static let brandTitle2     = Font.custom(BrandFont.outfitSemiBold, size: 22, relativeTo: .title2)
    /// Section headers + card titles.
    static let brandHeadline   = Font.custom(BrandFont.outfitSemiBold, size: 17, relativeTo: .headline)

    /// The grade-score number at an arbitrary point size (still Dynamic-Type
    /// relative so it scales for low-vision users).
    static func brandScore(_ size: CGFloat) -> Font {
        Font.custom(BrandFont.outfitBold, size: size, relativeTo: .largeTitle)
    }

    // ── Body / UI face (Inter) ───────────────────────────────────────────
    static let brandBody     = Font.custom(BrandFont.interRegular, size: 17, relativeTo: .body)
    static let brandCallout  = Font.custom(BrandFont.interRegular, size: 16, relativeTo: .callout)
    static let brandSubhead  = Font.custom(BrandFont.interMedium, size: 15, relativeTo: .subheadline)
    static let brandCaption  = Font.custom(BrandFont.interRegular, size: 12, relativeTo: .caption)

    /// Emphasis level for tabular data rows (Font.Weight isn't Comparable, so
    /// we expose an explicit enum the data token switches on).
    enum BrandDataWeight { case regular, medium, bold }

    /// Tabular data rows where figures should align — Inter with monospaced
    /// digits. Use for prices, counts, measurement grids.
    static func brandData(_ size: CGFloat = 15, weight: BrandDataWeight = .regular) -> Font {
        let face: String
        switch weight {
        case .regular: face = BrandFont.interRegular
        case .medium:  face = BrandFont.interMedium
        case .bold:    face = BrandFont.interBold
        }
        return Font.custom(face, size: size, relativeTo: .subheadline).monospacedDigit()
    }
}
