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
    static func mapRow(
        _ row: [String],
        mapping: [ImportField],
        rowNumber: Int,
        dateOrder: ImportValue.SlashOrder = .monthFirst
    ) -> RowResult {
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
            acquiredDate: ImportValue.dateISO(v(.purchaseDate), order: dateOrder)
        )
        return .ready(draft)
    }

    // MARK: - Cells that were read and then thrown away (US-3270)

    /// A cell that held something and reached the database as nothing.
    struct DroppedCell: Equatable {
        /// 1-based sheet row, header being row 1.
        let row: Int
        let field: ImportField
        /// What the seller actually typed, so the message can name it.
        let raw: String
    }

    /// ⚠ FOUR FIELDS COERCE, AND ALL FOUR FAIL BY RETURNING nil, WHICH
    /// `mapRow` WRITES STRAIGHT INTO A `.ready` DRAFT.
    ///
    /// So a row with a status of "Sold Out" imports successfully and lands as
    /// `cataloged`, because `ImportValue.status` has "sold" and not "sold out".
    /// The seller's sold item is now unsold inventory, counted in their equity
    /// and their aging report. A category of "Women's Clothing" imports with no
    /// category. A purchase price of "n/a" imports with no cost basis, so every
    /// profit figure derived from it is wrong. A purchase date of
    /// "Sept 3, 2026" imports with no acquired date.
    ///
    /// None of it appears anywhere. The summary says "N ready, 0 skipped" and
    /// the result screen lists only rows that failed to INSERT. A silent drop
    /// is worse than a rejected row: a rejected row gets fixed.
    ///
    /// Pure, so the preview can show the count before the seller commits and a
    /// test can pin it.
    static func droppedCells(
        sheet: CSVParser.Sheet,
        mapping: [ImportField],
        locale: Locale = .current
    ) -> [DroppedCell] {
        // Same reading mapAll will use, so the two never disagree about which
        // cells survive.
        let order = dateOrder(sheet: sheet, mapping: mapping, locale: locale)
        var dropped: [DroppedCell] = []
        for (idx, row) in sheet.rows.enumerated() {
            let rowNumber = idx + 2
            // A row with no title never reaches the database at all, and it is
            // already reported as an error. Naming its cells too is noise.
            guard value(.title, row: row, mapping: mapping) != nil else { continue }
            func check(_ field: ImportField, _ parse: (String?) -> Bool) {
                guard let raw = value(field, row: row, mapping: mapping) else { return }
                guard !parse(raw) else { return }
                dropped.append(DroppedCell(row: rowNumber, field: field, raw: raw))
            }
            check(.category) { ImportValue.category($0) != nil }
            check(.status) { ImportValue.status($0) != nil }
            check(.purchasePrice) { ImportValue.price($0) != nil }
            check(.listPrice) { ImportValue.price($0) != nil }
            check(.purchaseDate) { ImportValue.dateISO($0, order: order) != nil }
        }
        return dropped
    }

    /// One line for the preview, naming the field and an example, because
    /// "12 cells could not be read" is not something anyone can act on.
    static func droppedSummary(_ dropped: [DroppedCell]) -> String? {
        guard let first = dropped.first else { return nil }
        let fields = Set(dropped.map(\.field))
        let names = ImportField.allCases
            .filter { fields.contains($0) }
            .map(\.label)
            .joined(separator: ", ")
        let count = dropped.count
        let cells = count == 1 ? "1 cell" : "\(count) cells"
        return "\(cells) will import blank (\(names)) — row \(first.row)'s "
            + "\(first.field.label) reads \"\(first.raw)\"."
    }

    /// Maps every data row. Empty rows are dropped silently; rows with data but
    /// no title surface as errors.
    static func mapAll(
        sheet: CSVParser.Sheet,
        mapping: [ImportField],
        locale: Locale = .current
    ) -> [RowResult] {
        // US-3271: decided once from the whole column, then applied to every
        // row. Per-cell guessing is what read a UK sheet's 03/09 as 9 March.
        let order = dateOrder(sheet: sheet, mapping: mapping, locale: locale)
        return sheet.rows.enumerated().compactMap { idx, row in
            let result = mapRow(row, mapping: mapping, rowNumber: idx + 2, dateOrder: order)
            if case .invalid(_, "Empty row") = result { return nil }
            return result
        }
    }

    // MARK: - How the purchase-date column is read (US-3271)

    /// Every value mapped to the purchase-date column.
    static func dateSamples(sheet: CSVParser.Sheet, mapping: [ImportField]) -> [String] {
        sheet.rows.compactMap { value(.purchaseDate, row: $0, mapping: mapping) }
    }

    static func dateOrder(
        sheet: CSVParser.Sheet,
        mapping: [ImportField],
        locale: Locale = .current
    ) -> ImportValue.SlashOrder {
        ImportValue.slashOrder(in: dateSamples(sheet: sheet, mapping: mapping), locale: locale)
    }

    /// A line for the preview naming how the slashed dates are being read, and
    /// whether the column proved it or the device locale guessed.
    ///
    /// Shown for a PROVEN column too, not only an ambiguous one. The reading is
    /// the difference between March and September in someone's books, and it
    /// costs one line to say which one happened.
    static func dateOrderNotice(
        sheet: CSVParser.Sheet,
        mapping: [ImportField],
        locale: Locale = .current
    ) -> String? {
        let samples = dateSamples(sheet: sheet, mapping: mapping)
        let slashed = samples.filter { ImportValue.slashParts($0) != nil }
        guard let example = slashed.first else { return nil }
        let order = ImportValue.slashOrder(in: samples, locale: locale)
        let proven = slashed.contains { raw in
            guard let (first, second) = ImportValue.slashParts(raw) else { return false }
            return first > 12 || second > 12
        }
        let reading = order == .dayFirst ? "day/month/year" : "month/day/year"
        guard let iso = ImportValue.dateISO(example, order: order) else { return nil }
        let how = proven
            ? "Reading dates as \(reading)"
            : "No date in this column settles it, so reading as \(reading) for your region"
        return "\(how) — \(example) imports as \(iso)."
    }
}
