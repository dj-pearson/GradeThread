import Foundation

/// US-790: drift-free money aggregation.
///
/// Currency amounts are stored + sent over the wire as `Double` (the cache and
/// JSON shape). A `Double` like `24.99` is really `24.9899999…`, so summing
/// many of them lets the binary-float error compound past a cent on large sets
/// (the reseller reports, financial exports, dashboard/widget totals). Single
/// values and one-off subtractions are fine — the problem is ACCUMULATION.
///
/// `Money` converts each amount to an exact 2-decimal `Decimal` (every currency
/// value is ≤2 dp, so rounding to cents recovers the intended value exactly),
/// sums in `Decimal` (no drift), and hands back a cents-rounded result. Callers
/// keep their existing `Double` types — they just swap `reduce(0, +)` for
/// `Money.sum(...)` to get a penny-exact total.
///
/// Pure Foundation logic — lives in GradeThreadCore so it is unit-tested on
/// Linux (`swift test`, no Mac), and consumed by the iOS app via `import
/// GradeThreadCore`.
public enum Money {
    /// Exact 2-dp `Decimal` for a `Double` dollar amount. `Decimal(double)`
    /// carries the float's full expansion; rounding to 2 places pins it back to
    /// the cents the value was always meant to represent.
    public static func decimal(_ dollars: Double) -> Decimal {
        // US-1412: `Decimal(nan/inf)` is undefined and would poison every sum /
        // CSV export it flows into. All callers sum finite stored prices, so this
        // is a latent guard — but a cheap one against a NaN ever sneaking in.
        guard dollars.isFinite else { return .zero }
        var raw = Decimal(dollars)
        var rounded = Decimal()
        NSDecimalRound(&rounded, &raw, 2, .plain)
        return rounded
    }

    /// Cents-normalized `Double`: the exact 2-dp value re-entered as a `Double`,
    /// rounded the SAME way (`NSDecimalRound .plain`) the drift-free rollups
    /// round each amount. Use at boundaries that must agree with those rollups
    /// to the cent — e.g. a listing price before it's sent to eBay, or a single
    /// profit estimate shown next to the Money tab's realized net. Single values
    /// don't need `sum`, but they DO need to round identically to it.
    public static func cents(_ dollars: Double) -> Double {
        decimal(dollars).currencyDouble
    }

    /// Drift-free sum of `Double` dollar amounts, as an exact `Decimal`.
    public static func sumDecimal<S: Sequence>(_ amounts: S) -> Decimal
    where S.Element == Double {
        amounts.reduce(Decimal.zero) { $0 + decimal($1) }
    }

    /// Drift-free sum of `Double` dollar amounts, returned as a cents-rounded
    /// `Double` so callers that need a `Double` total stay unchanged downstream.
    public static func sum<S: Sequence>(_ amounts: S) -> Double where S.Element == Double {
        sumDecimal(amounts).currencyDouble
    }

    /// Drift-free sum of a money field projected from each element.
    public static func sum<S: Sequence>(
        _ items: S,
        _ amount: (S.Element) -> Double
    ) -> Double {
        sumDecimal(items.map(amount)).currencyDouble
    }
}

public extension Decimal {
    /// This `Decimal` rounded to cents and converted to `Double` — the boundary
    /// where an exact total re-enters `Double`-typed display / chart code.
    var currencyDouble: Double {
        var raw = self
        var rounded = Decimal()
        NSDecimalRound(&rounded, &raw, 2, .plain)
        return NSDecimalNumber(decimal: rounded).doubleValue
    }
}
