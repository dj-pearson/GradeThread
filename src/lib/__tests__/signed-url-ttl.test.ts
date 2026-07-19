// Private-bucket signed URLs must expire within 900 seconds.
//
// CLAUDE.md states the rule ("read only via createSignedUrl TTL <= 900s — NEVER
// getPublicUrl") and four separate edge modules each define their own
// `SIGNED_URL_TTL = 15 * 60` in agreement with it. Nothing enforced it, and the
// web client had drifted to `60 * 60`: a link to a seller's garment and LABEL
// photos — which can carry names, addresses and receipts — stayed valid for an
// hour. A rule written in four comments and checked in zero places is the same
// shape as the "keep in lockstep" comments that had already drifted in prod.
//
// This scans real call sites rather than trusting the constants, because the
// drift happened in a call site, not in a constant.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "services/edge-functions/src", "functions"];
const MAX_TTL_SECONDS = 900;

/**
 * Buckets that are PUBLIC by design (CLAUDE.md): listing imagery and blog/
 * content images. A signed URL over these is unusual but not a privacy issue,
 * so they are out of scope rather than silently passing.
 */
const PUBLIC_BUCKETS = ["item-photos", "content-images"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory absent in this checkout
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Resolve a TTL argument to seconds. Handles literals (`900`), simple products
 * (`15 * 60`) and single-level constant references resolved within the same
 * file. Returns null when the value is genuinely dynamic — those are reported
 * separately rather than assumed safe.
 */
function resolveTtl(arg: string, fileText: string): number | null {
  const expr = arg.trim();

  const literal = /^\d+$/.exec(expr);
  if (literal) return Number(literal[0]);

  const product = /^(\d+)\s*\*\s*(\d+)$/.exec(expr);
  if (product) return Number(product[1]) * Number(product[2]);

  const ident = /^[A-Za-z_$][\w$]*$/.exec(expr);
  if (ident) {
    const decl = new RegExp(`const\\s+${expr}\\s*(?::\\s*number)?\\s*=\\s*([^;\\n]+)`).exec(
      fileText,
    );
    if (decl?.[1]) return resolveTtl(decl[1], "");
  }
  return null;
}

describe("private-bucket signed URLs expire within 900s", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) files.push(...walk(resolve(ROOT, d)));

  const calls: Array<{ file: string; bucket: string; ttl: number | null; raw: string }> = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("createSignedUrl")) continue;
    const rel = relative(ROOT, file).split("\\").join("/");
    if (rel === "src/lib/__tests__/signed-url-ttl.test.ts") continue;

    for (const m of text.matchAll(/createSignedUrl\(\s*([^,]+),\s*([^),]+)/g)) {
      // Nearest preceding .from("bucket") is the bucket for this call.
      const before = text.slice(0, m.index);
      // Bucket may be a literal (.from("submission-images")) or a constant
      // (.from(BUCKET_NAME)); resolve the constant so failure messages name the
      // real bucket. Anything unresolved stays "unknown" and is treated as
      // PRIVATE — the fail-safe direction, since guessing "public" would let a
      // real violation through silently.
      const buckets = [...before.matchAll(/\.from\(\s*(?:["'`]([\w-]+)["'`]|([A-Za-z_$][\w$]*))\s*\)/g)];
      const last = buckets[buckets.length - 1];
      let bucket = "unknown";
      if (last?.[1]) bucket = last[1];
      else if (last?.[2]) {
        const decl = new RegExp(`const\\s+${last[2]}\\s*=\\s*["'\`]([\\w-]+)["'\`]`).exec(text);
        bucket = decl?.[1] ?? "unknown";
      }
      calls.push({ file: rel, bucket, ttl: resolveTtl(m[2]!, text), raw: m[2]!.trim() });
    }
  }

  it("finds signed-URL call sites at all", () => {
    // Without this the whole suite passes vacuously if the scan or regex breaks.
    expect(calls.length, "no createSignedUrl call sites found — the scan broke").toBeGreaterThan(5);
  });

  it("no private-bucket call exceeds the cap", () => {
    const violations = calls
      .filter((c) => !PUBLIC_BUCKETS.includes(c.bucket))
      .filter((c) => c.ttl !== null && c.ttl > MAX_TTL_SECONDS)
      .map((c) => `${c.file}: bucket "${c.bucket}" TTL ${c.raw} = ${c.ttl}s`);

    expect(
      violations,
      `Signed URLs over a private bucket must expire within ${MAX_TTL_SECONDS}s ` +
        "(CLAUDE.md). These exceed it:\n  " +
        violations.join("\n  "),
    ).toEqual([]);
  });

  it("every TTL is a statically checkable value", () => {
    // A computed TTL would slip past the check above without failing it —
    // the guard would still be green while the property went unverified.
    const dynamic = calls
      .filter((c) => c.ttl === null)
      .map((c) => `${c.file}: TTL expression "${c.raw}" could not be resolved`);

    expect(
      dynamic,
      "These TTLs are not statically resolvable, so the 900s cap cannot be " +
        "verified for them. Use a literal or a simple `n * m` constant:\n  " +
        dynamic.join("\n  "),
    ).toEqual([]);
  });
});
