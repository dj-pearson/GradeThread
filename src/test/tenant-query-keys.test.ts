// MP-05 / US-1933: a query that holds one tenant's eBay, queue, sold-sync or
// cross-channel data keys on the tenant.
//
// react-query caches by key. A key like ["ebay_keywords"] serves the previous
// workspace's rows after a switch, and a Cancel or Dismiss on a cached row then
// fires that tenant's ids inside the new one. queryClient.clear() on switch is
// the belt; this is the braces, because a clear that one path forgets (accept
// invite did) leaves nothing else between the two tenants.
//
// The scan reads every useQuery key DEFINITION (not invalidations, which match
// by prefix) under src/hooks and src/components/flipdesk whose first element
// starts with one of the guarded prefixes, and requires a tenant segment in it.
// KNOWN lists the keys that predate this guard or are not tenant data, each
// with its reason. It can only shrink: an entry that stops matching fails too.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src/hooks", "src/components/flipdesk", "src/components/api"];
const PREFIXES = ["ebay_", "extension_queue", "sold_sync", "cross_channel_link", "api-webhook"];
const TENANT = /\b(tenantKey|workspaceOwnerId|activeWorkspaceOwnerId|ownerId)\b/;

const KNOWN: Record<string, string> = {
  // Not tenant data, or keyed on an id that only one tenant can hold.
  ebay_category_conditions: "eBay taxonomy, the same for every seller",
  ebay_category_suggest: "eBay taxonomy, the same for every seller",
  ebay_category_aspects: "eBay taxonomy, the same for every seller",
  ebay_catalog_match: "keyed on one inventory item id",
  ebay_promotion: "keyed on one listing id",
  ebay_order_total: "keyed on one eBay order id",
  ebay_comps: "market comparables for a query, not seller data",
  // Predate MP-05 and are off the Marketplaces page. Migrate, then delete.
  ebay_sync_runs: "keyed on user.id, not the workspace owner",
  ebay_promotable_listings: "keyed on user.id, not the workspace owner",
  ebay_ad_spend: "untenanted; ad spend card",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const INVALIDATE = /(invalidate|cancel|remove|refetch|reset)Queries\(\s*\{\s*$/;

/** Every key definition: its first element's name and the array's text. */
function keyDefinitions(src: string): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const re = /queryKey:\s*\[([\s\S]*?)\]/g;
  for (const m of src.matchAll(re)) {
    const before = src.slice(Math.max(0, m.index! - 60), m.index!);
    if (INVALIDATE.test(before)) continue;
    const first = /^\s*"([^"]+)"/.exec(m[1]!);
    if (!first) continue;
    out.push({ name: first[1]!, text: m[1]! });
  }
  return out;
}

function untenanted(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      for (const def of keyDefinitions(src)) {
        if (!PREFIXES.some((p) => def.name.startsWith(p))) continue;
        if (TENANT.test(def.text)) continue;
        const list = found.get(def.name) ?? [];
        list.push(file);
        found.set(def.name, list);
      }
    }
  }
  return found;
}

describe("tenant-keyed query keys (MP-05)", () => {
  it("every guarded key definition carries a tenant segment, or is named in KNOWN", () => {
    const offenders = [...untenanted().entries()]
      .filter(([name]) => !(name in KNOWN))
      .map(([name, files]) => `${name} (${files.join(", ")})`);
    expect(offenders).toEqual([]);
  });

  it("KNOWN only names keys that are still untenanted (the list can only shrink)", () => {
    const live = untenanted();
    const stale = Object.keys(KNOWN).filter((name) => !live.has(name));
    expect(stale).toEqual([]);
  });

  it("the scan sees a key with the tenant removed", () => {
    const src = `useQuery({ queryKey: ["extension_queue"], queryFn })`;
    const defs = keyDefinitions(src);
    expect(defs).toHaveLength(1);
    expect(TENANT.test(defs[0]!.text)).toBe(false);
    const ok = keyDefinitions(`useQuery({ queryKey: ["extension_queue", tenantKey] })`);
    expect(TENANT.test(ok[0]!.text)).toBe(true);
  });

  it("DEV-10: the webhook panel's keys are scanned and fail without a tenant", () => {
    const src = `useQuery({ queryKey: ["api-webhook"], queryFn })`;
    const defs = keyDefinitions(src).filter((d) => PREFIXES.some((p) => d.name.startsWith(p)));
    expect(defs).toHaveLength(1);
    expect(TENANT.test(defs[0]!.text)).toBe(false);
    const live = readFileSync("src/components/api/webhook-panel.tsx", "utf8");
    const liveDefs = keyDefinitions(live).filter((d) => d.name.startsWith("api-webhook"));
    expect(liveDefs.length).toBeGreaterThanOrEqual(2);
    for (const d of liveDefs) expect(TENANT.test(d.text), d.text).toBe(true);
  });

  it("the scan skips invalidations, which match by prefix", () => {
    const src = `qc.invalidateQueries({ queryKey: ["extension_queue"] });`;
    expect(keyDefinitions(src)).toEqual([]);
  });
});
