// US-1891: backwards title sync (FRONTEND mirror of the edge lib).
//
// The web item-canvas save is a direct supabase write (no edge round-trip), so
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
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRe(oldVal)}(?![\\p{L}\\p{N}])`,
    "giu",
  );
  return src.replace(re, (m) => transferCase(m, newVal));
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
