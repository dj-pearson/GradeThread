import SwiftUI

/// A free-text aspect field that OFFERS eBay's recommended values as you type.
///
/// eBay returns two different kinds of value list. `SELECTION_ONLY` aspects have
/// a closed list and must be a picker. But most of the ones sellers touch most —
/// Brand, Color, Material, Style — are FREE_TEXT or SUGGESTED: any value is
/// legal, AND eBay still ships a list of recommended values that its own listing
/// form autocompletes against.
///
/// iOS previously rendered every non-`SELECTION_ONLY` aspect as a bare
/// `TextField` and threw that list away, so sellers hand-typed "Black" in full
/// while the web composer (which binds the same list to an `<input list=…>`
/// datalist) completed it after one keystroke. Same data, same category spec —
/// only the iOS renderer ignored it.
///
/// Free typing is preserved: the suggestions are an accelerator, never a
/// constraint, because a value outside eBay's list is still a valid listing.
struct AspectSuggestField: View {
    let placeholder: String
    /// eBay's recommended values for this aspect, in the order the API returned
    /// them (relevance-ordered, so an unfiltered prefix of them is a good
    /// "popular values" list).
    let suggestions: [String]
    @Binding var text: String

    @FocusState private var focused: Bool

    /// Cap the visible list so one aspect can't push the rest of the form off
    /// screen — Color alone can carry 100+ values.
    private static let maxVisible = 8

    /// Case- and whitespace-insensitive prefix match first, then substring, so
    /// typing "bl" surfaces "Black" ahead of "Cobalt Blue". An empty query shows
    /// the head of eBay's own ordering.
    var matches: [String] {
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return Array(suggestions.prefix(Self.maxVisible)) }
        // An exact hit means the seller is done — showing it back as a
        // suggestion is noise.
        if suggestions.contains(where: { $0.lowercased() == q }) { return [] }
        let prefix = suggestions.filter { $0.lowercased().hasPrefix(q) }
        let contains = suggestions.filter {
            !$0.lowercased().hasPrefix(q) && $0.lowercased().contains(q)
        }
        return Array((prefix + contains).prefix(Self.maxVisible))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField(placeholder, text: $text)
                .multilineTextAlignment(.trailing)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.words)
                .focused($focused)

            // Only while editing: a persistent list would double every row's
            // height and make the form unreadable.
            if focused, !matches.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(matches, id: \.self) { value in
                            Button(value) {
                                text = value
                                focused = false
                            }
                            .buttonStyle(.plain)
                            .font(.footnote)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(Color.secondary.opacity(0.12), in: Capsule())
                            .accessibilityHint("Use eBay's recommended value")
                        }
                    }
                    .padding(.vertical, 1)
                }
                // The row is inside a Form; keep the chips from stretching it.
                .frame(maxHeight: 40)
            }
        }
    }
}
