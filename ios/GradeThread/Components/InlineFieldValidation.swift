import Foundation

/// US-970: shared inline-validation helpers for money / price / capped-title
/// inputs, so every form surfaces the SAME "why is Save disabled" copy beneath
/// the field instead of just silently disabling the button. Mirrors the
/// details-intake pattern (US-754 — `IntakeFormState.isTitleMissing` +
/// `titleRequiredHelp`). Foundation-only so it stays unit-testable.
enum MoneyFieldValidation {
    /// Help copy shown beneath an amount field that MUST hold a positive value
    /// (e.g. the Add-expense amount). Surfaced whenever the field doesn't parse
    /// to a value greater than 0 — covers both empty and non-numeric/zero input.
    static let positiveAmountHelp = "Enter an amount greater than 0"

    /// Help copy shown beneath an OPTIONAL price field when the user typed
    /// something that doesn't parse. Empty is allowed (no price set), so this
    /// stays hidden until they actually type input that's being ignored.
    static let invalidPriceHelp = "Enter a valid price, or clear the field"

    /// Positive amount parsed from `text`, else nil (empty, non-numeric, ≤0).
    static func positiveAmount(_ text: String, formatter: CurrencyFormatter) -> Double? {
        guard let value = formatter.parse(text), value > 0 else { return nil }
        return value
    }

    /// Help for a REQUIRED amount field: non-nil whenever there isn't a valid
    /// positive amount, so the user always sees why Save is disabled.
    static func requiredAmountHelp(_ text: String, formatter: CurrencyFormatter) -> String? {
        positiveAmount(text, formatter: formatter) == nil ? positiveAmountHelp : nil
    }

    /// Help for an OPTIONAL price field: non-nil only when the user typed
    /// non-empty text that doesn't parse to a number — i.e. characters that
    /// would otherwise be silently swallowed. Empty (no price) is valid.
    static func optionalPriceHelp(_ text: String, formatter: CurrencyFormatter) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return formatter.parse(text) == nil ? invalidPriceHelp : nil
    }

    /// Formats a wire decimal-string price (eBay sends money as strings) to a
    /// consistent 2-decimal display. Locale-independent — the wire string is
    /// always canonical (`"."` decimal). Falls back to the raw string when it
    /// can't be parsed so we never render an empty price.
    static func twoDecimalDisplay(_ priceValue: String) -> String {
        guard let value = Double(priceValue) else { return priceValue }
        return String(format: "%.2f", value)
    }
}

/// US-970: shared feedback for a length-capped title field (e.g. eBay's
/// 80-char limit). Surfaces the counter color level + an at-cap note so typed
/// characters are never silently dropped past the cap without indication.
struct TitleLimitFeedback: Equatable {
    /// Counter highlight: plain until the cap nears, then a warning, then an
    /// at-limit color. The view maps the level to a brand color.
    enum Level: Equatable { case normal, approaching, atLimit }

    let count: Int
    let limit: Int

    /// How close to the cap the counter starts warning.
    static let warnWithin = 10

    var level: Level {
        if count >= limit { return .atLimit }
        if limit - count <= Self.warnWithin { return .approaching }
        return .normal
    }

    var counterText: String { "\(count)/\(limit)" }

    /// Non-nil once the user is at the cap, so the truncation past it is
    /// explained rather than silently swallowing keystrokes.
    var atLimitNote: String? {
        count >= limit ? "Maximum \(limit) characters" : nil
    }
}
