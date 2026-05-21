// Minimal CSV/TSV parser. Handles quoted fields, escaped quotes ("") and
// embedded newlines inside quotes. Good enough for Google Sheets export +
// copy-paste from a spreadsheet.

export type Delimiter = "," | "\t";

export function detectDelimiter(sample: string): Delimiter {
  const firstLine = sample.split(/\r?\n/)[0] ?? "";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

export function parseDelimited(input: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
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

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      pushField();
      pushRow();
      continue;
    }
    field += ch;
  }

  // Tail
  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }

  // Drop trailing fully-empty row (common when input ends with newline)
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (!last || !last.every((c) => c.trim() === "")) break;
    rows.pop();
  }

  return rows;
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
