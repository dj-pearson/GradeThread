import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, sep } from "node:path";

// US-2508. Seven ErrorState retries in the buyer app called
// window.location.reload(). A full reload throws away everything the buyer had
// typed — the alert they were mid-way through describing, the want they were
// composing — and re-runs every query on the page to fix one that failed.
// Every other surface in the product calls the query's own refetch.
//
// This guards the buyer tree specifically because that is where the pattern
// took hold, and because the hooks there (US-2026) exposed isError but not
// refetch, so a consumer wanting to retry had nothing to call. That gap is the
// reason the reload appeared, and it is why the second assertion below checks
// the hooks rather than only the pages.

const BUYER_PAGES = "src/pages/buyer";
const BUYER_HOOKS = [
  "src/hooks/use-saved-searches.ts",
  "src/hooks/use-watchlist.ts",
  "src/hooks/use-buyer-alert-matches.ts",
  "src/hooks/use-buyer-closet.ts",
  "src/hooks/use-buyer-purchases.ts",
  "src/hooks/use-buyer-wants.ts",
];

function buyerPageFiles(): string[] {
  const dir = resolve(process.cwd(), BUYER_PAGES);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__") walk(p);
      } else if (e.name.endsWith(".tsx")) {
        out.push(p.split(sep).join("/"));
      }
    }
  };
  walk(dir);
  return out.map((p) => p.slice(p.indexOf("src/")));
}

describe("buyer retries refetch rather than reloading the page (US-2508)", () => {
  const pages = buyerPageFiles();

  it("found the buyer pages to check", () => {
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.some((p) => p.endsWith("buyer/alerts.tsx"))).toBe(true);
  });

  it("no buyer page retries by reloading the window", () => {
    const offenders = pages.filter((rel) => {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      return /onRetry=\{[^}]*window\.location\.reload/.test(src);
    });
    expect(
      offenders,
      "these retry by reloading the whole page, which discards whatever the " +
        "buyer had typed. Call the query's refetch instead:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the buyer hooks expose a refetch for consumers to call", () => {
    // The root cause, not the symptom: a hook that reports isError without
    // exposing refetch leaves its consumer no honest way to retry.
    const missing = BUYER_HOOKS.filter((rel) => {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      return !/refetch: query\.refetch/.test(src);
    });
    expect(
      missing,
      "these hooks report isError but expose no refetch, so a consumer's " +
        "'Try again' has nothing to call:\n  " + missing.join("\n  "),
    ).toEqual([]);
  });
});
