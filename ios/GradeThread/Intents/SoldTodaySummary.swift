import Foundation

/// US-1134: pure spoken/Siri summary builder for the "What sold today" App
/// Intent. Kept free of the AppIntents framework + any app state so it unit
/// tests with no Siri/StoreKit runtime — the intent itself just reads the
/// shared ``WidgetSnapshot`` and hands it here.
///
/// Reuses the exact same rollup the home-screen widget renders
/// (``WidgetSnapshotStore``), so Siri and the widget never disagree — including
/// US-3226's day-rollover rule: both refuse to state a "sold today" figure that
/// was computed on a day that has since ended.
enum SoldTodaySummary {
    /// Builds the natural-language sentence Siri speaks / shows for the current
    /// snapshot. A `nil` snapshot (nothing published yet) and a signed-out
    /// snapshot both fall back to a sign-in prompt rather than reading zeros as
    /// if the business were dead.
    ///
    /// US-3228: `now` decides whether the snapshot's today-scoped figures still
    /// describe today. The intent runs with `openAppWhenRun: false`, so asking
    /// Siri does NOT refresh the snapshot — on a phone last opened yesterday
    /// evening, this used to answer "You've sold 3 items today for $214" at
    /// breakfast, spoken as fact with nothing on screen to contradict it. The
    /// widget at least carries an "Updated 14 hours ago" footnote; a spoken
    /// sentence carries nothing. The payout figure is an as-of value and stays
    /// true, so it is still reported.
    static func dialog(
        from snapshot: WidgetSnapshot?,
        now: Date = .now,
        calendar: Calendar = .current
    ) -> String {
        guard let snapshot, snapshot.isSignedIn else {
            return "Sign in to GradeThread to see what sold today."
        }

        let payout = payoutClause(
            count: snapshot.pendingPayoutCount,
            net: snapshot.pendingPayoutNet,
            code: snapshot.currencyCode
        )

        if snapshot.soldTodayIsStale(asOf: now, calendar: calendar) {
            return "I don't have today's sales yet. Open GradeThread to refresh. \(payout)"
        }

        if snapshot.soldTodayCount == 0 {
            return "Nothing's sold yet today. \(payout)"
        }

        let itemWord = snapshot.soldTodayCount == 1 ? "item" : "items"
        let gross = currency(snapshot.soldTodayGross, code: snapshot.currencyCode)
        return "You've sold \(snapshot.soldTodayCount) \(itemWord) today for \(gross). \(payout)"
    }

    /// The trailing "payout waiting" clause, shared by the sold / not-sold paths.
    private static func payoutClause(count: Int, net: Double, code: String? = nil) -> String {
        guard count > 0 else { return "No payouts are waiting." }
        let saleWord = count == 1 ? "sale" : "sales"
        return "\(currency(net, code: code)) is waiting from \(count) \(saleWord)."
    }

    /// Whole-dollar when there are no cents so the spoken figure stays clean
    /// ("$184" rather than "$184.00"), matching the widget's formatter.
    /// US-1161: `code` is the user's currency override (from the snapshot);
    /// nil follows the device locale instead of forcing USD.
    static func currency(_ amount: Double, code: String? = nil) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        if let code { formatter.currencyCode = code }
        formatter.maximumFractionDigits =
            amount.truncatingRemainder(dividingBy: 1) == 0 ? 0 : 2
        return formatter.string(from: NSNumber(value: amount)) ?? "\(formatter.currencySymbol ?? "$")\(Int(amount))"
    }
}
