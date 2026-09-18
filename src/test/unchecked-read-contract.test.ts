import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { sourceFiles, SCAN_TIMEOUT_MS } from "@/lib/__tests__/_source-scan";
import { uncheckedReads, uncheckedAuthReads } from "@/lib/__tests__/_supabase-read-scan";

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
// ⚠ AUTH READS ARE COVERED TOO, by OPTIONAL_AUTH_READS and its own case below.
// The database scanner ignores them, which is right for a guard about database
// reads and is not the same as those calls being safe: a discarded factor-list
// error was sending an admin who already had an authenticator to the enrol
// screen. MEASURED 2026-09-18: sixteen auth reads drop their error, and fifteen
// are the SAME read -- `getSession` for an optional Authorization header, where
// no session means the request goes anonymous and the server answers 401. That
// is one verdict, so it is written once as a shrink-only COUNT rather than as
// fifteen near-identical entries. Named entries are for the reads that are not
// that shape.
//
// STILL NOT COVERED: the storage signing call. A discarded signing error was
// dropping photos out of the admin moderation queue with no trace, so a
// moderator judged a flagged submission on whatever subset happened to sign.
// That one is fixed; the call is not scanned because it has no shared shape to
// key on, and the wording here avoids its code spelling because
// src/lib/__tests__/signed-url-ttl.test.ts parses every occurrence of it and
// tried to resolve a TTL out of this paragraph. Prose about a call reading as
// the call is the same shape as the dashboard_layouts case in US-3256.
const OPTIONAL_READS: Record<string, string> = {
  "src/hooks/use-badge-studio.ts|public_passport_links|{ data: linkRaw }": "An optional passport link can be omitted; the verified certificate remains available.",
  "src/pages/certificate.tsx|public_passport_links|{ data: passportLink }": "An optional passport shortcut does not change the loaded certificate or grade.",
  "src/pages/embed-grade.tsx|submissions|{ data: subData }": "Owner-restricted descriptive metadata can be absent on a public embed; the public grade report is checked separately.",
  "src/pages/embed-grade.tsx|public_passport_links|{ data: passportLink }": "An optional passport shortcut does not change the verified embedded grade.",
  "src/components/flipdesk/grade-this-item-card.tsx|public_passport_links|{ data }": "An optional passport shortcut; grading status and certificate come from checked reads.",
  "src/components/passport/garment-passport-panel.tsx|garments|{ data }": "An optional public share link; the timeline has its own checked read and no ownership decision uses this slug.",
};

/**
 * Auth reads that are NOT the optional-header shape, named one by one.
 *
 * `getSession` is handled by the count below instead. Everything else is here
 * with its reason, and the list may only shrink.
 */
const OPTIONAL_AUTH_READS: Record<string, string> = {
  "src/components/settings/mfa-card.tsx|mfa.listFactors": "Cleanup of ABANDONED unverified factors before an enrol; the very next line already ends `.catch(() => {})`. A failed read skips the cleanup and the enrol surfaces its own error rather than a wrong answer.",
};

/**
 * How many `getSession` reads drop their error today. Shrink-only.
 *
 * Every one of them builds an optional Authorization header and immediately
 * reads `data.session?.access_token`, so a failed read and a signed-out visitor
 * take the same branch and the server decides. Capping the COUNT keeps the
 * regression protection -- a sixteenth cannot arrive unnoticed -- without
 * fifteen copies of one sentence, which is the form that stops being read.
 */
const OPTIONAL_SESSION_READS = 15;

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

  it("detects an auth read that drops its error, and accepts one that reads it", () => {
    expect(
      uncheckedAuthReads(`
        const { data } = await supabase.auth.getSession();
        const { data: factors } = await supabase.auth.mfa.listFactors();
      `).map((r) => r.call),
    ).toEqual(["getSession", "mfa.listFactors"]);
    expect(
      uncheckedAuthReads(`
        const { data, error } = await supabase.auth.getSession();
        const { data: f, error: e } = await supabase.auth.mfa.listFactors();
      `),
    ).toEqual([]);
  });

  it("allows only the reviewed optional auth reads; new sites and stale exceptions fail", () => {
    const named: string[] = [];
    let sessions = 0;
    for (const file of sourceFiles(["src"])) {
      if (!/\.tsx?$/.test(file) || /(?:^|[/\\])(?:test|__tests__)(?:[/\\]|$)|\.(?:test|spec)\./.test(file)) continue;
      const name = relative(process.cwd(), file).replace(/\\/g, "/");
      for (const read of uncheckedAuthReads(readFileSync(file, "utf8"), name)) {
        if (read.call === "getSession") sessions += 1;
        else named.push(`${name}|${read.call}`);
      }
    }
    expect(
      named.sort(),
      "an auth read that is not the optional-header shape drops its error, or " +
        "a listed one no longer matches. Fix it, or list it with the reason a " +
        "failed read and an absent value mean the same thing there.",
    ).toEqual(Object.keys(OPTIONAL_AUTH_READS).sort());
    expect(
      sessions,
      `${sessions} getSession reads drop their error, baseline ` +
        `${OPTIONAL_SESSION_READS}. Each builds an optional Authorization ` +
        "header and the server decides, so the count is capped rather than " +
        "banned — but it may only fall. Lower the baseline in the same commit.",
    ).toBeLessThanOrEqual(OPTIONAL_SESSION_READS);
  }, SCAN_TIMEOUT_MS);
});
