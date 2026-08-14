import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, sep } from "node:path";

// US-2512. The admin sidebar carries 81 destinations. Two of them rendered the
// SAME page title — /admin/system and /admin/ops/health both said "System
// Health" — so the heading could not tell an operator which page they were on,
// during exactly the kind of incident where you are moving fast between them.
// They answer different questions: the product (grading throughput, users,
// storage, plan mix) versus the infrastructure beneath it (DB, queues, DLQ, job
// failures). Now "Platform Health" and "Infrastructure Health".
//
// This guards the whole class, not the one pair: no two admin pages may render
// the same PageHeader title, and no two sidebar entries may carry the same
// label. A duplicate name is how a 81-entry nav becomes unnavigable.

const ADMIN_PAGES = "src/pages/admin";
const LAYOUT = "src/layouts/admin-layout.tsx";

function adminPageFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__") walk(p);
      } else if (e.name.endsWith(".tsx")) out.push(p.split(sep).join("/"));
    }
  };
  walk(resolve(process.cwd(), ADMIN_PAGES));
  return out.map((p) => p.slice(p.indexOf("src/")));
}

/** The literal `title="…"` a page hands to PageHeader, if any. */
function pageHeaderTitle(rel: string): string | null {
  const src = readFileSync(resolve(process.cwd(), rel), "utf8");
  const at = src.indexOf("<PageHeader");
  if (at === -1) return null;
  // Look only inside this element, so a later card's title can't be mistaken
  // for the page's.
  const chunk = src.slice(at, at + 900);
  const m = chunk.match(/\btitle="([^"]+)"/);
  return m ? m[1]! : null;
}

function duplicates(values: string[]): string[] {
  const seen = new Map<string, number>();
  for (const v of values) seen.set(v, (seen.get(v) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([v, n]) => `${v} (${n}×)`);
}

describe("admin destinations are distinguishable by name (US-2512)", () => {
  it("no two admin pages render the same PageHeader title", () => {
    const titled = adminPageFiles()
      .map((rel) => [rel, pageHeaderTitle(rel)] as const)
      .filter((p): p is readonly [string, string] => p[1] !== null);

    // Guard the guard.
    expect(titled.length).toBeGreaterThan(30);

    const dupes = duplicates(titled.map(([, t]) => t));
    expect(
      dupes,
      "these page titles are used by more than one admin page, so the heading " +
        "cannot tell an operator which page they are on:\n  " + dupes.join("\n  "),
    ).toEqual([]);
  });

  it("no two sidebar entries carry the same label", () => {
    const src = readFileSync(resolve(process.cwd(), LAYOUT), "utf8");
    const labels = [...src.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]!);
    expect(labels.length).toBeGreaterThan(50);

    const dupes = duplicates(labels);
    expect(
      dupes,
      "duplicate sidebar labels:\n  " + dupes.join("\n  "),
    ).toEqual([]);
  });
});
