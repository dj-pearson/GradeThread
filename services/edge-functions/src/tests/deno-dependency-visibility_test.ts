// US-2428 AC6: how the NEXT advisory in an edge dependency gets noticed.
//
// The gap this closes, stated plainly: `npm audit` reads package-lock.json.
// The edge service has no package-lock.json — its dependencies are the import
// map in deno.json. So the framework serving every /api route on
// functions.gradethread.com sat on hono v4.3.7, inside four advisories, for as
// long as it did BECAUSE NOTHING WAS LOOKING. It was found by a human reading
// the file, which is not a mechanism.
//
// What actually closes it is the SPECIFIER FORM, not a scanner:
//
//   https://deno.land/x/hono@v4.3.7/mod.ts   →  an opaque URL. `deno outdated`
//                                               cannot see it, and neither can
//                                               GitHub's dependency graph.
//   jsr:@hono/hono@4.13.1                    →  a registry coordinate. Measured
//                                               2026-08-08: pinning 4.12.0 and
//                                               running `deno outdated` printed
//                                               "jsr:@hono/hono 4.12.0 → 4.13.1".
//
// There is a second, sharper reason hono in particular must never go back to a
// URL pin: hono STOPPED PUBLISHING TO deno.land/x AT v4.3.11 (May 2024).
// cdn.deno.land's versions.json lists 224 versions and 4.3.11 is the newest.
// Every version reachable at that host is inside GHSA-8j4g-w8fx-2239 and
// friends (hono <= 4.12.33). So "bump the deno.land pin" is not a fix that
// exists — a URL pin there is permanently vulnerable by construction.
//
// This test therefore checks the FORM of the pin, which is the property that
// makes tooling able to help, rather than checking a version number that would
// need editing on every release.

import { assert, assertEquals } from "@std/assert";

const DENO_JSON = new URL("../../deno.json", import.meta.url);

interface DenoJson {
  imports: Record<string, string>;
}

async function imports(): Promise<Record<string, string>> {
  const cfg = JSON.parse(await Deno.readTextFile(DENO_JSON)) as DenoJson;
  return cfg.imports;
}

Deno.test("US-2428: no hono specifier is a raw URL pin", async () => {
  const map = await imports();
  const honoKeys = Object.keys(map).filter((k) => k === "hono" || k.startsWith("hono/"));
  // Guard the guard: a rename would otherwise make this pass by finding nothing.
  assert(
    honoKeys.length >= 4,
    `expected the hono import-map entries, found ${JSON.stringify(honoKeys)}`,
  );

  const urlPinned = honoKeys.filter((k) => map[k].startsWith("http"));
  assertEquals(
    urlPinned,
    [],
    `these hono entries are pinned to a URL: ${urlPinned.join(", ")}. ` +
      "deno.land/x stopped receiving hono at v4.3.11, which is inside " +
      "GHSA-8j4g-w8fx-2239 / f23p-vx2j-j53r / 79qm-7rj5-m7r9 / 54fx-42gc-7vw4 " +
      "(hono <= 4.12.33) — so a URL pin cannot be bumped out of the advisory " +
      "range at all. Use jsr:@hono/hono@<version>, which `deno outdated` and " +
      "the dependency graph can both read. (US-2428)",
  );
});

Deno.test("US-2428: every hono entry moves together", async () => {
  const map = await imports();
  const versions = new Set<string>();
  for (const [key, value] of Object.entries(map)) {
    if (key !== "hono" && !key.startsWith("hono/")) continue;
    // jsr:@hono/hono@4.13.1  and  jsr:/@hono/hono@4.13.1/  (prefix form)
    const m = value.match(/@hono\/hono@([^/]+)/);
    assert(m, `${key}: cannot read a version out of ${value}`);
    versions.add(m[1]);
  }
  assertEquals(
    [...versions].length,
    1,
    `the hono import-map entries name more than one version (${
      [...versions].join(", ")
    }). Two copies of the framework would be loaded, and only one of them ` +
      "would be the patched one. (US-2428 AC3)",
  );
});

// The rest of the import map is the SAME blind spot, and pretending otherwise
// would be the more comfortable lie. esm.sh and deno.land URLs are invisible to
// `deno outdated` exactly as the old hono pin was. Migrating them is a separate
// piece of work with its own compatibility risk per package — so they are
// ENUMERATED here rather than silently tolerated, and the list is SHRINK-ONLY:
// moving one to npm:/jsr: fails this test until its entry is deleted, so the
// visibility bought cannot be quietly given back.
const URL_PINNED_DEBT = [
  "@anthropic-ai/sdk",
  "@apple/app-store-server-library",
  "@jsquash/webp",
  "@resvg/resvg-wasm",
  "@std/assert",
  "@supabase/supabase-js",
  "aws4fetch",
  "denomailer",
  "fast-xml-parser",
  "imagescript",
  "qrcode-generator",
  "satori",
  "satori-html",
  "stripe",
  "zod",
];

Deno.test("US-2428: the URL-pinned dependency debt is enumerated and shrink-only", async () => {
  const map = await imports();
  const actual = Object.entries(map)
    .filter(([k]) => k !== "hono" && !k.startsWith("hono/"))
    .filter(([, v]) => v.startsWith("http"))
    .map(([k]) => k)
    .sort();

  const declaredButFixed = URL_PINNED_DEBT.filter((k) => !actual.includes(k));
  assertEquals(
    declaredButFixed,
    [],
    `these are listed as URL-pinned debt but no longer are: ${
      declaredButFixed.join(", ")
    }. Delete them from URL_PINNED_DEBT in the same commit that moves them, ` +
      "or the list stops meaning anything.",
  );

  const undeclared = actual.filter((k) => !URL_PINNED_DEBT.includes(k));
  assertEquals(
    undeclared,
    [],
    `new URL-pinned dependencies: ${undeclared.join(", ")}. A URL pin is ` +
      "invisible to `deno outdated`, to the GitHub dependency graph, and to " +
      "npm audit — which is how the edge's hono sat four advisories deep " +
      "until a human happened to read deno.json. Prefer npm:/jsr:; if the " +
      "package publishes nowhere else, add it to URL_PINNED_DEBT. (US-2428)",
  );
});
