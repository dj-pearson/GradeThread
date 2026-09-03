import SwiftUI

/// US-3100 — how a buy / maybe / skip verdict is written and coloured.
///
/// Lived inside ``ProspectView`` as a private `recommendationColor` until the
/// verdict had to appear in two more places: the saved card and the Home row.
/// Three copies of a colour switch is how a "maybe" ends up amber on one screen
/// and red on another, which reads to the seller as two different answers.
///
/// The server sends the raw word ("buy" | "maybe" | "skip"). An unrecognised one
/// falls through to neutral rather than to a colour that asserts something.
enum ProspectDecisionCopy {

    /// The chip's text. Sentence case, not shouted: the colour already carries
    /// the emphasis, and an all-caps string is one a translator cannot fix.
    static func label(_ recommendation: String) -> String {
        switch recommendation {
        case "buy": return String(localized: "Buy")
        case "maybe": return String(localized: "Maybe")
        case "skip": return String(localized: "Skip")
        default: return recommendation.capitalized
        }
    }

    static func color(_ recommendation: String) -> Color {
        switch recommendation {
        case "buy": return .green
        case "maybe": return Color.brandAmber
        case "skip": return Color.brandRed
        default: return .secondary
        }
    }
}
