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

    /// `currencyCode` (US-1237) lets a caller pin the display currency for a
    /// value that isn't in the user's own currency (e.g. an eBay comp median
    /// returned in the marketplace's currency), so it's never silently rendered
    /// with the wrong symbol. When nil the user's override / locale currency is
    /// used, preserving the previous behavior.
    public init(locale: Locale = .current, currencyCode: String? = nil) {
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
        // back to the locale's currency (the previous behavior). US-1237: an
        // explicit `currencyCode` arg wins over both (pins a foreign comp value
        // to its own currency).
        if let code = currencyCode ?? AppPreferences.currencyCode {
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

        // Reject malformed numerics that NumberFormatter would otherwise
        // *partially* parse (it stops at the first invalid char and silently
        // returns the leading value): "12.50.00" -> 12.50, "5-0" -> 5. A
        // mistyped price must fail to nil ("no price entered"), not coerce to a
        // surprising amount. Allow at most one decimal separator and a single
        // leading minus sign.
        if cleaned.components(separatedBy: decimalSeparator).count > 2 { return nil }
        if let firstMinus = cleaned.firstIndex(of: "-"),
           firstMinus != cleaned.startIndex || cleaned.filter({ $0 == "-" }).count > 1 {
            return nil
        }

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

// MARK: - US-1517: shared default instance

extension CurrencyFormatter {
    private static let sharedLock = NSLock()
    private static var sharedCache: (code: String?, formatter: CurrencyFormatter)?

    /// Process-wide cached default-configured formatter for the hot per-row /
    /// per-keystroke paths (each init builds TWO NumberFormatters — real cost
    /// when constructed inside inventory rows, board cards, and typing loops).
    ///
    /// Keyed on the user's currency override so a Settings change rebuilds it —
    /// a bare `static let` would freeze the old symbol until relaunch. Safe to
    /// share: NumberFormatter is thread-safe for use (not reconfiguration) on
    /// modern OS versions and this instance is never mutated after init; the
    /// cache swap itself is lock-guarded.
    public static var shared: CurrencyFormatter {
        sharedLock.lock()
        defer { sharedLock.unlock() }
        let code = AppPreferences.currencyCode
        if let cached = sharedCache, cached.code == code { return cached.formatter }
        let fresh = CurrencyFormatter()
        sharedCache = (code, fresh)
        return fresh
    }
}
