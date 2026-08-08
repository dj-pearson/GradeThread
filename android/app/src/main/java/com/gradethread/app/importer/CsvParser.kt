package com.gradethread.app.importer

/**
 * US-1389 (iOS `CSVParser`, web `src/lib/csv.ts`): a minimal CSV/TSV parser.
 *
 * A faithful port rather than a library, so a sheet that imports cleanly on the
 * web imports identically here. Handles quoted fields, escaped quotes (`""`)
 * and newlines inside quotes — all three appear the moment anyone pastes a
 * description into a spreadsheet.
 */
object CsvParser {

    enum class Delimiter(val char: Char) { COMMA(','), TAB('\t'), SEMICOLON(';') }

    /**
     * Strips a leading UTF-8 BOM.
     *
     * Excel and Sheets prepend one to "CSV UTF-8" exports, and trimming
     * whitespace does not remove it — so without this the first header keeps the
     * BOM glued to it and auto-mapping silently fails on exactly the column that
     * matters most.
     *
     * US-2435: written as the ESCAPE, not the literal character. A literal BOM
     * here is invisible in every editor and diff, and Android lint's ByteOrderMark
     * check — which cannot tell deliberate data from an encoding accident —
     * failed the build on it. Same bytes matched, one of them readable.
     */
    fun stripBom(input: String): String = input.removePrefix("\uFEFF")

    /**
     * The delimiter, by frequency in the first line.
     *
     * Semicolon is included because European-locale exports use it. Ties prefer
     * comma, then tab.
     */
    fun detectDelimiter(sample: String): Delimiter {
        val firstLine = stripBom(sample).substringBefore('\n')
        val tabs = firstLine.count { it == '\t' }
        val commas = firstLine.count { it == ',' }
        val semis = firstLine.count { it == ';' }
        return when {
            commas >= tabs && commas >= semis -> Delimiter.COMMA
            tabs >= semis -> Delimiter.TAB
            else -> Delimiter.SEMICOLON
        }
    }

    fun parse(input: String, delimiter: Delimiter): List<List<String>> {
        val rows = mutableListOf<List<String>>()
        var row = mutableListOf<String>()
        val field = StringBuilder()
        var inQuotes = false
        var i = 0

        while (i < input.length) {
            val ch = input[i]
            if (inQuotes) {
                if (ch == '"') {
                    if (i + 1 < input.length && input[i + 1] == '"') {
                        field.append('"')
                        i++
                    } else {
                        inQuotes = false
                    }
                } else {
                    field.append(ch)
                }
                i++
                continue
            }
            when (ch) {
                '"' -> inQuotes = true
                delimiter.char -> {
                    row.add(field.toString()); field.clear()
                }
                // Dropped, not appended: a Windows export would otherwise leave
                // a carriage return on the end of every last column.
                '\r' -> Unit
                '\n' -> {
                    row.add(field.toString()); field.clear()
                    rows.add(row); row = mutableListOf()
                }
                else -> field.append(ch)
            }
            i++
        }
        if (field.isNotEmpty() || row.isNotEmpty()) {
            row.add(field.toString())
            rows.add(row)
        }
        // Trailing blank lines are near-universal in exports and would otherwise
        // each become an empty item.
        while (rows.isNotEmpty() && rows.last().all { it.isBlank() }) {
            rows.removeAt(rows.size - 1)
        }
        return rows
    }

    data class Sheet(val headers: List<String>, val rows: List<List<String>>)

    /**
     * Headers plus rows, every row normalized to the header width.
     *
     * Short rows are padded and long ones truncated, so a column index from the
     * mapping is always safe to read — a ragged export is the normal case, not
     * the exception.
     */
    fun parseSheet(input: String): Sheet {
        val clean = stripBom(input)
        val grid = parse(clean, detectDelimiter(clean))
        if (grid.isEmpty()) return Sheet(emptyList(), emptyList())

        val headers = grid.first().map { it.trim() }
        val width = headers.size
        val rows = grid.drop(1).map { raw ->
            when {
                raw.size == width -> raw
                raw.size > width -> raw.take(width)
                else -> raw + List(width - raw.size) { "" }
            }
        }
        return Sheet(headers, rows)
    }
}
