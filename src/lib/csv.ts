// Minimal CSV/TSV parser. Handles quoted fields, escaped quotes ("") and
// embedded newlines inside quotes. Good enough for Google Sheets export +
// copy-paste from a spreadsheet.
//
// A quote only OPENS a quoted field when it is the first character of the
// field (RFC 4180). A quote anywhere else is a literal: `32" inseam` is an inch
// mark, and treating it as an opener used to fold every later row into one
// cell.

export type Delimiter = "," | "\t" | ";" | "|";

const CANDIDATES: Delimiter[] = [",", "\t", ";", "|"];

function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

// Counts delimiter characters outside quotes on one line.
function countOutsideQuotes(line: string, delim: string): number {
  let n = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++;
        continue;
      }
      // Same opener rule as the parser: only at field start.
      if (inQuotes || i === 0 || line[i - 1] === delim) inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === delim) n++;
  }
  return n;
}

// Scores each candidate over the first five non-blank lines. A delimiter that
// appears the same number of times on every line beats one that appears more
// often but unevenly, so a comma inside a title does not outvote a semicolon
// file's real separator.
export function detectDelimiter(sample: string): Delimiter {
  const lines = stripBom(sample)
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== "")
    .slice(0, 5);
  if (lines.length === 0) return ",";
  let best: Delimiter = ",";
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const min = Math.min(...counts);
    if (min === 0) continue;
    const consistent = counts.every((c) => c === counts[0]);
    const score = consistent ? min * 10 : min;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

export function parseDelimited(rawInput: string, delimiter: Delimiter): string[][] {
  const input = stripBom(rawInput);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // True once the current field has had any character appended, including a
  // quoted empty string. Only an untouched field may open a quote.
  let fieldStarted = false;

  const pushField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      continue;
    }
    if (ch === "\r") {
      // CRLF: let the \n end the row. A lone CR (old Mac exports) ends it here.
      if (input[i + 1] === "\n") continue;
      pushField();
      pushRow();
      continue;
    }
    if (ch === "\n") {
      pushField();
      pushRow();
      continue;
    }
    field += ch;
    fieldStarted = true;
  }

  // Tail
  if (fieldStarted || field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }

  // Drop fully-empty rows anywhere. A blank spacer row between two blocks of
  // data is not an item, and counting it inflated "Import N items".
  return rows.filter((r) => !r.every((c) => c.trim() === ""));
}

// Parses a sheet block (input including header row) into { headers, rows }.
export function parseSheet(input: string): {
  delimiter: Delimiter;
  headers: string[];
  rows: string[][];
} {
  const delimiter = detectDelimiter(input);
  const parsed = parseDelimited(input, delimiter);
  const headers = parsed[0] ?? [];
  const rows = parsed.slice(1);
  return { delimiter, headers, rows };
}
