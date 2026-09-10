import Foundation

/// The one place that decides whether a typed string looks like a carrier
/// tracking number (US-3272).
///
/// ⚠ THIS RULE EXISTED, IN A VIEW, AND THE OTHER ENTRY POINT DID NOT HAVE IT.
/// US-1178 added the shape check to `MarkShippedSheet` so an obvious typo or
/// paste error never reaches eBay. The notification's "Mark shipped" action
/// takes free text from the lock screen, trims it, and hands anything non-empty
/// straight to `FulfillmentService.markShipped`, which pushes it to eBay's
/// shipping_fulfillment API. There is no sheet, no warning and no confirmation
/// on that path — whatever was typed is final, and an eBay fulfillment cannot
/// be edited afterwards. The buyer gets a tracking link that goes nowhere.
///
/// Deliberately loose. Per-carrier validation is brittle and would reject real
/// numbers; this only catches what could not be a tracking number at all.
enum TrackingNumber {

    /// Carrier tracking numbers are alphanumeric and roughly 8 to 40
    /// characters. Spaces are common in a pasted number and are stripped rather
    /// than rejected, because "9400 1000 0000" is a real tracking number that a
    /// carrier site formatted for reading.
    static func normalized(_ raw: String) -> String {
        raw.filter { $0.isLetter || $0.isNumber }
    }

    /// True when `raw` could be a tracking number. An empty string is NOT
    /// plausible; callers that allow "ship without tracking" check for empty
    /// themselves, because the two mean different things — one is a choice and
    /// the other is a mistake.
    static func isPlausible(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        // Every character has to be a letter, a digit or a separator a carrier
        // site would have inserted. "n/a" and "shipped!" fail here.
        guard trimmed.allSatisfy({ $0.isLetter || $0.isNumber || $0 == " " || $0 == "-" })
        else { return false }
        // US-3304: and at least one digit. The comment above used to claim
        // "will do tomorrow" failed the character check, and it does not -
        // it is fourteen letters and two spaces, so it passed every rule in
        // this function and shipped a sentence to eBay as a tracking number.
        // The test that says so was written with the rule and never ran,
        // because iOS CI had not compiled for ten days.
        //
        // No carrier issues an all-letter number: USPS and FedEx are digits,
        // UPS is 1Z + alphanumerics, DHL is digits, and Royal Mail is
        // RR123456785GB. A string with no digit in it is prose.
        guard trimmed.contains(where: { $0.isNumber }) else { return false }
        return (8...40).contains(normalized(trimmed).count)
    }
}
