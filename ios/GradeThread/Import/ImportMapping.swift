import Foundation

/// US-667 — a single CSV row mapped onto the inventory fields it'll insert.
/// Optionals stay nil so the encoder omits them (never overwriting DB defaults).
struct ImportItemDraft: Equatable {
    var title: String
    var sku: String?
    var brand: String?
    var style: String?
    var size: String?
    var color: String?
    var material: String?
    var conditionNotes: String?
    var itemCategory: String?
    var status: String?
    var acquiredPrice: Double?
    var targetPrice: Double?
    var acquiredDate: String?     // ISO YYYY-MM-DD
}

/// Pure mapping + validation from a parsed sheet to drafts. Kept free of any
/// network/DB so the column-mapping logic is unit-testable in isolation.
enum ImportMapping {

    /// One row's outcome after mapping: a ready draft, or a skip reason.
    enum RowResult: Equatable {
        case ready(ImportItemDraft)
        /// 1-based sheet row number + human reason (e.g. "Missing item title").
        case invalid(row: Int, reason: String)
    }

    /// True when the mapping has a column assigned to the (required) title field.
    static func hasTitle(_ mapping: [ImportField]) -> Bool {
        mapping.contains(.title)
    }

    /// Reads `field` out of `row` using the column→field `mapping`. Returns the
    /// first non-empty cell mapped to that field, trimmed.
    static func value(_ field: ImportField, row: [String], mapping: [ImportField]) -> String? {
        for (i, mapped) in mapping.enumerated() where mapped == field {
            guard i < row.count else { continue }
            let trimmed = row[i].trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    /// Maps one row to a draft. `rowNumber` is the 1-based sheet row (header is
    /// row 1, so the first data row is 2) used in error messages.
    static func mapRow(_ row: [String], mapping: [ImportField], rowNumber: Int) -> RowResult {
        func v(_ f: ImportField) -> String? { value(f, row: row, mapping: mapping) }

        guard let title = v(.title) else {
            // A fully-blank row is silently skippable; a row with data but no
            // title is a real error worth surfacing.
            if row.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty }) {
                return .invalid(row: rowNumber, reason: "Empty row")
            }
            return .invalid(row: rowNumber, reason: "Missing item title")
        }

        let draft = ImportItemDraft(
            title: title,
            sku: v(.sku),
            brand: v(.brand),
            style: v(.style),
            size: v(.size),
            color: v(.color),
            material: v(.material),
            conditionNotes: v(.conditionNotes),
            itemCategory: ImportValue.category(v(.category)),
            status: ImportValue.status(v(.status)),
            acquiredPrice: ImportValue.price(v(.purchasePrice)),
            targetPrice: ImportValue.price(v(.listPrice)),
            acquiredDate: ImportValue.dateISO(v(.purchaseDate))
        )
        return .ready(draft)
    }

    /// Maps every data row. Empty rows are dropped silently; rows with data but
    /// no title surface as errors.
    static func mapAll(sheet: CSVParser.Sheet, mapping: [ImportField]) -> [RowResult] {
        sheet.rows.enumerated().compactMap { idx, row in
            let result = mapRow(row, mapping: mapping, rowNumber: idx + 2)
            if case .invalid(_, "Empty row") = result { return nil }
            return result
        }
    }
}
