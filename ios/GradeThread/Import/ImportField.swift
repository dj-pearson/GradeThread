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
    /// Parses a price-ish string ("$19.99", "1,299", "(5.00)") to a Double.
    static func price(_ raw: String?) -> Double? {
        guard let raw else { return nil }
        let negative = raw.contains("(") && raw.contains(")")
        let cleaned = raw.filter { $0.isNumber || $0 == "." }
        guard let value = Double(cleaned) else { return nil }
        return negative ? -value : value
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
            "other": .other,
        ]
        return table[key]?.rawValue
    }

    /// Parses a date in common spreadsheet shapes to an ISO `YYYY-MM-DD` string.
    static func dateISO(_ raw: String?) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        let formats = ["yyyy-MM-dd", "MM/dd/yyyy", "M/d/yyyy", "MM/dd/yy", "M/d/yy", "yyyy/MM/dd"]
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
