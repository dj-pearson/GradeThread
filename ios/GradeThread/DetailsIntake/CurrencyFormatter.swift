import Foundation

/// Locale-aware currency parsing + display. Wraps NumberFormatter so
/// callers get a consistent contract: the user types raw digits + at most
/// one decimal separator, we parse to Double, and the display layer shows
/// the locale's currency symbol alongside.
public struct CurrencyFormatter {

    public let locale: Locale

    /// Lazily-constructed formatter so the static lookups (Locale.current,
    /// CurrencyCode) only happen once per init.
    private let decimalFormatter: NumberFormatter
    private let currencyFormatter: NumberFormatter

    public init(locale: Locale = .current) {
        self.locale = locale

        let decimal = NumberFormatter()
        decimal.locale = locale
        decimal.numberStyle = .decimal
        decimal.maximumFractionDigits = 2
        decimal.minimumFractionDigits = 0
        decimal.usesGroupingSeparator = false
        self.decimalFormatter = decimal

        let currency = NumberFormatter()
        currency.locale = locale
        currency.numberStyle = .currency
        currency.maximumFractionDigits = 2
        currency.minimumFractionDigits = 2
        // US-648: honor the user's currency override when set; otherwise fall
        // back to the locale's currency (the previous behavior).
        if let code = AppPreferences.currencyCode {
            currency.currencyCode = code
        }
        self.currencyFormatter = currency
    }

    /// Locale's currency symbol (e.g. "$", "€", "£"). Useful as a leading
    /// label next to a decimal-pad TextField when the input itself is
    /// just digits.
    public var symbol: String {
        currencyFormatter.currencySymbol ?? "$"
    }

    /// Parses the user-typed string to a Double. Accepts:
    ///   - Plain decimal: "12.34" / "12,34" (locale separator)
    ///   - Empty string / whitespace → nil
    ///   - Strings with currency symbol or grouping separators (strips
    ///     non-numeric chars except the locale decimal separator)
    /// Returns nil on unparseable input — callers treat nil as
    /// "no price entered".
    public func parse(_ input: String) -> Double? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // Strip currency symbol + thousands separators so the decimal
        // parser sees a clean numeric string.
        let groupingSeparator = locale.groupingSeparator ?? ","
        let decimalSeparator = locale.decimalSeparator ?? "."
        let allowed: Set<Character> = Set(
            "0123456789-" + decimalSeparator
        )
        let cleaned = trimmed
            .replacingOccurrences(of: groupingSeparator, with: "")
            .filter { allowed.contains($0) }

        guard !cleaned.isEmpty else { return nil }
        return decimalFormatter.number(from: cleaned)?.doubleValue
    }

    /// Display string in the locale currency, e.g. "$12.34". Pass nil to
    /// render an empty placeholder.
    public func formatDisplay(_ amount: Double?) -> String {
        guard let amount else { return "" }
        return currencyFormatter.string(from: NSNumber(value: amount)) ?? ""
    }

    /// Echo of the user's raw input, normalized but unformatted — keeps
    /// the decimal separator and digits the user typed. Useful for
    /// echoing back into the TextField after a parse round-trip without
    /// changing the cursor position aggressively.
    public func formatRaw(_ amount: Double?) -> String {
        guard let amount else { return "" }
        return decimalFormatter.string(from: NSNumber(value: amount)) ?? ""
    }
}
