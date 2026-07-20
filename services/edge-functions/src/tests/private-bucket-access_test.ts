// US-276 — the private-bucket access rule, enforced instead of merely stated.
//
// CLAUDE.md: "`submission-images` = PRIVATE: read only via `createSignedUrl`
// TTL <= 900s — NEVER `getPublicUrl`." Two obligations, and until now neither
// was checked by anything. The `item-photo-storage_test` source guard covers a
// different rule (never `download` from a hardcoded bucket).
//
// WHY EACH HALF MATTERS, because they fail very differently:
//
//   getPublicUrl on the private bucket — produces a URL that does not resolve
//   while the bucket is private, so it tends to surface as a broken image. The
//   real danger is latent: submission-images holds grading photos INCLUDING
//   LABELS, which CLAUDE.md flags as PII-bearing. If the bucket's visibility is
//   ever changed, every such call silently becomes a live leak.
//
//   TTL above the cap — WORKS PERFECTLY. A 3600s signed URL serves images just
//   as well as a 900s one. Nothing fails, no test goes red, no user complains;
//   the only consequence is that a leaked link stays live four times longer than
//   policy allows. That is the half no runtime test can ever catch, and the
//   reason this file exists.
//
// MEASURED BEFORE WRITING: 0 violations of either half across 1,480 non-test
// source files. This is a ratchet, not a repair.
//
// ── The lesson encoded in resolveTtl ────────────────────────────────────────
// My first pass at measuring this scanned for numeric literals and reported
// "0 violations". That was nearly wrong: almost every call site passes a NAMED
// CONSTANT (SIGNED_URL_TTL, CERT_IMAGE_TTL, EVAL_SIGNED_URL_TTL,
// SIGNED_URL_TTL_SECONDS), none of which a literal-only scan can see. It
// reported a clean result because it was blind, not because the code was clean
// — the exact failure mode of a guard that passes while checking nothing.
// So this resolves single-file `const NAME = <expr>` bindings, and FAILS CLOSED
// on any TTL it cannot evaluate rather than skipping it.

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("../../../../", import.meta.url);
const SCAN_ROOTS = [
  "services/edge-functions/src/",
  "src/",
  "functions/",
];

const MAX_TTL_SECONDS = 900;
const PRIVATE_BUCKET = "submission-images";

async function sourceFiles(dir: URL, acc: URL[] = []): Promise<URL[]> {
  let entries: Deno.DirEntry[] = [];
  try {
    for await (const e of Deno.readDir(dir)) entries.push(e);
  } catch {
    return acc; // a root that does not exist in this checkout
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "tests") continue;
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) await sourceFiles(child, acc);
    else if (
      /\.(ts|tsx)$/.test(entry.name) && !/(_test|\.test)\.(ts|tsx)$/.test(entry.name)
    ) acc.push(child);
  }
  return acc;
}

/**
 * Evaluate a TTL expression: a literal, simple arithmetic (`15 * 60`), or a
 * `const` declared in the same file. Returns null when it cannot be resolved —
 * and callers must treat null as a FAILURE, not as a pass.
 */
export function resolveTtl(expr: string, fileSrc: string): number | null {
  const e = expr.trim();
  if (!e) return null;

  // Literal or simple arithmetic over literals.
  if (/^[\d\s*+/()-]+$/.test(e)) {
    try {
      const v = Function(`"use strict";return (${e});`)() as unknown;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }

  // A bare identifier — look for its const binding in the same file.
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    const decl = new RegExp(`const\\s+${e}\\s*=\\s*([^;\\n]+)`).exec(fileSrc);
    if (!decl) return null;
    // One level of indirection is enough for this codebase; deeper chains
    // return null and fail closed.
    return resolveTtl(decl[1]!, "");
  }
  return null;
}

/** Split a call's argument list at the top level (commas inside parens stay). */
function topLevelArgs(argStr: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", quote: string | null = null;
  for (let i = 0; i < argStr.length; i++) {
    const c = argStr[i]!;
    if (quote) {
      cur += c;
      if (c === quote && argStr[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

Deno.test("US-276: submission-images is never read via getPublicUrl", async () => {
  const offenders: string[] = [];
  let scanned = 0;

  for (const root of SCAN_ROOTS) {
    for (const url of await sourceFiles(new URL(root, REPO_ROOT))) {
      scanned++;
      const src = await Deno.readTextFile(url);
      const re = new RegExp(
        `from\\(\\s*["'\`]${PRIVATE_BUCKET}["'\`]\\s*\\)([\\s\\S]{0,160})`,
        "g",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (/getPublicUrl/.test(m[1]!)) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${url.pathname.split("/GradeThread/").pop()}:${line}`);
        }
      }
    }
  }

  assert(scanned > 500, `expected to scan the source tree, saw ${scanned} files`);
  assertEquals(
    offenders,
    [],
    `submission-images is PRIVATE and holds grading photos including labels ` +
      `(PII-bearing per CLAUDE.md). Read it with createSignedUrl (TTL <= ` +
      `${MAX_TTL_SECONDS}s). getPublicUrl yields a link that does not resolve ` +
      `today and becomes a live leak the moment the bucket's visibility ` +
      `changes:\n` + offenders.join("\n"),
  );
});

Deno.test(`US-276: no signed URL is minted with a TTL above ${MAX_TTL_SECONDS}s`, async () => {
  const offenders: string[] = [];
  let calls = 0;

  for (const root of SCAN_ROOTS) {
    for (const url of await sourceFiles(new URL(root, REPO_ROOT))) {
      const src = await Deno.readTextFile(url);
      const re = /createSignedUrl\s*\(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        calls++;
        const args = topLevelArgs(m[1]!);
        const rel = url.pathname.split("/GradeThread/").pop();
        const line = src.slice(0, m.index).split("\n").length;
        if (args.length < 2) {
          offenders.push(`${rel}:${line} — no explicit TTL argument`);
          continue;
        }
        const ttl = resolveTtl(args[1]!, src);
        if (ttl === null) {
          // FAIL CLOSED. An unresolvable TTL is not evidence of compliance —
          // treating it as one is how the first version of this scan reported
          // a clean tree while seeing none of the named constants.
          offenders.push(
            `${rel}:${line} — TTL \`${args[1]!.trim()}\` could not be resolved; ` +
              `inline it or declare it as a same-file const so this is checkable`,
          );
        } else if (ttl > MAX_TTL_SECONDS) {
          offenders.push(`${rel}:${line} — TTL ${ttl}s exceeds ${MAX_TTL_SECONDS}s`);
        }
      }
    }
  }

  assert(calls > 5, `expected to find createSignedUrl call sites, saw ${calls}`);
  assertEquals(
    offenders,
    [],
    `A signed URL above the cap WORKS — nothing fails, so no other test can ` +
      `catch it. The only consequence is that a leaked link stays live longer ` +
      `than policy allows:\n` + offenders.join("\n"),
  );
});

Deno.test("US-276 guard: resolveTtl handles the forms actually used, and fails closed", () => {
  assertEquals(resolveTtl("900", ""), 900);
  assertEquals(resolveTtl("15 * 60", ""), 900);
  // The form that made a literal-only scan blind.
  assertEquals(resolveTtl("SIGNED_URL_TTL", "const SIGNED_URL_TTL = 15 * 60;"), 900);
  assertEquals(resolveTtl("CERT_IMAGE_TTL", "const CERT_IMAGE_TTL = 3600;"), 3600);
  // Unresolvable → null, which the callers above treat as a failure.
  assertEquals(resolveTtl("someRuntimeValue", ""), null);
  assertEquals(resolveTtl("cfg.ttl", ""), null);
  assertEquals(resolveTtl("", ""), null);
});
