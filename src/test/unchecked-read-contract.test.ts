import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { sourceFiles, SCAN_TIMEOUT_MS } from "@/lib/__tests__/_source-scan";
import { uncheckedReads } from "@/lib/__tests__/_supabase-read-scan";

// US-3260: only optional links and viewer-dependent labels may keep a fallback.
// These are named exceptions, not spare slots for another unchecked money read.
//
// ⚠ 2026-09-18: the two team-reporting entries came OFF this list. Their reason
// was sound as far as it went -- RLS makes that roster viewer-dependent, and a
// member who legitimately cannot see another member is not a failure. What it
// missed is that RLS refusing a row produces NO ERROR AT ALL: PostgREST filters
// it and returns a short set. So anything arriving there as an error was always
// a network or server failure, and it rendered identically to the by-design
// case -- every name reading as the unnamed label. Both reads now log a named
// warning and still return what they got, so the partial answer survives and
// the failure stops being silent.
//
// ⚠ WHAT THIS SCANNER DOES NOT COVER, recorded because two real defects were
// found there the same day. It ignores the session read and the storage
// signed-URL call as non-database reads, which is right for a guard about
// database reads and is not the same as those reads being safe. A discarded
// signing error was dropping photos out of the admin moderation queue with no
// trace, so a moderator judged a flagged submission on whatever subset happened
// to sign; a discarded factor-list error was sending an admin who already had
// an authenticator to the enrol screen. Both are fixed. Neither would have been
// caught here, and widening this scanner to reach them would flag every
// optional Authorization-header read in the app.
//
// The wording above avoids naming those two calls in their code spelling on
// purpose: src/lib/__tests__/signed-url-ttl.test.ts parses every occurrence of
// the signing call and tried to resolve a TTL out of this paragraph. Prose
// about a call reading as the call is the same shape as the dashboard_layouts
// case in US-3256.
const OPTIONAL_READS: Record<string, string> = {
  "src/hooks/use-badge-studio.ts|public_passport_links|{ data: linkRaw }": "An optional passport link can be omitted; the verified certificate remains available.",
  "src/pages/certificate.tsx|public_passport_links|{ data: passportLink }": "An optional passport shortcut does not change the loaded certificate or grade.",
  "src/pages/embed-grade.tsx|submissions|{ data: subData }": "Owner-restricted descriptive metadata can be absent on a public embed; the public grade report is checked separately.",
  "src/pages/embed-grade.tsx|public_passport_links|{ data: passportLink }": "An optional passport shortcut does not change the verified embedded grade.",
  "src/components/flipdesk/grade-this-item-card.tsx|public_passport_links|{ data }": "An optional passport shortcut; grading status and certificate come from checked reads.",
  "src/components/passport/garment-passport-panel.tsx|garments|{ data }": "An optional public share link; the timeline has its own checked read and no ownership decision uses this slug.",
};

describe("unchecked database reads", () => {
  it("detects data aliases, counts, long chains, and parallel reads", () => {
    const code = `
      const { data: rows } = await supabase.from("sales")
        .select("*")${"\n        .eq('user_id', owner)".repeat(12)};
      const { count } = await supabase.from("expenses").select("id", { head: true, count: "exact" });
      const [{ data: item }, { data: listing }] = await Promise.all([
        supabase.from("inventory_items").select("*"),
        supabase.from("listings").select("*")
      ]);
    `;
    expect(uncheckedReads(code).map(r => r.table)).toEqual(["sales", "expenses", "inventory_items", "listings"]);
  });

  it("accepts explicit errors and throwOnError, and ignores comments and non-database reads", () => {
    expect(uncheckedReads(`
      // const { data } = await supabase.from("sales").select("*");
      const { data, error: readError } = await supabase.from("sales").select("*");
      if (readError) throw readError;
      const { data: rows } = await supabase.from("listings").select("*").throwOnError();
      const { data: session } = await supabase.auth.getSession();
      const { data: image } = await supabase.storage.from("photos").createSignedUrl("x", 900);
    `)).toEqual([]);
  });

  it("allows only the six reviewed optional reads; new sites and stale exceptions fail", () => {
    const keys: string[] = [];
    for (const file of sourceFiles(["src"])) {
      if (!/\.tsx?$/.test(file) || /(?:^|[/\\])(?:test|__tests__)(?:[/\\]|$)|\.(?:test|spec)\./.test(file)) continue;
      const name = relative(process.cwd(), file).replace(/\\/g, "/");
      for (const read of uncheckedReads(readFileSync(file, "utf8"), name)) {
        keys.push(`${name}|${read.table}|${read.binding}`);
      }
    }
    expect(keys.sort()).toEqual(Object.keys(OPTIONAL_READS).sort());
  }, SCAN_TIMEOUT_MS);
});
