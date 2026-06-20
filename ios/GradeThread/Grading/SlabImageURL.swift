import CoreGraphics
import Foundation

/// US-768 / US-764: the marketplace formats the Digital Slab (US-763) renders.
/// Mirrors `SLAB_FORMATS` in the slab Pages function + `SlabFormat` in the web
/// `slab-image.ts` so the iOS picker offers exactly the same options.
enum SlabFormat: String, CaseIterable, Identifiable, Sendable {
    case square
    case portrait
    case story
    case label

    var id: String { rawValue }

    /// Picker label — matches the web `FORMATS` copy.
    var label: String {
        switch self {
        case .square:   return "Square"
        case .portrait: return "Portrait"
        case .story:    return "Story"
        case .label:    return "Label only"
        }
    }

    /// width ÷ height, so the preview box matches the rendered slab's shape.
    var aspectRatio: CGFloat {
        switch self {
        case .square, .label: return 1
        case .portrait:       return 4.0 / 5.0
        case .story:          return 9.0 / 16.0
        }
    }
}

/// Derives the Digital-Slab image URL for a graded item from its public
/// certificate URL — the iOS twin of the web `slabImageUrl` (`slab-image.ts`)
/// and the edge `slabImageUrlForItem` (`flipdesk-ebay.ts`).
///
/// An item's `certificate_url` is `<site>/cert/<id>`; its slab lives at the
/// sibling `<site>/slab/cert/<id>`. We rewrite the FIRST `/cert/` segment (so
/// the origin is never hard-coded) and append the chosen format. Returns nil
/// when the item has no public certificate yet — the caller then hides the
/// graded-photo affordance instead of pointing at a transparent fallback.
enum SlabImageURL {
    static func url(certificateURL: String?, format: SlabFormat) -> URL? {
        guard let cert = certificateURL?.trimmingCharacters(in: .whitespacesAndNewlines),
              !cert.isEmpty,
              let certRange = cert.range(of: "/cert/") else { return nil }
        // Replace only the first "/cert/" (a uuid never contains it), matching
        // JS String.replace(string, …) which substitutes the first occurrence.
        let base = cert.replacingCharacters(in: certRange, with: "/slab/cert/")
        let separator = base.contains("?") ? "&" : "?"
        return URL(string: "\(base)\(separator)format=\(format.rawValue)")
    }
}
