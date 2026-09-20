import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// US-3403: narrowing the five public buckets' SELECT policies is only safe
// because nothing in the app lists or signs them.
//
// The vault note explains why the PUBLIC READ is unaffected (storage-api
// serves /object/public on a superuser connection, so no policy is consulted).
// What that note cannot promise is that no CLIENT ever calls the two routes
// RLS does gate -- POST /object/list and POST /object/sign. If one did, this
// migration would take a real feature dark, and it would do it quietly,
// because the failure is an empty list rather than an error.
//
// So this checks the claim rather than repeating it. It is a source scan
// because the alternative is a live storage-api, which the env-gated half of
// services/edge-functions/src/tests/storage-anon-list_test.ts already covers.

const ROOT = resolve(__dirname, "../..");

/** The five buckets 00807 scoped. `submission-images` is private and not one. */
const SCOPED_BUCKETS = [
  "item-photos",
  "avatars",
  "cert-assets",
  "content-images",
  "content-videos",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const CLIENT_FILES = walk(resolve(ROOT, "src")).filter((f) => !/\.test\.tsx?$/.test(f));
const EDGE_FILES = walk(resolve(ROOT, "services/edge-functions/src"))
  .filter((f) => !/_test\.ts$/.test(f) && !f.includes("/tests/"));

/** `.from("<bucket>")` followed by `.<verb>(` within the same chain. */
function callsOn(src: string, bucket: string, verb: string): boolean {
  const re = new RegExp(
    `from\\(\\s*["'\`]${bucket}["'\`]\\s*\\)[\\s\\S]{0,400}?\\.${verb}\\(`,
  );
  return re.test(src);
}

describe("scoping the public buckets takes nothing dark (US-3403)", () => {
  it("the scan reaches the real corpus", () => {
    // Fail closed. A walk that stopped matching would report every claim
    // below as satisfied, which is the shape of green this repo keeps
    // catching itself shipping.
    expect(CLIENT_FILES.length).toBeGreaterThan(300);
    expect(EDGE_FILES.length).toBeGreaterThan(100);
    const anyBucket = CLIENT_FILES.some((f) =>
      /from\(\s*["'`]item-photos["'`]\s*\)/.test(readFileSync(f, "utf8"))
    );
    expect(anyBucket, "the scan found no item-photos usage at all").toBe(true);
  });

  it("no browser code lists one of the scoped buckets", () => {
    // `.list()` is the route the SELECT policy gates. The only one in the
    // tree is account-storage-purge.ts, which runs on the service-role
    // client and bypasses RLS entirely.
    const offenders: string[] = [];
    for (const file of CLIENT_FILES) {
      const src = readFileSync(file, "utf8");
      for (const bucket of SCOPED_BUCKETS) {
        if (callsOn(src, bucket, "list")) {
          offenders.push(`${file.slice(ROOT.length + 1)} lists ${bucket}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no browser code signs a URL in one of the scoped buckets", () => {
    // The other RLS-gated route. Every client-side createSignedUrl in the
    // tree targets `submission-images`, which is private and keeps its own
    // owner policy.
    const offenders: string[] = [];
    for (const file of CLIENT_FILES) {
      const src = readFileSync(file, "utf8");
      for (const bucket of SCOPED_BUCKETS) {
        for (const verb of ["createSignedUrl", "createSignedUrls"]) {
          if (callsOn(src, bucket, verb)) {
            offenders.push(`${file.slice(ROOT.length + 1)} signs ${bucket}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the one list() in the tree is on the service-role client", () => {
    // Named rather than counted: if a second appears, this fails and whoever
    // adds it has to say which client it runs on.
    const listers = [...CLIENT_FILES, ...EDGE_FILES].filter((f) =>
      /\.list\(\s*(prefix|["'`])/.test(readFileSync(f, "utf8"))
    ).map((f) => f.slice(ROOT.length + 1));
    expect(listers).toEqual(["services/edge-functions/src/lib/account-storage-purge.ts"]);
  });

  it("the migration says what each bucket was narrowed to", () => {
    // The per-bucket decision is the whole of US-3403, and a migration is
    // immutable, so the reason has to be in it rather than only in a note.
    const sql = readFileSync(
      resolve(ROOT, "supabase/migrations/00807_scope_storage_public_read_policies.sql"),
      "utf8",
    );
    for (const bucket of SCOPED_BUCKETS) {
      expect(sql, `${bucket} is not named in the decision table`).toContain(bucket);
      expect(sql).toContain(`DROP POLICY IF EXISTS "${bucket} public read"`);
    }
    // Self-sufficient: it must not depend on held 00794 having run.
    expect(sql).toMatch(/DROP POLICY IF EXISTS[\s\S]*CREATE POLICY/);
    expect(sql).not.toMatch(/ALTER POLICY/);
  });
});
