import Foundation

/// US-667 — the FlipDesk fields a CSV column can map to. Mirrors the web's
/// `IMPORT_FIELDS` (`src/lib/import-mapping.ts`), trimmed to what the iOS insert
/// path writes. `.skip` excludes a column. `guessField` auto-maps headers.
enum ImportField: String, CaseIterable, Identifiable, Equatable {
    case skip
    case sku
    case title
    case brand
    case style
    case size
    case color
    case material
    case conditionNotes
    case category
    case purchasePrice
    case listPrice
    case purchaseDate
    case status

    var id: String { rawValue }

    var label: String {
        switch self {
        case .skip:           return "— Skip —"
        case .sku:            return "Item # (SKU)"
        case .title:          return "Item title"
        case .brand:          return "Brand"
        case .style:          return "Style"
        case .size:           return "Size"
        case .color:          return "Color"
        case .material:       return "Material"
        case .conditionNotes: return "Notes"
        case .category:       return "Category"
        case .purchasePrice:  return "Purchase price"
        case .listPrice:      return "List price"
        case .purchaseDate:   return "Purchase date"
        case .status:         return "Status"
        }
    }

    /// Title is the only required field — a row without it can't be inserted.
    var isRequired: Bool { self == .title }

    /// Best-guess mapping from a sheet header (any casing/spacing). Mirrors the
    /// web `guessField`; unknown headers map to `.skip`.
    static func guess(from header: String) -> ImportField {
        let key = header.lowercased().filter { $0.isLetter || $0.isNumber }
        let table: [String: ImportField] = [
            "item": .sku, "itemnumber": .sku, "itemno": .sku, "sku": .sku,
            "itemtitle": .title, "title": .title, "name": .title,
            "brand": .brand,
            "style": .style, "model": .style,
            "size": .size,
            "color": .color, "colour": .color,
            "material": .material, "fabric": .material,
            "notes": .conditionNotes, "note": .conditionNotes,
            "description": .conditionNotes, "desc": .conditionNotes,
            "category": .category, "cat": .category,
            "purchaseprice": .purchasePrice, "cost": .purchasePrice, "paid": .purchasePrice,
            "listprice": .listPrice, "price": .listPrice, "targetprice": .listPrice,
            "purchasedate": .purchaseDate, "purchased": .purchaseDate, "acquired": .purchaseDate,
            "status": .status,
        ]
        return table[key] ?? .skip
    }
}

/// Pure value-parsing helpers shared by the mapper.
enum ImportValue {
    /// Parses a price-ish string ("$19.99", "1,299", "(5.00)", "1.299,00") to a
    /// Double. US-1162: a CSV can be in any locale, so rather than blindly
    /// stripping everything but ".", we treat the right-most '.'/',' as the
    /// decimal separator and the other as grouping. That parses both
    /// "1,299" -> 1299 and "1.299,00" -> 1299.00 (the old filter corrupted the
    /// latter to 1.29900).
    static func price(_ raw: String?) -> Double? {
        guard let raw else { return nil }
        // Accounting-style negatives are wholly wrapped in parens ("(5.00)").
        // A parenthetical note in a price cell ("$20 (sale)") must NOT flip the
        // sign, so require the trimmed value to start "(" and end ")".
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        let negative = trimmed.hasPrefix("(") && trimmed.hasSuffix(")")
        var s = String(raw.filter { $0.isNumber || $0 == "." || $0 == "," || $0 == "-" })
        guard !s.isEmpty else { return nil }

        let lastDot = s.lastIndex(of: ".")
        let lastComma = s.lastIndex(of: ",")
        if let dot = lastDot, let comma = lastComma {
            // Both present: the right-most is the decimal separator.
            let decimalIsDot = dot > comma
            s.removeAll { $0 == (decimalIsDot ? "," : ".") }
            if !decimalIsDot { s = s.replacingOccurrences(of: ",", with: ".") }
        } else if lastComma != nil {
            // Only commas: a single comma with 1–2 trailing digits is a decimal
            // ("5,00"); anything else is grouping ("1,299" / "1,000,000").
            let parts = s.split(separator: ",", omittingEmptySubsequences: false)
            if parts.count == 2, parts[1].count <= 2 {
                s = s.replacingOccurrences(of: ",", with: ".")
            } else {
                s.removeAll { $0 == "," }
            }
        }

        guard let value = Double(s) else { return nil }
        return negative ? -abs(value) : value
    }

    /// Normalizes a free-text status to a valid `item_status`, else nil.
    static func status(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let key = raw.lowercased().trimmingCharacters(in: .whitespaces)
        let table: [String: String] = [
            "sourced": "sourced", "acquired": "acquired", "bought": "acquired",
            "cataloged": "cataloged", "catalogued": "cataloged",
            "draft": "drafted", "drafted": "drafted",
            "listed": "listed", "active": "listed", "live": "listed",
            "sold": "sold",
            "shipped": "shipped",
            "returned": "returned",
            "keeping": "keeping", "wearing": "wearing",
        ]
        return table[key]
    }

    /// Normalizes a free-text category to a valid `item_category`, else nil.
    static func category(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let key = raw.lowercased().filter { $0.isLetter }
        let table: [String: FlipdeskCategory] = [
            "clothing": .clothing, "clothes": .clothing, "apparel": .clothing,
            "shoes": .shoes, "sneakers": .shoes, "footwear": .shoes,
            "watches": .watches, "watch": .watches,
            "sportscards": .sportsCards, "cards": .sportsCards,
            "collectibles": .collectibles, "collectible": .collectibles,
            "electronics": .electronics,
            "books": .books, "book": .books,
            "jewelry": .jewelry, "jewellery": .jewelry, "ring": .jewelry,
            "necklace": .jewelry, "earrings": .jewelry, "bracelet": .jewelry,
            "bags": .bags, "bag": .bags, "handbag": .bags, "purse": .bags,
            "backpack": .bags, "tote": .bags,
            "accessories": .accessories, "accessory": .accessories,
            "hat": .accessories, "cap": .accessories, "belt": .accessories,
            "scarf": .accessories, "sunglasses": .accessories,
            "other": .other,
        ]
        return table[key]?.rawValue
    }

    /// Which number comes first in a slashed date (US-3271).
    ///
    /// ⚠ `dateISO` USED TO ASSUME MONTH-FIRST, ALWAYS. A UK or European sheet's
    /// `03/09/2026` means 3 September and parsed as 9 March: the wrong date, in
    /// the right shape, with no error and nothing dropped. `droppedCells`
    /// cannot see it either, because the cell parsed fine. It lands in the
    /// acquired date, which drives aging and every tax-year boundary.
    enum SlashOrder: Equatable {
        case monthFirst
        case dayFirst
    }

    /// Reads the order off the WHOLE COLUMN rather than one cell, which is what
    /// makes it decidable rather than a coin flip. `13/04/2026` can only be
    /// day-first; `04/13/2026` can only be month-first. One unambiguous value
    /// settles the column, because a spreadsheet column is written by one
    /// person in one format.
    ///
    /// Only when every value is ambiguous (both numbers 12 or under, all the
    /// way down) does the device locale decide, and the import preview then
    /// says which reading it used. Guessing quietly is what this replaces.
    static func slashOrder(in samples: [String], locale: Locale = .current) -> SlashOrder {
        var sawDayFirst = false
        var sawMonthFirst = false
        for sample in samples {
            guard let (first, second) = slashParts(sample) else { continue }
            if first > 12 { sawDayFirst = true }
            if second > 12 { sawMonthFirst = true }
        }
        // A column carrying both is broken whichever way we read it. Month-first
        // matches the previous behaviour, so this cannot make an existing import
        // worse, and the ambiguous-column notice still names the reading.
        if sawDayFirst && !sawMonthFirst { return .dayFirst }
        if sawMonthFirst { return .monthFirst }
        return localeOrder(locale)
    }

    /// The two leading numbers of a `d/m/y`-shaped value, or nil when the value
    /// is not slashed at all (an ISO date settles nothing).
    static func slashParts(_ raw: String) -> (Int, Int)? {
        let parts = raw.trimmingCharacters(in: .whitespaces).split(separator: "/")
        guard parts.count == 3,
              let first = Int(parts[0]), let second = Int(parts[1]),
              first > 0, second > 0
        else { return nil }
        return (first, second)
    }

    /// What this device's own locale puts first. `dateFormat(fromTemplate:)`
    /// returns "M/d/y" in the US and "dd/MM/y" in the UK, so the first of `d`
    /// or `M` to appear is the answer.
    static func localeOrder(_ locale: Locale) -> SlashOrder {
        guard let template = DateFormatter.dateFormat(
            fromTemplate: "yMd", options: 0, locale: locale
        ) else { return .monthFirst }
        let day = template.firstIndex(of: "d")
        let month = template.firstIndex(of: "M")
        guard let day, let month else { return .monthFirst }
        return day < month ? .dayFirst : .monthFirst
    }

    /// Parses a date in common spreadsheet shapes to an ISO `YYYY-MM-DD` string.
    ///
    /// `order` decides only how a slashed date is read; ISO input ignores it.
    static func dateISO(_ raw: String?, order: SlashOrder = .monthFirst) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        let slashed = order == .dayFirst
            ? ["dd/MM/yyyy", "d/M/yyyy", "dd/MM/yy", "d/M/yy"]
            : ["MM/dd/yyyy", "M/d/yyyy", "MM/dd/yy", "M/d/yy"]
        let formats = ["yyyy-MM-dd"] + slashed + ["yyyy/MM/dd"]
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = TimeZone(identifier: "UTC")
        for fmt in formats {
            parser.dateFormat = fmt
            if let date = parser.date(from: raw) {
                let out = DateFormatter()
                out.locale = Locale(identifier: "en_US_POSIX")
                out.timeZone = TimeZone(identifier: "UTC")
                out.dateFormat = "yyyy-MM-dd"
                return out.string(from: date)
            }
        }
        return nil
    }
}
