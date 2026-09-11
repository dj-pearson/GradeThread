// US-3139: name an AutoLister photo group from what the garment's own tag says,
// instead of the minted "Item 3".
//
// Everything here is PURE — no OCR engine, no network, no React. The engine
// wrapper lives in `tesseract-ocr.ts` and the orchestration in
// `use-autolister-tag-ocr.ts`, so the rules that decide WHAT a group is called
// unit-test without a 2 MB wasm download.
//
// Brand resolution is deliberately NOT here: the curated alias table (and the
// brand_knowledge rows behind it) live on the edge, and a raw OCR string is
// matched against them by POST /api/flipdesk/autolister/tag-brand. This module
// handles the half that is pure string work — size, filename, composition.

/** The placeholder every freshly minted group carries. */
export const DEFAULT_GROUP_NAME_RE = /^\s*Item\s+\d+\s*$/;

/**
 * True when the group still carries a name nobody chose — the minted
 * "Item 3", or nothing at all. The auto-namer only ever writes over these, so
 * a name the seller typed (or an earlier OCR pass wrote) is never clobbered.
 */
export function isDefaultGroupName(name: string | null | undefined): boolean {
  if (name == null) return true;
  if (name.trim() === "") return true;
  return DEFAULT_GROUP_NAME_RE.test(name);
}

// The photo roles that carry a readable brand/size label, in the priority the
// OCR pass reads them. Mirrors TAG_PHOTO_TYPES / TAG_OCR_FALLBACK_TYPES in
// services/edge-functions/src/lib/ai-tag-ocr.ts — `internal` is excluded there
// for the same reason it is excluded here: US-1549 makes it the seller's own
// price-tag reference, so its text would name the group after a thrift store.
const OCR_ROLE_RANK: Record<string, number> = {
  tag: 0,
  tag_2: 0,
  interior: 1,
  marking: 1,
};

/**
 * The one photo in a group worth running OCR over, or null when the group has
 * nothing label-like. Ties keep input order (which is the seller's order).
 */
export function pickOcrPhoto<T extends { role?: string | null }>(
  photos: readonly T[],
): T | null {
  let best: T | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const p of photos) {
    const rank = p.role ? OCR_ROLE_RANK[p.role] : undefined;
    if (rank === undefined) continue;
    if (rank < bestRank) {
      best = p;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Collapse the line noise an OCR engine emits into one line. Returns "" when
 * the text carries no letter or digit at all — a scan that read only speckle.
 */
export function tidyOcrText(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return /[A-Za-z0-9]/.test(collapsed) ? collapsed : "";
}

// Spelled-out and run-of-X sizes, normalized onto the short form eBay indexes.
const SIZE_WORDS: Record<string, string> = {
  XXS: "2XS",
  XS: "XS",
  "X-SMALL": "XS",
  XSMALL: "XS",
  "EXTRA SMALL": "XS",
  S: "S",
  SM: "S",
  SMALL: "S",
  M: "M",
  MED: "M",
  MEDIUM: "M",
  L: "L",
  LG: "L",
  LARGE: "L",
  XL: "XL",
  "X-LARGE": "XL",
  XLARGE: "XL",
  "EXTRA LARGE": "XL",
  XXL: "2XL",
  "2XL": "2XL",
  XXXL: "3XL",
  "3XL": "3XL",
  XXXXL: "4XL",
  "4XL": "4XL",
};

function normalizeSizeWord(raw: string): string | null {
  const key = raw.toUpperCase().replace(/\s+/g, " ").trim();
  return SIZE_WORDS[key] ?? null;
}

/**
 * The garment size the label shows, or null. Reads, in order: waist x inseam,
 * an explicitly labelled size ("SIZE M", "Size: Large"), then a bare letter
 * size standing alone as its own word.
 *
 * A bare NUMBER is only ever read behind the word "size" — on a care label a
 * loose number is a fibre percentage or an RN, not a size.
 */
export function extractSizeFromOcr(raw: string): string | null {
  const text = tidyOcrText(raw);
  if (!text) return null;

  // 32 X 34 / 34x30 — a two-number pair is unambiguous on a garment tag.
  const wxl = text.match(/(?<![\d.%])(\d{2})\s*[x×]\s*(\d{2})(?![\d.%])/i);
  if (wxl) return `${wxl[1]}x${wxl[2]}`;

  // W34 L32 (and W34/L32).
  const wl = text.match(/\bW\s*(\d{2})\s*[/\s-]*\s*L\s*(\d{2})\b/i);
  if (wl) return `${wl[1]}x${wl[2]}`;

  // SIZE <token> — the label naming its own size.
  const labelled = text.match(
    /\bsizes?\b\s*[:.-]?\s*(x{1,3}-?\s?(?:small|large)|extra\s+(?:small|large)|[0-9]?x{0,3}[slm]g?\b|small|medium|large|\d{1,2}(?:\.5)?)/i,
  );
  if (labelled?.[1]) {
    const token = labelled[1];
    const word = normalizeSizeWord(token);
    if (word) return word;
    if (/^\d/.test(token) && !/x/i.test(token)) return token;
  }

  // A bare letter size as its own word: "CARHARTT XL MADE IN MEXICO".
  for (const token of text.split(/[^A-Za-z0-9-]+/)) {
    if (!token || /^\d+$/.test(token)) continue;
    const word = normalizeSizeWord(token);
    if (word) return word;
  }

  return null;
}

// Filenames a camera or an app minted. None of these says anything about the
// garment, so a group named from one is worse than "Item 3".
const CAMERA_NAME_RE =
  // The lookahead, not \b, is what makes "DSC00123" match: a letter followed by
  // a digit is not a word boundary, so \b would let every separator-less camera
  // name through.
  /^(img|dsc|dscn|dscf|pxl|mvimg|gopr|pano|burst|screenshot|untitled|photo|image|pic|picture|file|download|received)(?=[\s\d_-]|$)/i;
const TIMESTAMP_NAME_RE = /^\d{6,}([_\s-]\d{3,})?$/;

const MAX_NAME_LENGTH = 60;

function titleCase(words: readonly string[]): string {
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * A group name derived from the source filename, when the seller clearly typed
 * one ("carhartt detroit jacket.jpg"). Null for anything a camera minted.
 */
export function nameFromSourceName(
  sourceName: string | null | undefined,
): string | null {
  if (!sourceName) return null;
  const stem = sourceName.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const cleaned = stem.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (CAMERA_NAME_RE.test(cleaned)) return null;
  if (TIMESTAMP_NAME_RE.test(cleaned)) return null;
  if (!/[A-Za-z]{2}/.test(cleaned)) return null;

  const words = cleaned.split(" ").filter(Boolean);
  const kept: string[] = [];
  let length = 0;
  for (const word of words) {
    const next = length === 0 ? word.length : length + 1 + word.length;
    if (next > MAX_NAME_LENGTH) break;
    kept.push(word);
    length = next;
  }
  if (kept.length === 0) return null;
  return titleCase(kept);
}

export interface GroupNameParts {
  /** Canonical brand, as resolved from the OCR text by the edge. */
  brand?: string | null;
  /** Normalized size ("M", "32x34"). */
  size?: string | null;
  /** Filename of the group's cover photo, for the no-brand fallback. */
  sourceName?: string | null;
}

/**
 * Compose the group's name from everything known about it, best signal first:
 * the brand off the tag, else a filename the seller typed. Size goes last so a
 * batch of names sorts by brand. Null when there is nothing worth saying — the
 * caller then leaves "Item 3" in place.
 *
 * DECIDED US-3349, 2026-09-11: this used to take `color` and `garment` too, and
 * fall back to "Navy Hoodie" when neither the tag nor the filename said
 * anything. Deleted, because no caller could ever reach that rung: a staged
 * AutoLister group (the Group type in pages/flipdesk/autolister.tsx) carries no
 * color and no garment at OCR time, so the only caller
 * (use-autolister-tag-ocr.ts) passed brand, size and sourceName and nothing
 * else. The rung had a green unit test, and a green test for a branch no user
 * can reach reads as coverage while meaning nothing about production. The
 * signature now promises exactly the two rungs it can climb.
 *
 * If garment classification ever moves ahead of naming in the pipeline, add the
 * parameter back TOGETHER with the caller that supplies it, in one commit. A
 * parameter is not a feature; the caller is.
 *
 * NO AUTOMATED GUARD WAS BUILT FOR THIS SHAPE, and the measurement is the
 * reason. A scan for "optional parameter no production caller supplies" was
 * written and run over src, services and functions: 360 options-bag functions,
 * 91 where every production call site is a readable object literal, and 13
 * never-supplied optional props. All 13 were read, and all 13 are deliberate
 * overrides with an in-function default: the injected clock in
 * ship-deadline.ts, the zeroed cost lines in listing-profit.ts, photoCount in
 * performance-signals.ts, whose own comment says callers may omit it. `garment`
 * was syntactically identical to every one of them. The shape is detectable and
 * the defect is not, so the check would fail the build on correct code roughly
 * thirteen times for each real finding, and its routine resolution would be
 * appending to its own allowlist. What found this was a human reading the doc
 * comment against the one call site; the durable fix is the rule above.
 */
export function buildGroupName(parts: GroupNameParts): string | null {
  const brand = parts.brand?.trim() || null;
  const size = parts.size?.trim() || null;

  const base = brand ?? nameFromSourceName(parts.sourceName);
  if (!base) return null;

  return size ? `${base} ${size}` : base;
}

/**
 * The proposed name, numbered if a group already carries it. Two jackets off
 * the same rack read the same tag, and "Carhartt" twice in the list is worse
 * than "Carhartt" and "Carhartt 2". Comparison is case-insensitive, so a
 * hand-typed "carhartt" still counts as taken. Pure.
 */
export function uniqueGroupName(name: string, taken: ReadonlySet<string>): string {
  const lower = new Set(Array.from(taken, (t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name} ${n}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

/** One group's slot in an OCR pass. */
export interface OcrPassJob {
  groupId: string;
  /** The photo to read, or null when the group has nothing label-like — the
   *  job still runs so the filename fallback gets its turn. */
  photoId: string | null;
  /** The pair key to mark attempted once the job has run, hit or miss. */
  key: string;
}

export interface PlannableGroup {
  id: string;
  name: string;
  photoIds: string[];
  roles?: Record<string, string>;
}

/**
 * The groups an OCR pass should work on: still carrying a minted name, and not
 * already tried with this same tag photo. Pure, so the attempt-once rule — the
 * one thing standing between this feature and an OCR run on every render — is
 * testable without a wasm worker.
 *
 * The key pairs the group with the photo, so re-tagging a photo as `tag`, or
 * dropping a different label shot into the group, makes it eligible again.
 */
export function planOcrPass(
  groups: readonly PlannableGroup[],
  attempted: ReadonlySet<string>,
): OcrPassJob[] {
  const jobs: OcrPassJob[] = [];
  for (const group of groups) {
    if (!isDefaultGroupName(group.name)) continue;
    const target = pickOcrPhoto(
      group.photoIds.map((pid) => ({ id: pid, role: group.roles?.[pid] })),
    );
    const photoId = target?.id ?? null;
    const key = `${group.id}:${photoId ?? "none"}`;
    if (attempted.has(key)) continue;
    jobs.push({ groupId: group.id, photoId, key });
  }
  return jobs;
}
