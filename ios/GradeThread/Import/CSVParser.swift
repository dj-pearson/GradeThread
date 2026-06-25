import Foundation

/// US-667 — minimal CSV/TSV parser. A faithful Swift port of the web's
/// `src/lib/csv.ts` so a sheet that imports cleanly on the web imports the same
/// way on iOS: handles quoted fields, escaped quotes (`""`), and newlines
/// embedded inside quotes. Pure + deterministic → unit-tested directly.
enum CSVParser {

    enum Delimiter: String {
        case comma = ","
        case tab = "\t"
        case semicolon = ";"
        var character: Character { Character(rawValue) }
    }

    /// Strips a leading UTF-8 BOM (`﻿`) that Excel/Sheets "CSV UTF-8"
    /// exports prepend — `.whitespaces` trimming doesn't remove it, so without
    /// this the first header keeps the BOM and auto-mapping/delimiter detection
    /// see it glued to the first cell.
    static func stripBOM(_ s: String) -> String {
        s.hasPrefix("\u{FEFF}") ? String(s.dropFirst()) : s
    }

    /// Picks the delimiter from the first line by frequency. Considers tab,
    /// comma, and semicolon (European-locale exports use `;`); ties prefer comma,
    /// then tab, matching the prior comma-default behavior.
    static func detectDelimiter(_ sample: String) -> Delimiter {
        let firstLine = stripBOM(sample).split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        let tabs = firstLine.filter { $0 == "\t" }.count
        let commas = firstLine.filter { $0 == "," }.count
        let semicolons = firstLine.filter { $0 == ";" }.count
        if commas >= tabs && commas >= semicolons { return .comma }
        if tabs >= semicolons { return .tab }
        return .semicolon
    }

    /// Parses delimited text into a grid of string cells.
    static func parse(_ input: String, delimiter: Delimiter) -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var inQuotes = false
        let delim = delimiter.character

        let chars = Array(input)
        var i = 0
        func pushField() { row.append(field); field = "" }
        func pushRow() { rows.append(row); row = [] }

        while i < chars.count {
            let ch = chars[i]
            if inQuotes {
                if ch == "\"" {
                    if i + 1 < chars.count, chars[i + 1] == "\"" {
                        field.append("\""); i += 1
                    } else {
                        inQuotes = false
                    }
                } else {
                    field.append(ch)
                }
                i += 1
                continue
            }
            if ch == "\"" { inQuotes = true; i += 1; continue }
            if ch == delim { pushField(); i += 1; continue }
            if ch == "\r" { i += 1; continue }
            if ch == "\n" { pushField(); pushRow(); i += 1; continue }
            field.append(ch)
            i += 1
        }
        // Tail
        if !field.isEmpty || !row.isEmpty {
            pushField(); pushRow()
        }
        // Drop trailing fully-empty rows.
        while let last = rows.last, last.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty }) {
            rows.removeLast()
        }
        return rows
    }

    /// A parsed sheet block (input including the header row).
    struct Sheet: Equatable {
        let headers: [String]
        let rows: [[String]]
    }

    /// Parses input into `{ headers, rows }`, auto-detecting the delimiter and
    /// normalizing every row to the header width (padding short rows).
    static func parseSheet(_ input: String) -> Sheet {
        let clean = stripBOM(input)
        let delimiter = detectDelimiter(clean)
        var grid = parse(clean, delimiter: delimiter)
        guard !grid.isEmpty else { return Sheet(headers: [], rows: []) }
        let headers = grid.removeFirst().map { $0.trimmingCharacters(in: .whitespaces) }
        let width = headers.count
        let rows = grid.map { raw -> [String] in
            if raw.count == width { return raw }
            if raw.count > width { return Array(raw.prefix(width)) }
            return raw + Array(repeating: "", count: width - raw.count)
        }
        return Sheet(headers: headers, rows: rows)
    }
}
