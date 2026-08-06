// US-2360: no browser code uploads straight to Supabase Storage.
//
// The US-276 contract is that a server upload goes
// validateImageUpload() (magic-byte sniff — the client MIME string is
// attacker-controlled and says nothing about the actual bytes) →
// stripImageMetadata() (drops EXIF/GPS) → storage.upload(). A client-direct
// upload skips all of it: the browser cannot sniff on the server's behalf, and
// a photo keeps whatever GPS coordinates the camera wrote.
//
// src/lib/storage.ts carried exactly such a helper, validating on `file.type`
// alone. It had no callers, so it was not exploitable — it was a TRAP. It
// worked, it read as correct, and the only thing keeping it out of production
// was that nobody had imported it yet. Deleting it fixes today; this fails the
// build when someone writes the next one.
//
// This is an ENUMERATION, not a ban — same shape as
// admin-direct-write-guard.test.ts. Reads and signed-URL creation are fine, and
// so is uploading to a bucket that is deliberately public. Every genuine
// exception is declared below with a reason.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { SCAN_TIMEOUT_MS } from "@/lib/__tests__/_source-scan";

const SRC = resolve(process.cwd(), "src");

/**
 * A `.storage.from("submission-images")` chain followed by an upload verb.
 * `.remove(` counts too: a client-side delete of a private object is the same
 * trust mistake pointed the other way.
 *
 * SCOPED TO THE PRIVATE BUCKET ON PURPOSE. A first draft of this guard matched
 * any bucket and flagged five call sites — photo-uploader.tsx,
 * use-reconcile-commit.ts, photo-mutations.ts, autolister.tsx and settings.tsx.
 * All five write to a PUBLIC bucket (`item-photos`, and `avatars` per US-572),
 * which is a different contract: US-276 governs `submission-images`, the
 * private grading bucket whose objects carry labels, receipts and PII. The
 * item-photo path also strips EXIF itself, client-side, via a canvas re-encode
 * before upload. Flagging them would have been a false positive that either got
 * five bogus DECLARED entries or got the guard deleted.
 *
 * That left a real open question — a client-direct upload to a public bucket
 * still has no server-side magic-byte sniff — which US-2385 then ANSWERED: a
 * sniff is not the control, and adding one here would have been security
 * theatre. Two reasons, in order of importance:
 *
 *   1. A client-side check was never a control at all. Any signed-in user can
 *      call the Storage API directly with their own token, so the page code an
 *      attacker would have to defeat is code they never execute. This guard is
 *      worth keeping for the PRIVATE bucket because that upload path also
 *      strips EXIF and RLS alone cannot do that — not because the browser is
 *      trusted to validate anything.
 *   2. The server-side control already exists and is per-bucket:
 *      `storage.buckets.allowed_mime_types`, which storage-api enforces on
 *      every upload including direct API calls. What was NOT protected was the
 *      allow-lists themselves, so the guard added is
 *      `src/test/public-bucket-mime-allowlist.test.ts` — every bucket must
 *      declare a list, and no list may admit `image/svg+xml` or any other type
 *      a browser executes.
 *
 * The residual — bytes that lie under an honest image content-type — is a
 * data-quality problem (the seller's own listing renders a broken image), not a
 * security one: it is served as `image/jpeg` with `nosniff`, from an origin
 * that is not the app's.
 */
const UPLOAD_CALL =
  /\.storage\s*\r?\n?\s*\.from\(\s*["'`]submission-images["'`]\s*\)[\s\S]{0,120}?\.(upload|remove)\(/;

/**
 * The COMPUTED form of the same write (US-2407). `bucketForItemPhotoRow(row)`
 * resolves to `submission-images` for a private-bucket photo, so a `.from()`
 * given that expression is a private-bucket write with no literal to match — the
 * regex above would wave it through, which would make this guard a formality
 * anyone can sidestep with a variable. Deliberately coarse: a module that both
 * names the private-bucket resolver and calls a storage write verb has to appear
 * in DECLARED, whether or not the two are adjacent.
 */
const COMPUTED_PRIVATE_WRITE = (src: string) =>
  /\bbucketForItemPhotoRow\b|\bPRIVATE_BUCKET\b/.test(src) &&
  /\.(upload|remove|copy)\(/.test(src);

const writesPrivateStorage = (src: string) =>
  UPLOAD_CALL.test(src) || COMPUTED_PRIVATE_WRITE(src);

interface Declared {
  file: string;
  why: string;
}

/**
 * Client-side storage writes that are deliberate. Empty is the correct state —
 * an entry here is a decision someone made and can be argued with.
 */
const DECLARED: readonly Declared[] = [
  {
    file: "src/lib/photo-mutations.ts",
    why:
      "US-2407: the photo editor's save/revert/delete round-trip, writing back " +
      "to the bucket the photo's bytes already occupy. For a phone-captured tag " +
      "that is submission-images, and the alternative was worse in both " +
      "directions: hardcoding item-photos made every such photo uneditable on " +
      "desktop (the preserve-the-original copy() 404s) and left its object " +
      "orphaned in the private bucket on delete, PII and all. The US-276 " +
      "concerns do not bite here — the bytes are a canvas re-encode the browser " +
      "just produced, so there is no camera EXIF/GPS to strip and no " +
      "attacker-supplied MIME string being trusted; the write is an upsert over " +
      "an object the user already owns, inside their own RLS-scoped folder " +
      "((storage.foldername(name))[1] = auth.uid()), so it can neither create " +
      "new objects elsewhere nor widen who can read this one; and photo_url " +
      "stays empty, which is what keeps the photo out of every marketplace and " +
      "export payload. iOS has made this exact round trip since US-979 " +
      "(PhotoRotateService uploads a rotated tag straight to submission-images " +
      "with the user's own token) — the web was the odd one out.",
  },
];

// US-2383: memoized, and the scanning test carries the shared budget. A guard
// that walks the whole tree is not a unit test.
let cached: string[] | null = null;
function sourceFiles(): string[] {
  if (!cached) {
    cached = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .filter((p) => /\.tsx?$/.test(p))
      // The guards themselves quote the call shape they scan for.
      .filter((p) => !p.startsWith("test") && !p.includes("__tests__"))
      .map((p) => `src/${p.split("\\").join("/")}`);
  }
  return cached;
}

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("US-2360: the browser never writes to Supabase Storage directly", () => {
  it("has no undeclared client-side storage upload or remove", () => {
    const declared = new Set(DECLARED.map((d) => d.file));
    const offenders = sourceFiles()
      .filter((f) => writesPrivateStorage(read(f)))
      .filter((f) => !declared.has(f))
      .sort();

    expect(
      offenders,
      "A browser-side upload skips the US-276 contract entirely: no magic-byte " +
        "sniff (the client MIME is attacker-controlled) and no EXIF/GPS strip. " +
        "Route it through the edge upload path. If it genuinely must be " +
        "client-side, add it to DECLARED with the reason.",
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("has no stale declaration", () => {
    // The other direction: a fixed call site left on the list makes the list
    // stop meaning anything.
    const stale = DECLARED
      .filter((d) => !writesPrivateStorage(read(d.file)))
      .map((d) => d.file);
    expect(stale, "these client-side writes are gone — delete their entries").toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("storage.ts exports only the read helper", () => {
    // The specific trap this story removed, pinned so a revert is loud.
    //
    // Matched on the EXPORT, not on the bare name: the module's header explains
    // what was deleted and why, and a plain not.toContain would fail on that
    // explanation — punishing the file for documenting itself.
    const src = read("src/lib/storage.ts");
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+uploadSubmissionImage/);
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+deleteSubmissionImage/);
    expect(src).toMatch(/export\s+async\s+function\s+getImageUrl/);
  });

  it("the signed-URL cap the module still owns is unchanged", () => {
    // Deleting the upload half must not disturb US-2273's shared TTL, which
    // other modules import from here.
    const src = read("src/lib/storage.ts");
    expect(src).toContain("SIGNED_URL_TTL_SECONDS = 15 * 60");
  });
});
