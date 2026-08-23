import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2808: the RN/CA resolve queue had a complete server and no client.
//
// US-2244 built the router — a most-sighted-first queue, an include_resolved
// filter, an upsert that also flags the sighting resolved and drops the
// five-minute cross-check cache — and nothing on web, iOS or Android ever
// called it. Same shape as US-2802 and US-2809: server-built, client-absent,
// and nothing about the server half looks unused.
//
// AC1 asked whether the surface is wanted BEFORE building it, and the answer is
// in the pipeline rather than in an opinion. grading-pipeline.ts already calls
// recordRegisteredNumberSighting for every tag it reads, so the queue has been
// filling on live traffic with nowhere to be seen. That is asserted below,
// because it is the whole justification: if the recorder is ever unwired, this
// page becomes the speculative surface AC1 warned against, and someone should
// have to notice.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n?/g, "\n");

/**
 * Comments removed. A guard that reads the prose written about the code is not
 * checking the code.
 *
 * DEFENSIVE HERE, NOT LOAD-BEARING, and worth saying so rather than letting it
 * look proven: sabotage removing this filter leaves every case below green,
 * because no comment in these files currently contains a string an assertion
 * looks for. It is kept because the cost is three lines and the failure it
 * prevents is silent — in public-changelog-page.test.ts the same filter IS
 * load-bearing, where a comment reading "WHY THIS PASSES audience=all"
 * satisfied the check for the parameter after the parameter was deleted.
 */
const code = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

/**
 * Comments AND import lines removed, for the "is this actually called" checks.
 *
 * ⚠ AN IMPORT IS NOT A CALL, and the first draft could not tell the difference.
 * Replacing the real `recordRegisteredNumberSighting(...)` call in the grading
 * pipeline with a no-op left this suite green, because the import at the top of
 * that file still carried the name. The assertion said "the pipeline mentions
 * this function", which is true of a file that imports it and never uses it —
 * which is precisely the state that would leave this page with no input.
 */
const calls = (src: string) => {
  const lines = code(src).split("\n");
  const out: string[] = [];
  let inImport = false;
  for (const line of lines) {
    const t = line.trim();
    if (inImport) {
      if (/^\}?\s*from\s+["']/.test(t) || t.endsWith('";') || t.endsWith("';")) inImport = false;
      continue;
    }
    if (/^import\b/.test(t)) {
      if (!/from\s+["'][^"']+["']\s*;?$/.test(t)) inImport = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
};

const PAGE = "src/pages/admin/registered-numbers.tsx";
const HOOK = "src/hooks/use-registered-numbers.ts";
const ROUTES = "src/routes/admin-routes.tsx";
const NAV = "src/layouts/admin-layout.tsx";
const PIPELINE = "services/edge-functions/src/lib/grading-pipeline.ts";
const EDGE_ROUTE = "services/edge-functions/src/routes/admin-registered-numbers.ts";

describe("US-2808: the registered-numbers queue has a client", () => {
  it("the page is routed and reachable from the admin nav", () => {
    const routes = code(read(ROUTES));
    expect(routes).toContain('path="registered-numbers"');
    expect(routes).toContain("AdminRegisteredNumbersPage");

    // Routed but not linked is only half-built: an admin has no way to find it,
    // which is indistinguishable from the state this story was filed about.
    expect(
      code(read(NAV)),
      "the page is routed but absent from adminNavItems, so nothing links to it",
    ).toContain('to: "/admin/registered-numbers"');
  });

  it("the hook calls the real endpoint, both verbs", () => {
    const hook = code(read(HOOK));
    expect(hook).toContain("/api/admin/registered-numbers");
    expect(hook, "nothing POSTs, so a number can be read but never resolved").toContain(
      'method: "POST"',
    );
  });

  it("include_resolved is part of the query key, not a post-fetch filter", () => {
    // The server decides what the queue CONTAINS. Caching one response under
    // both meanings would show the resolved-inclusive list as the open queue,
    // which reads as "the queue is full of already-done work".
    const hook = code(read(HOOK));
    expect(hook).toContain("include_resolved=true");
    expect(
      /queryKey:\s*\[QUEUE_KEY,\s*\{\s*includeResolved\s*\}\]/.test(hook),
      "includeResolved is no longer part of the react-query key",
    ).toBe(true);
  });

  it("resolving invalidates the queue so the row leaves it", () => {
    // The POST flags the sighting resolved server-side. Without an
    // invalidation the row sits there looking unresolved until a reload, and an
    // operator working down the list resolves it twice.
    expect(code(read(HOOK))).toContain("invalidateQueries");
  });
});

describe("US-2808: the queue this page serves is actually fed", () => {
  it("grading records a sighting for every tag it reads", () => {
    // AC1's justification, asserted rather than asserted-in-prose. If this ever
    // stops being true the page has no input, and the honest move becomes AC3
    // (remove it) rather than leaving a screen that is always empty.
    const pipeline = calls(read(PIPELINE));
    expect(
      /\brecordRegisteredNumberSighting\s*\(/.test(pipeline),
      "the grading pipeline no longer CALLS recordRegisteredNumberSighting. The " +
        "queue this page serves has no input, and the page is now the speculative " +
        "surface AC1 warned about. Either restore the call or take AC3 and remove " +
        "the page and its route together.",
    ).toBe(true);
    expect(
      /\bassessRegisteredNumber\s*\(/.test(pipeline),
      "nothing parses the number off the tag any more, so no sighting can be recorded",
    ).toBe(true);
  });

  it("the edge route still exposes what the page reads", () => {
    // The page renders sightings joined to registry rows by registry_key. A
    // response shape change would leave the table silently empty rather than
    // erroring, because both are optional-chained into empty arrays.
    const route = code(read(EDGE_ROUTE));
    expect(route).toContain("sightings:");
    expect(route).toContain("registry:");
    expect(route).toContain("registry_key");
    expect(route, "the most-sighted-first ordering is what makes the work finite").toContain(
      'order("sighting_count", { ascending: false })',
    );
  });

  it("the router still guards on admin scope", () => {
    // Nothing here is tenant-scoped by design (both tables are aggregate
    // reference data with no owner column), so the scope check IS the
    // authorization boundary. Losing it exposes an operator write surface.
    expect(code(read(EDGE_ROUTE))).toContain('requireScope("content:publish")');
  });
});

describe("US-2808: the page does not invent a shape the server rejects", () => {
  it("blocks a submit with neither a company nor a brand", () => {
    // The server 400s on an empty row because it records nothing. The page says
    // so before sending, so the operator gets a reason rather than a red toast.
    const page = code(read(PAGE));
    expect(page).toContain("canSubmit");
    expect(
      /company_name\.trim\(\)\.length > 0/.test(page),
      "the empty-row guard no longer checks the company name",
    ).toBe(true);
  });

  it("sends brand_keys as an array, not the comma string the operator typed", () => {
    // ⚠ THE FIRST DRAFT OF THIS CASE WAS BLIND. It asserted two loose facts —
    // that "brand_keys" appears and that "split(\",\")" appears somewhere —
    // and both stayed true when the real conversion was replaced with
    // `[draft.brand_keys]`, because canSubmit splits the same field a few
    // lines below. Assert the CHAIN that actually builds the payload.
    const page = code(read(PAGE));
    const chain = /brandKeys\s*=\s*draft\.brand_keys[\s\S]{0,160}?\.split\(","\)[\s\S]{0,160}?\.filter\(Boolean\)/;
    expect(
      chain.test(page),
      "brand_keys is no longer split into a trimmed array. The server filters the " +
        "payload for strings and would happily store one long fake brand key like " +
        '"levis, dockers" as a single brand.',
    ).toBe(true);
    expect(page).toContain("brand_keys: brandKeys");
  });
});
