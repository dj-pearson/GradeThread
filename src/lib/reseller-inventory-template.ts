// The reseller inventory spreadsheet, generated rather than stored (US-9022).
//
// WHY A CSV AND NOT AN XLSX. The story asked for an xlsx and a Google Sheets
// link. An xlsx is a zip of XML and there is no spreadsheet library in this
// project, so hand-rolling one would put a binary format nobody can review into
// the bundle. A CSV opens in Excel, Numbers and Google Sheets, and all three
// evaluate the formulas below on import, so the columns that do the arithmetic
// still do it. The Google Sheets copy link needs a sheet somebody owns, which
// is operator work rather than code.
//
// GENERATED, NOT AN ASSET. Building the file in the browser means the template
// cannot drift from the page describing it, there is no binary in git, and the
// download costs no bandwidth.
//
// THE COLUMN THAT JUSTIFIES THE PAGE is `Condition grade`. Every generic
// reseller template has cost, price and fees. None of them has the number that
// moves resale price most, which is the whole argument for the page existing
// and the honest bridge to the product.
//
// PURE. Returns a string. The click handler wraps it in a Blob.

export interface TemplateColumn {
  /** Spreadsheet column letter, so the formulas below can be read against it. */
  letter: string;
  header: string;
  /** What goes in it, shown on the page as the column guide. */
  note: string;
  /** A formula, written for row 2 and re-numbered per row. */
  formula?: string;
}

export const TEMPLATE_COLUMNS: readonly TemplateColumn[] = [
  { letter: "A", header: "SKU", note: "Your own short code. It is what ties the garment on the shelf to the row." },
  { letter: "B", header: "Bin", note: "Where it physically is. The column people skip and then spend twenty minutes regretting." },
  { letter: "C", header: "Date sourced", note: "YYYY-MM-DD. Feeds the age of your unsold stock." },
  { letter: "D", header: "Source", note: "Where it came from: a thrift store name, an estate sale, a wholesale lot." },
  { letter: "E", header: "Brand", note: "" },
  { letter: "F", header: "Item", note: "What it is, in the words you would search for it." },
  { letter: "G", header: "Size", note: "" },
  {
    letter: "H",
    header: "Condition grade",
    note: "1.0 to 10.0. The column no generic template has, and the largest single lever on what the item makes.",
  },
  { letter: "I", header: "Cost", note: "What you paid, including any buyer premium or tax." },
  { letter: "J", header: "Date listed", note: "YYYY-MM-DD. Half of the days-to-sell calculation." },
  { letter: "K", header: "Listed price", note: "What you asked. Keep it even after it sells; the gap to the sold price is worth seeing." },
  { letter: "L", header: "Platform", note: "eBay, Poshmark, Mercari, Depop, Grailed, Whatnot, Vinted." },
  { letter: "M", header: "Date sold", note: "YYYY-MM-DD. Leave blank until it sells." },
  { letter: "N", header: "Sold price", note: "What the buyer actually paid, not what you asked." },
  { letter: "O", header: "Fees", note: "The marketplace cut plus any payment processing." },
  { letter: "P", header: "Shipping cost", note: "The label you bought, not the postage the buyer paid." },
  {
    letter: "Q",
    header: "Net profit",
    note: "Calculated. Sold price less cost, fees and shipping.",
    formula: '=IF(N{r}="","",N{r}-I{r}-O{r}-P{r})',
  },
  {
    letter: "R",
    header: "Margin",
    note: "Calculated. Net profit as a share of the sold price. Format it as a percentage.",
    formula: '=IF(OR(N{r}="",N{r}=0),"",Q{r}/N{r})',
  },
  {
    letter: "S",
    header: "Days to sell",
    note: "Calculated. The number that tells you what to stop buying.",
    formula: '=IF(OR(M{r}="",J{r}=""),"",M{r}-J{r})',
  },
] as const;

/** Rows pre-filled with formulas, so the file is usable before it is edited. */
export const TEMPLATE_ROWS = 60;

interface ExampleRow {
  values: Partial<Record<string, string>>;
}

// Three rows that between them show the three states a row is ever in: sold,
// listed and waiting, and sourced but not listed. A template whose only example
// is a completed sale does not show what a half-filled row looks like.
const EXAMPLES: ExampleRow[] = [
  {
    values: {
      A: "PAT-001", B: "A3", C: "2026-06-14", D: "Goodwill Dearborn", E: "Patagonia",
      F: "Synchilla Snap-T fleece", G: "M", H: "7.5", I: "8.99", J: "2026-06-16",
      K: "78.00", L: "eBay", M: "2026-07-02", N: "65.00", O: "9.24", P: "6.55",
    },
  },
  {
    values: {
      A: "CAR-014", B: "B1", C: "2026-07-08", D: "Estate sale", E: "Carhartt",
      F: "Detroit jacket", G: "L", H: "6.0", I: "22.00", J: "2026-07-11",
      K: "145.00", L: "eBay",
    },
  },
  {
    values: {
      A: "LEV-032", B: "C2", C: "2026-08-02", D: "Bin store", E: "Levi's",
      F: "501 straight leg", G: "34x32", H: "8.0", I: "4.50",
    },
  },
];

/** RFC 4180: quote anything with a comma, quote or newline; double inner quotes. */
export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function formulaFor(col: TemplateColumn, rowNumber: number): string {
  return col.formula ? col.formula.replace(/\{r\}/g, String(rowNumber)) : "";
}

/**
 * The template as CSV text.
 *
 * Row 1 is the header. Rows 2 onward carry the calculated columns already
 * written, so a seller who types a sold price into a blank row gets the profit
 * without copying a formula down.
 */
export function buildInventoryTemplateCsv(rows: number = TEMPLATE_ROWS): string {
  const lines: string[] = [TEMPLATE_COLUMNS.map((c) => csvCell(c.header)).join(",")];

  for (let i = 0; i < Math.max(rows, EXAMPLES.length); i++) {
    const rowNumber = i + 2; // row 1 is the header
    const example = EXAMPLES[i];
    lines.push(
      TEMPLATE_COLUMNS.map((c) =>
        csvCell(example ? (example.values[c.letter] ?? formulaFor(c, rowNumber)) : formulaFor(c, rowNumber)),
      ).join(","),
    );
  }

  return lines.join("\r\n") + "\r\n";
}

export const TEMPLATE_FILENAME = "gradethread-reseller-inventory.csv";
