// A8: every Analytics query keys on the tenant (useTenantKey: the active
// workspace owner, or the user), never on user?.id and never on nothing. A key
// on user?.id serves the same cache entry to a member in two workspaces; a key
// with no tenant serves it to anyone who signs in next on the same browser.
// Partitioning must not depend on queryClient.clear() having run.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILES = [
  "src/pages/flipdesk/analytics.tsx",
  "src/pages/flipdesk/listing-performance.tsx",
  "src/pages/flipdesk/community-insights.tsx",
  "src/components/flipdesk/community-insights-widget.tsx",
  "src/components/flipdesk/price-gap-card.tsx",
  "src/components/flipdesk/sourcing-section.tsx",
  "src/components/flipdesk/defect-cost-section.tsx",
  "src/components/flipdesk/price-curve-report.tsx",
  "src/components/flipdesk/seller-scorecard-card.tsx",
  "src/components/flipdesk/return-attribution-section.tsx",
  "src/components/flipdesk/measurement-drift-section.tsx",
  "src/components/flipdesk/inventory-equity-card.tsx",
];

// Each `queryKey: [...]` literal (or call) up to its closing bracket, for the
// queries a file defines.
function keys(src: string): string[] {
  const out: string[] = [];
  const re = /queryKey:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    const start = i;
    let depth = 0;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === "[" || c === "(") depth += 1;
      else if (c === "]" || c === ")") {
        depth -= 1;
        if (depth === 0) break;
      } else if (c === "," && depth === 0) break;
    }
    // A prefix passed to invalidateQueries is a filter, not a cache entry.
    if (!/(invalidate|refetch|cancel|remove)Queries\(\{\s*$/.test(src.slice(m.index - 40, m.index))) {
      out.push(src.slice(start, i + 1));
    }
  }
  return out;
}

describe("analytics query keys carry the tenant (A8)", () => {
  for (const f of FILES) {
    it(f, () => {
      const src = readFileSync(resolve(process.cwd(), f), "utf8");
      const ks = keys(src);
      expect(ks.length).toBeGreaterThan(0);
      for (const k of ks) {
        expect(k).not.toContain("user?.id");
        expect(k).toMatch(/tenantKey|communityBenchmarksKey\(tenantKey/);
      }
    });
  }
});
