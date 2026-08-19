// US-2682: a fixed-shape facts block in every generated description (PURE).
//
// WHO THIS IS FOR, and it is not the human buyer. eBay summarises descriptions
// with its own model, and its shopping agent takes conversational intent rather
// than keywords (playbook §12). The consistent finding across agentic-commerce
// coverage is that an agent SKIPS an item with incomplete attributes rather
// than guessing at them. GradeThread's numeric grade and factor breakdown are
// structured data no other lister has, and right now they are prose — so a
// summariser paraphrases them and an agent cannot read them at all.
//
// PAIRED MARKERS, not a div-depth scan. seller-credentials.ts finds its block by
// walking <div> nesting, which works and is fragile: it has a MAX_TAG_SCAN
// bail-out because a malformed description can run it off the end. A facts block
// has to be REPLACED on every revise (AC5), so it gets an explicit end marker
// and replacement becomes a slice between two known strings. Cheaper, and it
// cannot mis-parse.
//
// NO URLS, EVER. Same rule as the credential block: eBay treats an off-eBay URL
// in a description as offering to trade outside eBay and HIDES the listing
// (observed, ref 2-106523659851). Everything here is text.
//
// PURE (no I/O), unit-tested directly.

export const FACTS_MARKER_START = "<!--gradethread-facts-->";
export const FACTS_MARKER_END = "<!--/gradethread-facts-->";

/** One factor of the grade, as the grading engine reports it. */
export interface FactsGradeFactor {
  /** Human label, e.g. "Fabric condition". */
  label: string;
  /** 1.0-10.0, in 0.5 steps. */
  score: number;
}

/** A flat measurement, in inches, exactly as the seller supplied it. */
export interface FactsMeasurement {
  label: string;
  inches: number;
}

export interface ListingFacts {
  /** Overall 1.0-10.0, rounded to 0.1. Null when the item is not graded. */
  grade: number | null;
  factors: FactsGradeFactor[];
  /** Flat measurements in inches. Order preserved — it is the seller's order. */
  measurements: FactsMeasurement[];
  /** e.g. "100% cotton". One string, as written on the garment's label. */
  fibreContent: string | null;
  /** Disclosed flaws, one per entry. Empty means none were disclosed. */
  flaws: string[];
}

const LABELS = {
  grade: "Condition grade",
  factors: "Grade breakdown",
  measurements: "Measurements (flat, inches)",
  fibre: "Fibre content",
  flaws: "Disclosed flaws",
} as const;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** One decimal for a grade, one for a measurement. Never scientific notation. */
function num(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : "";
}

function cleanLabel(s: string): string {
  return s.replace(/[:\n\r]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The lines of the block, label-first, one fact per line.
 *
 * This shape is the contract: `Label: value`, and for lists `Label: a; b; c`.
 * Semicolons rather than commas inside a list, because a measurement label can
 * legitimately contain a comma and a parser splitting on commas would then cut a
 * fact in half. It is also why AC3 is satisfiable at all — a comma-separated
 * run of terms is exactly what a keyword dump looks like, and eBay treats
 * keyword stuffing in a description as a policy violation.
 */
export function listingFactsLines(facts: ListingFacts): string[] {
  const lines: string[] = [];

  if (facts.grade !== null && Number.isFinite(facts.grade)) {
    lines.push(`${LABELS.grade}: ${num(facts.grade)} of 10`);
  }
  if (facts.factors.length > 0) {
    lines.push(
      `${LABELS.factors}: ` +
        facts.factors.map((f) => `${cleanLabel(f.label)} ${num(f.score)}`).join("; "),
    );
  }
  if (facts.measurements.length > 0) {
    lines.push(
      `${LABELS.measurements}: ` +
        facts.measurements.map((m) => `${cleanLabel(m.label)} ${num(m.inches)}`).join("; "),
    );
  }
  const fibre = facts.fibreContent?.trim();
  if (fibre) lines.push(`${LABELS.fibre}: ${cleanLabel(fibre)}`);

  const flaws = facts.flaws.map((f) => cleanLabel(f)).filter((f) => f.length > 0);
  if (flaws.length > 0) lines.push(`${LABELS.flaws}: ${flaws.join("; ")}`);

  return lines;
}

export interface ListingFactsBlock {
  plain: string;
  /** Marker-wrapped, ready to sit inside a description. */
  html: string;
}

/**
 * Render the facts block.
 *
 * The markup is deliberately the plainest thing that still parses as a list:
 * one `<ul>`, `<li>` per fact, `<strong>` for the label. No table — eBay's
 * mobile description view is narrow and a table either scrolls sideways or
 * squeezes columns to one word each. No `style` attribute, no class, no script:
 * eBay strips or ignores most of it and a summariser has to skip whatever
 * survives to find the text.
 */
export function buildListingFactsBlock(facts: ListingFacts): ListingFactsBlock {
  const lines = listingFactsLines(facts);
  const plain = lines.join("\n");
  if (lines.length === 0) {
    return { plain: "", html: "" };
  }

  const items = lines
    .map((line) => {
      const at = line.indexOf(": ");
      const label = line.slice(0, at);
      const value = line.slice(at + 2);
      return `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</li>`;
    })
    .join("");

  return {
    plain,
    html: `${FACTS_MARKER_START}<ul>${items}</ul>${FACTS_MARKER_END}`,
  };
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Recover the facts from a description that carries the block.
 *
 * AC2 exists because a block that only LOOKS structured is not machine-readable
 * — the test that matters is whether what was written can be read back. Returns
 * null when the markers are absent, which is every listing that predates this.
 */
export function parseListingFactsBlock(description: string): ListingFacts | null {
  const start = description.indexOf(FACTS_MARKER_START);
  if (start < 0) return null;
  const end = description.indexOf(FACTS_MARKER_END, start);
  if (end < 0) return null;

  const inner = description.slice(start + FACTS_MARKER_START.length, end);
  const facts: ListingFacts = {
    grade: null,
    factors: [],
    measurements: [],
    fibreContent: null,
    flaws: [],
  };

  for (const m of inner.matchAll(/<li><strong>([^<]*):<\/strong>\s*([^<]*)<\/li>/g)) {
    const label = unescapeHtml(m[1] ?? "").trim();
    const value = unescapeHtml(m[2] ?? "").trim();
    if (!value) continue;

    if (label === LABELS.grade) {
      const n = Number.parseFloat(value);
      facts.grade = Number.isFinite(n) ? n : null;
    } else if (label === LABELS.factors) {
      facts.factors = splitList(value).map(splitTrailingNumber).filter((f) =>
        f !== null
      ) as FactsGradeFactor[];
    } else if (label === LABELS.measurements) {
      facts.measurements = splitList(value)
        .map(splitTrailingNumber)
        .filter((f) => f !== null)
        .map((f) => ({ label: f!.label, inches: f!.score }));
    } else if (label === LABELS.fibre) {
      facts.fibreContent = value;
    } else if (label === LABELS.flaws) {
      facts.flaws = splitList(value);
    }
  }

  return facts;
}

function splitList(value: string): string[] {
  return value.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** "Chest 21" -> { label: "Chest", score: 21 }. Null when there is no number. */
function splitTrailingNumber(entry: string): FactsGradeFactor | null {
  const m = /^(.*?)\s+(-?\d+(?:\.\d+)?)$/.exec(entry.trim());
  if (!m) return null;
  const label = (m[1] ?? "").trim();
  const score = Number.parseFloat(m[2] ?? "");
  if (!label || !Number.isFinite(score)) return null;
  return { label, score };
}

// ---------------------------------------------------------------------------
// Putting it in a description, once
// ---------------------------------------------------------------------------

/**
 * Insert or REPLACE the facts block in a description.
 *
 * AC1 wants a fixed position and AC5 wants revise-in-place to pick it up on a
 * listing that already exists, and those are the same requirement seen twice: a
 * block that moves cannot be replaced, and a block that cannot be replaced
 * accumulates. Appended at the END, after the seller's prose and before nothing,
 * because the facts are a reference the reader consults rather than an opening
 * they read past.
 *
 * Passing facts that render to nothing REMOVES an existing block rather than
 * leaving a stale one. A listing whose measurements were deleted should not keep
 * advertising them.
 */
export function upsertListingFactsBlock(
  description: string | null | undefined,
  facts: ListingFacts,
): string {
  const base = description ?? "";
  const { html } = buildListingFactsBlock(facts);

  const start = base.indexOf(FACTS_MARKER_START);
  if (start >= 0) {
    const end = base.indexOf(FACTS_MARKER_END, start);
    if (end >= 0) {
      const before = base.slice(0, start).trimEnd();
      const after = base.slice(end + FACTS_MARKER_END.length).trimStart();
      const rest = [before, after].filter((s) => s.length > 0).join("\n\n");
      if (!html) return rest;
      return rest.length > 0 ? `${rest}\n\n${html}` : html;
    }
  }

  if (!html) return base;
  const trimmed = base.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${html}` : html;
}

// ---------------------------------------------------------------------------
// Adapters: the shapes the rest of the codebase already has
// ---------------------------------------------------------------------------

/**
 * The five grade factors, in the order and with the labels the grading contract
 * uses (vault/20-domain/grading-scale-and-weights.md).
 *
 * Read from the five NUMERIC COLUMNS on grade_reports rather than a jsonb blob,
 * because that is what the table actually has — 00001 defines
 * fabric_condition_score and friends individually.
 *
 * Order is the weight order, heaviest first, so a buyer skimming the line reads
 * the factors that moved the number most before the ones that barely did.
 */
const FACTOR_COLUMNS: Array<[string, string]> = [
  ["fabric_condition_score", "Fabric"],
  ["structural_integrity_score", "Structural"],
  ["cosmetic_appearance_score", "Cosmetic"],
  ["functional_elements_score", "Functional"],
  ["odor_cleanliness_score", "Odor"],
];

/** Pull the factor breakdown off a grade_reports row. Missing scores are dropped. */
export function factorScoresToFacts(row: Record<string, unknown>): FactsGradeFactor[] {
  const out: FactsGradeFactor[] = [];
  for (const [column, label] of FACTOR_COLUMNS) {
    const score = Number(row[column]);
    // A factor we could not read is omitted, never zeroed: 0 is off the 1-10
    // scale entirely and would read as the worst possible score for something
    // nobody measured.
    if (Number.isFinite(score) && score > 0) out.push({ label, score });
  }
  return out;
}

/**
 * Flat measurements, in inches, EXACTLY as stored.
 *
 * The listing_gen_v2 rule is that supplied measurements survive verbatim, so
 * nothing here rounds, converts or reorders. Non-numeric entries are dropped
 * rather than coerced: "about 21" is not a measurement a buyer can check
 * against their own tape.
 */
export function measurementsToFacts(
  measurements: Record<string, unknown> | null | undefined,
): FactsMeasurement[] {
  const out: FactsMeasurement[] = [];
  for (const [key, raw] of Object.entries(measurements ?? {})) {
    const inches = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
    if (!Number.isFinite(inches) || inches <= 0) continue;
    const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
    if (label) out.push({ label, inches });
  }
  return out;
}

/**
 * Disclosed flaws, from the condition description the disclosure block writes.
 *
 * Split on newlines and bullet markers only. NOT on commas or semicolons: a
 * single flaw is often a sentence with a comma in it, and cutting one in half
 * would turn "Small mark on the left cuff, near the seam" into two flaws, one
 * of which reads as a separate defect.
 */
export function disclosedFlawsToFacts(
  conditionDescription: string | null | undefined,
): string[] {
  const text = (conditionDescription ?? "").trim();
  if (!text) return [];
  return text
    .split(/\r?\n+/)
    .map((line) => line.replace(/^\s*[-*\u2022]\s*/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 12);
}
