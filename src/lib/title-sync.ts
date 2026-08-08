// US-1891: backwards title sync (FRONTEND mirror of the edge lib).
//
// The web composer save is a direct supabase write (no edge round-trip), so
// it needs this logic client-side. Edge and web run as separate projects and
// can't import each other — keep this in LOCKSTEP with
// services/edge-functions/src/lib/title-sync.ts (same convention as the
// title-quality / title-lint mirrors). The word-boundary trim mirrors the edge
// title-trim.ts trimTitleToLimit.

export const EBAY_TITLE_MAX = 80;

const TRAILING_JUNK = /[\s\-–—_/|,;:.&+([{<"'`]+$/u;

function normalizeTitleWhitespace(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

export function trimTitleToLimit(
  title: string,
  limit: number = EBAY_TITLE_MAX,
): string {
  const normalized = normalizeTitleWhitespace(title);
  if (normalized.length <= limit) return normalized;
  const words = normalized.split(" ");
  let out = "";
  for (const word of words) {
    const candidate = out ? `${out} ${word}` : word;
    if (candidate.length > limit) break;
    out = candidate;
  }
  if (!out) return normalized.slice(0, limit).replace(TRAILING_JUNK, "");
  return out.replace(TRAILING_JUNK, "");
}

export interface FieldChange {
  field?: string;
  from: string | null | undefined;
  to: string | null | undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenBoundedRe(value: string): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRe(value)}(?![\\p{L}\\p{N}])`,
    "giu",
  );
}

function transferCase(matched: string, replacement: string): string {
  const letters = matched.replace(/[^\p{L}]/gu, "");
  if (letters.length > 0 && letters === letters.toUpperCase()) {
    return replacement.toUpperCase();
  }
  if (letters.length > 0 && letters === letters.toLowerCase()) {
    return replacement.toLowerCase();
  }
  return replacement;
}

export function applyTitleSubstitution(
  title: string,
  from: string | null | undefined,
  to: string | null | undefined,
): string {
  const src = title ?? "";
  const oldVal = (from ?? "").trim();
  const newVal = (to ?? "").trim();
  if (!oldVal || !newVal) return src;
  if (oldVal.toLowerCase() === newVal.toLowerCase()) return src;

  // US-1995: this has to be IDEMPOTENT, and a bare replace is not.
  //
  // When the new value CONTAINS the old one — "L" -> "L/XL", "North Face" ->
  // "The North Face", "Blue" -> "Blue Navy", "501" -> "501 Original" — a second
  // pass matches the old value sitting inside the replacement it just wrote and
  // expands again: "L/XL/XL", "The The North Face". Those are not exotic inputs;
  // widening a size and qualifying a brand are everyday seller corrections.
  //
  // It matters because idempotence is the ONLY thing standing between two
  // surfaces that both sync and a corrupted title. `changes` is computed from a
  // captured before-map, so a retried mutation or a not-yet-invalidated query
  // cache replays {from: old, to: new} against a title that already holds the
  // new value. "Pick one owner per surface" is the design, but it is a
  // convention, and a convention is not a guard.
  //
  // So in the containing case, spans that ALREADY read as the new value are
  // protected and only occurrences outside them are replaced.
  const expands = tokenBoundedRe(oldVal).test(newVal);
  const guarded: Array<[number, number]> = expands
    ? [...src.matchAll(tokenBoundedRe(newVal))].map((m) => {
        const start = m.index ?? 0;
        return [start, start + m[0].length] as [number, number];
      })
    : [];

  let out = "";
  let cursor = 0;
  for (const m of src.matchAll(tokenBoundedRe(oldVal))) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (guarded.some(([gs, ge]) => start >= gs && end <= ge)) continue;
    out += src.slice(cursor, start) + transferCase(m[0], newVal);
    cursor = end;
  }
  return out + src.slice(cursor);
}

export function syncTitle(
  title: string,
  changes: FieldChange[],
  limit: number = EBAY_TITLE_MAX,
): string {
  let out = title ?? "";
  for (const c of changes) out = applyTitleSubstitution(out, c.from, c.to);
  return trimTitleToLimit(out, limit);
}

export function titleNeedsSync(
  title: string,
  changes: FieldChange[],
  limit: number = EBAY_TITLE_MAX,
): boolean {
  return syncTitle(title, changes, limit) !== trimTitleToLimit(title ?? "", limit);
}

export const SYNCABLE_TITLE_FIELDS = [
  "brand",
  "size",
  "color",
  "style",
  "department",
] as const;

export function changesFromItemDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of SYNCABLE_TITLE_FIELDS) {
    const from = before[field];
    const to = after[field];
    if (
      typeof from === "string" && typeof to === "string" &&
      from.trim() && to.trim() && from.trim() !== to.trim()
    ) {
      changes.push({ field, from, to });
    }
  }
  return changes;
}
