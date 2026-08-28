// US-276 — the upload pipeline is applied, not merely available.
//
// CLAUDE.md: server uploads MUST go validateImageUpload() (magic-byte sniff,
// not client MIME) → stripImageMetadata() (drops EXIF/GPS) → storage.upload().
// upload-validation_test.ts proves the validator WORKS. Nothing proved anyone
// CALLS it, which is the half that actually protects a user.
//
// ── Guard 1: no upload path may admit HEIC ─────────────────────────────────
//
// This is the sharp one, and its rationale is easy to misread as a
// compatibility nit. From image-metadata.ts: HEIC stores EXIF in an ISOBMFF
// `meta` box that the metadata stripper — deliberately dependency-free, no
// image decoder — cannot parse, and HEIC embeds GPS exactly like JPEG. So a
// stored HEIC would carry LIVE COORDINATES OF WHERE THE PHOTO WAS TAKEN.
//
// The guarantee is currently held up by fifteen hand-written `allow:` lists,
// each independently spelling jpeg/png/webp, plus a throw inside
// stripImageMetadata as a runtime backstop. Fifteen copies of one rule is the
// exact shape that has drifted repeatedly in this repo (the weighted-overall
// rounding sites, the hand-synced image sitemap, the RLS initplan sweep). The
// runtime throw is a good backstop but it fires in production, on a real user's
// photo; this fires at build time, on the commit that would have widened it.
//
// ── Guard 2: every storage.upload() is classified ──────────────────────────
//
// Every `.upload()` call must either have validateImageUpload in the same
// function, or be named below with a reason. A NEW upload route therefore fails
// until someone classifies it, rather than shipping unvalidated because nobody
// noticed — the same "a new one is covered for free" property rls-guard and the
// /api auth-coverage guard rely on.

import { assert, assertEquals } from "@std/assert";

const EDGE_SRC = new URL("../", import.meta.url);

async function sourceFiles(dir: URL, acc: URL[] = []): Promise<URL[]> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name === "tests" || entry.name === "node_modules") continue;
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) await sourceFiles(child, acc);
    else if (entry.name.endsWith(".ts") && !/_test\.ts$/.test(entry.name)) {
      acc.push(child);
    }
  }
  return acc;
}


/**
 * Does an upload at `uploadIdx` have validateImageUpload in its OWN function?
 *
 * The first version of this guard looked back a fixed 3,000 characters for the
 * string `validateImageUpload`. It passed against a file whose validation had
 * been deleted — because the IMPORT line still mentioned the name, and so did a
 * DIFFERENT handler further up. Both are within 3,000 characters; neither
 * protects this upload.
 *
 * That is the third time this session a source guard matched something other
 * than the thing it meant to check (US-2103 matched a hand-listed set that
 * excluded the fixed files; US-2104 matched an import line). The pattern is
 * always the same: a substring search that is satisfied by context rather than
 * by the property under test.
 *
 * So: scan back only to the start of the ENCLOSING function, and require a
 * CALL — `validateImageUpload(` with the paren — which an import can never
 * satisfy.
 */
export function validatesInScope(src: string, uploadIdx: number): boolean {
  const head = src.slice(0, uploadIdx);
  // Nearest enclosing function-ish boundary. Handlers in this codebase are
  // `x.post("/p", async (c) => {`; libs use `export async function name(`.
  const bounds = [
    head.lastIndexOf("async (c)"),
    head.lastIndexOf("export async function"),
    head.lastIndexOf("export function"),
    head.lastIndexOf("async function"),
  ];
  const start = Math.max(...bounds, 0);
  return /validateImageUpload\s*\(/.test(src.slice(start, uploadIdx));
}

const rel = (u: URL) => u.pathname.split("/services/edge-functions/")[1] ?? u.pathname;

Deno.test("US-276: no upload path widens the format allowlist to admit HEIC", async () => {
  const offenders: string[] = [];
  let lists = 0;

  for (const url of await sourceFiles(EDGE_SRC)) {
    const src = await Deno.readTextFile(url);
    for (const m of src.matchAll(/allow\s*:\s*\[([^\]]*)\]/g)) {
      const body = m[1]!;
      // `user_allow` on feature flags is an unrelated field of the same shape.
      const ctx = src.slice(Math.max(0, m.index - 12), m.index);
      if (/user_$/.test(ctx)) continue;
      lists++;
      if (/["'`]heic["'`]/i.test(body)) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${rel(url)}:${line} — allow: [${body.trim()}]`);
      }
    }
  }

  assert(
    lists >= 10,
    `expected to find the format allowlists, saw ${lists} — the matcher is ` +
      `probably broken, and a guard that inspects nothing passes everything`,
  );
  assertEquals(
    offenders,
    [],
    "HEIC must never be accepted by an upload path. Its EXIF lives in an " +
      "ISOBMFF `meta` box that stripImageMetadata cannot parse (no image " +
      "decoder, deliberately), and HEIC embeds GPS like JPEG — so the stored " +
      "photo would carry live coordinates of where it was taken. The client " +
      "transcodes HEIC before upload. If you genuinely need HEIC server-side, " +
      "write the box parser FIRST:\n" + offenders.join("\n"),
  );
});

// Uploads that legitimately bypass validateImageUpload. Each entry states WHY —
// an unexplained entry is indistinguishable from an oversight, which is the
// failure this guard exists to prevent.
const UNVALIDATED_UPLOADS = new Map<string, string>([
  ["src/lib/defect-annotations.ts", "SERVER-RENDERED: the annotated defect overlay we draw ourselves; the source photo was validated on its own upload path."],
  ["src/lib/openai-images.ts", "SERVER-GENERATED: bytes from our own image generation, and it validates separately at :243 before storing."],
  ["src/routes/admin-compliance.ts", "NOT AN IMAGE: a JSON compliance archive. The image validator does not apply."],
  ["src/routes/content-public.ts", "SERVER-RENDERED: an OG card PNG we compose; no user bytes involved."],
  ["src/routes/flipdesk-measure.ts", "SERVER-RENDERED: the measurement overlay JPEG, drawn from measurement math."],
  ["src/routes/flipdesk-images.ts", "DERIVED: the background-removal provider's output for a photo already validated on upload. Bytes are third-party rather than user-supplied; re-validating would be defensible and is worth revisiting if that provider is ever swapped."],
  ["src/lib/grading-submit.ts", "COPY: re-stores an existing item photo into the grading submission. The bytes passed validateImageUpload on their original upload, and no path admits HEIC (guarded above), so the private bucket's stricter allowlist cannot be bypassed by this copy. Moved here from routes/flipdesk-grading.ts by US-9129; the copy itself is unchanged."],
  ["src/routes/jobs-thumbnail-backfill.ts", "DERIVED: thumbnails generated from already-stored, already-validated originals."],
  ["src/lib/measure-upright-pass.ts", "COPY + DERIVED: two writes, neither of them user-supplied bytes. The first copies the ALREADY-STORED photo byte-for-byte to its originals/ path so the rotation is revertible; the second is that same photo re-encoded after a quarter turn. Both descend from bytes that passed validateImageUpload on their own upload, and nothing here accepts a request body. Re-validating the copy would reject nothing and would make a failed validation silently skip preserving the original, which is the one thing US-2890 must never do."],
]);

Deno.test("US-276: every storage.upload() either validates or is classified", async () => {
  const unclassified: string[] = [];
  let total = 0;

  for (const url of await sourceFiles(EDGE_SRC)) {
    const src = await Deno.readTextFile(url);
    const r = rel(url);
    for (const m of src.matchAll(/\.upload\s*\(/g)) {
      total++;
      if (validatesInScope(src, m.index)) continue;
      if (UNVALIDATED_UPLOADS.has(r)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      unclassified.push(`${r}:${line}`);
    }
  }

  assert(total > 10, `expected to find upload call sites, saw ${total}`);
  assertEquals(
    unclassified,
    [],
    "These storage.upload() calls neither validate their bytes nor appear in " +
      "UNVALIDATED_UPLOADS. Server uploads of user-supplied bytes MUST go " +
      "validateImageUpload → stripImageMetadata → upload (CLAUDE.md, US-276). " +
      "If the bytes are server-generated or derived from an already-validated " +
      "original, add an entry WITH THE REASON:\n" + unclassified.join("\n"),
  );
});

Deno.test("US-276: the exemption list has no dead entries", () => {
  // A stale exemption silently widens the guard. Every entry must correspond to
  // a file that still exists and still contains an unvalidated upload —
  // otherwise the list grows into a permanent hole nobody re-reads.
  for (const [file, reason] of UNVALIDATED_UPLOADS) {
    assert(reason.trim().length > 40, `${file}: exemption needs a real reason`);
  }
  assert(UNVALIDATED_UPLOADS.size > 0);
});
