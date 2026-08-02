// US-2385: every storage bucket declares a MIME allow-list, and no bucket
// admits a type a browser will execute or render as a document.
//
// WHY THIS GUARD AND NOT A PER-UPLOAD SNIFF. US-2360 left an open question:
// five call sites upload straight from the browser to a PUBLIC bucket, and
// nothing sniffs magic bytes, so the stored content-type is whatever the client
// claimed. That is true. It is also not the thing to fix, and the reasoning
// matters more than the conclusion:
//
//   1. A client-side check was NEVER a control. Any signed-in user can call the
//      Storage API directly with their own token. The browser code an attacker
//      would have to bypass is code they simply do not run. Adding a sniff in
//      the page protects nobody; it only makes the honest path slower.
//
//   2. The control that IS server-side already exists. storage-api validates
//      every upload against `storage.buckets.allowed_mime_types` — including
//      direct API calls — and rejects a mismatch with 415. All five public
//      buckets carry one, and none admits `image/svg+xml`, which is the one
//      image type that carries script.
//
//   3. The harm from a mislabeled file is what it is SERVED as, not what its
//      bytes are. HTML stored under `image/jpeg` comes back as `image/jpeg`,
//      with `X-Content-Type-Options: nosniff` set, from an origin that is not
//      the app's. It is inert. Bytes that lie are a data-quality problem — the
//      seller's own listing shows a broken image — not a security one.
//
// So the residual risk is not the missing sniff. It is that NOTHING PINS THE
// ALLOW-LISTS. A future migration could widen `item-photos` to accept
// `image/svg+xml` for icons, or create a public bucket with no list at all
// (which storage-api reads as "any type"), and the only server-side control
// this system has would be gone with nothing to notice. That is what this
// guard holds.
//
// Enumeration, not regex-ban: every bucket must be DECLARED here with what it
// is for, so a new one fails until someone states its purpose and its list.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS = resolve(process.cwd(), "supabase/migrations");

/**
 * Types a browser will execute, or render as a document in the storage origin.
 * A bucket admitting any of these turns user upload into user-controlled
 * content served from our infrastructure.
 *
 * `image/svg+xml` leads the list because it is the trap: it reads as an image
 * type, sits naturally in an image allow-list, and carries `<script>`.
 */
const EXECUTABLE_TYPES = [
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/css",
  "application/x-shockwave-flash",
];

/** Every bucket this project creates, and what it holds. */
const DECLARED_BUCKETS: Record<string, string> = {
  "submission-images":
    "PRIVATE. Grading photos — labels, receipts, PII. Signed-URL read only " +
    "(US-276); server uploads go through validateImageUpload + " +
    "stripImageMetadata, so this bucket does have a magic-byte sniff.",
  "item-photos":
    "PUBLIC. Seller listing imagery only. Client-direct upload, EXIF stripped " +
    "client-side by a canvas re-encode. The allow-list is its server-side check.",
  "content-images": "PUBLIC. Marketing/blog hero images, admin-authored.",
  avatars: "PUBLIC. User profile pictures (US-572), client-direct upload.",
  "cert-assets": "PUBLIC. Rendered certificate/slab PNGs, server-generated.",
  "authenticity-references":
    "PRIVATE. Brand reference imagery for authenticity checks (00500).",
  "content-videos": "PUBLIC. Marketing clips, admin-authored.",
  "compliance-exports":
    "PRIVATE, and the ONE bucket with no allow-list — deliberately. It has no " +
    "storage policies at all, so it is deny-all to anon and authenticated; " +
    "only the service-role edge client writes it, and it holds archives " +
    "(not images) whose type is decided by the server. A MIME list here would " +
    "constrain nobody and would have to be widened for every new export format.",
};

/** Buckets exempt from the allow-list requirement, with the reason. */
const NO_ALLOWLIST_OK = new Set(["compliance-exports"]);

interface Bucket {
  id: string;
  isPublic: boolean;
  mimeTypes: string[] | null;
  file: string;
}

/**
 * Parse `INSERT INTO storage.buckets (...) VALUES (...)` out of the migrations,
 * then apply any later `UPDATE storage.buckets SET allowed_mime_types = ...`.
 *
 * Applying the UPDATEs is not optional: 00323 widened two buckets to accept
 * HEIC after they were created, so reading only the INSERTs would report a
 * stale list and this guard would police a schema that no longer exists.
 */
function parseBuckets(): Bucket[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const byId = new Map<string, Bucket>();

  for (const file of files) {
    const sql = readFileSync(resolve(MIGRATIONS, file), "utf8");

    const insertRe =
      /INSERT\s+INTO\s+storage\.buckets\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*(?:ON\s+CONFLICT|;)/gi;
    for (const m of sql.matchAll(insertRe)) {
      const cols = (m[1] ?? "").split(",").map((c) => c.trim().toLowerCase());
      const body = m[2] ?? "";
      const idMatch = body.match(/'([^']+)'/);
      if (!idMatch) continue;
      const id = idMatch[1]!;
      const isPublic = /(^|,)\s*true\s*(,|$)/m.test(body.replace(/'[^']*'/g, ""));
      const mimeMatch = body.match(/ARRAY\s*\[([\s\S]*?)\]/i);
      const mimeTypes = cols.includes("allowed_mime_types")
        ? mimeMatch
          ? [...mimeMatch[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
          : null
        : null;
      byId.set(id, { id, isPublic, mimeTypes, file });
    }

    const updateRe =
      /UPDATE\s+storage\.buckets\s*SET\s+allowed_mime_types\s*=\s*ARRAY\s*\[([\s\S]*?)\][\s\S]*?WHERE([\s\S]*?);/gi;
    for (const m of sql.matchAll(updateRe)) {
      const types = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
      for (const idm of (m[2] ?? "").matchAll(/'([^']+)'/g)) {
        const existing = byId.get(idm[1]!);
        if (existing) byId.set(idm[1]!, { ...existing, mimeTypes: types });
      }
    }
  }
  return [...byId.values()];
}

const BUCKETS = parseBuckets();

describe("storage bucket MIME allow-lists (US-2385)", () => {
  // Vacuity first. Everything below asserts over BUCKETS, so a parser that
  // silently matches nothing turns the whole file green while checking nothing.
  it("actually parsed the bucket declarations", () => {
    expect(BUCKETS.length).toBeGreaterThanOrEqual(7);
    const ids = BUCKETS.map((b) => b.id);
    expect(ids).toContain("item-photos");
    expect(ids).toContain("submission-images");
    expect(ids).toContain("avatars");
    // 00323 widened these two to HEIC AFTER creation. If the UPDATE pass
    // regressed, this reads the stale INSERT list and fails here rather than
    // silently policing a schema that no longer exists.
    const sub = BUCKETS.find((b) => b.id === "submission-images");
    expect(sub?.mimeTypes, "the UPDATE pass did not apply").toContain("image/heic");
  });

  it("every bucket is declared with what it holds", () => {
    const undeclared = BUCKETS.map((b) => b.id)
      .filter((id) => !(id in DECLARED_BUCKETS))
      .sort();
    expect(
      undeclared,
      "A new storage bucket has to say what it is for and whether it is public. " +
        "Add it to DECLARED_BUCKETS.",
    ).toEqual([]);
  });

  it("has no stale declaration", () => {
    const ids = new Set(BUCKETS.map((b) => b.id));
    const stale = Object.keys(DECLARED_BUCKETS).filter((id) => !ids.has(id));
    expect(stale, "these buckets no longer exist — remove them").toEqual([]);
  });

  it("every bucket declares an allow-list, or is exempt with a reason", () => {
    const missing = BUCKETS.filter(
      (b) => !NO_ALLOWLIST_OK.has(b.id) && (!b.mimeTypes || b.mimeTypes.length === 0),
    )
      .map((b) => `${b.id} (${b.file})`)
      .sort();
    expect(
      missing,
      "storage-api treats a NULL allowed_mime_types as 'any type', so a bucket " +
        "without one has no server-side content control at all — and a " +
        "client-side check is not a substitute, because an attacker calls the " +
        "Storage API directly and never runs our page code.",
    ).toEqual([]);
  });

  it("no bucket admits a type the browser will execute or render", () => {
    const offenders: string[] = [];
    for (const b of BUCKETS) {
      for (const type of b.mimeTypes ?? []) {
        if (EXECUTABLE_TYPES.includes(type.toLowerCase())) {
          offenders.push(`${b.id} admits ${type} (${b.file})`);
        }
      }
    }
    expect(
      offenders,
      "This is the one that matters. A mislabeled JPEG is inert — it is served " +
        "as image/jpeg with nosniff and no browser runs it. An SVG is not: it " +
        "reads as an image type, sits naturally in an image allow-list, and " +
        "carries <script>. Admitting one turns every signed-in user into " +
        "someone who can host active content on our infrastructure.",
    ).toEqual([]);
  });

  it("the public buckets are exactly the ones we think they are", () => {
    // Flipping a bucket to public is a one-word migration diff and an easy
    // thing to wave through in review. Naming them makes it a conversation.
    const publicIds = BUCKETS.filter((b) => b.isPublic).map((b) => b.id).sort();
    expect(publicIds).toEqual([
      "avatars",
      "cert-assets",
      "content-images",
      "content-videos",
      "item-photos",
    ]);
  });
});
