import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2518. The CSV inventory import ran as a loop in the browser, under a banner
// that read "Don't close this tab", matched existing items by SKU and wrote to
// them with no way back. A closed laptop left the catalog half-imported with no
// record of what had landed, and a wrong column mapping was permanent.
//
// The rows now go to a durable server run (durable-jobs contract) that records
// one effect row per change, which is what makes Undo possible. These assert the
// properties that make that true, on both sides.

const PAGE = "src/pages/flipdesk/import.tsx";
const ROUTE = "services/edge-functions/src/routes/flipdesk-import.ts";
const LIB = "services/edge-functions/src/lib/inventory-import.ts";
const MAIN = "services/edge-functions/src/main.ts";
const CRONS = "services/edge-functions/src/lib/cron-runs.ts";
const MIGRATION = "supabase/migrations/00592_flipdesk_import_runs.sql";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("the import no longer runs in the browser (US-2518)", () => {
  it("the page does not tell the seller to keep the tab open", () => {
    const src = read(PAGE);
    expect(src).not.toMatch(/Don't close this tab/i);
    expect(src).toContain("You can close this tab");
  });

  it("the page posts the rows and polls, instead of writing them itself", () => {
    const src = read(PAGE);
    expect(src).toMatch(/edgeFetch\("\/api\/flipdesk\/import\/runs"/);
    expect(src).toMatch(/\/api\/flipdesk\/import\/runs\/\$\{id\}/);
    // The old loop wrote inventory straight from the browser. Nothing on this
    // page may insert or update a catalog table any more.
    for (const table of ["inventory_items", "listings", "sales"]) {
      expect(src, `${PAGE} still writes ${table} from the browser`).not.toContain(
        `.from("${table}")`,
      );
    }
  });

  it("progress uses the shared Progress component", () => {
    const src = read(PAGE);
    expect(src).toMatch(/from "@\/components\/ui\/progress"/);
    expect(src).toMatch(/<Progress\s/);
    // The hand-rolled bar is gone.
    expect(src).not.toMatch(/h-full bg-brand-navy transition-all/);
  });

  it("a CSV template is offered next to the upload control", () => {
    const src = read(PAGE);
    expect(src).toContain("Download the CSV template");
    expect(src).toMatch(/a\.download = "gradethread-inventory-template\.csv"/);
    // The template's headers have to be ones guessField() recognises, or it
    // hands the seller a file that maps to nothing.
    const mapping = read("src/lib/import-mapping.ts");
    for (const header of ["Item Title", "Brand", "Purchase Price", "Status"]) {
      const key = header.toLowerCase().replace(/[^a-z0-9]/g, "");
      expect(mapping, `guessField does not know "${header}"`).toContain(`${key}:`);
    }
  });
});

describe("the import worker follows the durable-jobs contract (US-2518)", () => {
  it("claims a run atomically and never swallows the claim error", () => {
    const src = read(ROUTE);
    expect(src).toMatch(/\.eq\("status", "pending"\)/);
    expect(src).toMatch(/claim failed/);
  });

  it("heartbeats while it works, so a live run never looks stale", () => {
    const src = read(ROUTE);
    expect(src).toMatch(/processed_rows: processed/);
    const lib = read(LIB);
    // The stale window must be well above the per-row work.
    expect(lib).toMatch(/RUN_STALE_MS = 6 \* 60 \* 1000/);
  });

  it("caps attempts so a reclaim loop cannot run for ever", () => {
    const route = read(ROUTE);
    const lib = read(LIB);
    expect(lib).toMatch(/MAX_RUN_ATTEMPTS = 5/);
    expect(route).toMatch(/attempts > MAX_RUN_ATTEMPTS/);
    expect(route).toMatch(/attempts \?\? 0\) >= MAX_RUN_ATTEMPTS/);
  });

  it("a resumed run does not re-import the rows that already landed", () => {
    const src = read(ROUTE);
    // The effect rows are the resume marker — the only durable record of what
    // landed. Without this a reclaim would duplicate the catalog.
    expect(src).toMatch(/alreadyDone/);
    expect(src).toMatch(/alreadyDone\.has\(rowNumber\)/);
  });

  it("the reclaim cron is job-secret gated, locked, and registered", () => {
    const route = read(ROUTE);
    expect(route).toMatch(/requireJobSecret\(c\)/);
    expect(route).toMatch(/acquireJobLock\("flipdesk-import-reclaim"/);
    // Code with no scheduled task is a queue that never self-heals.
    expect(read(MAIN)).toContain("/api/jobs/flipdesk-import-reclaim");
    expect(read(CRONS)).toContain('name: "flipdesk-import-reclaim"');
  });

  it("every query in the route is tenant-scoped (US-268)", () => {
    const src = read(ROUTE);
    // The service-role client bypasses RLS, so the owner filter is the only
    // thing standing between two sellers' catalogs.
    const reads = src.match(/\.from\("flipdesk_import_(runs|effects)"\)/g) ?? [];
    expect(reads.length).toBeGreaterThan(3);
    expect(src).toMatch(/c\.get\("workspaceOwnerId"\) \?\? c\.get\("userId"\)/);
    // Nothing may take the tenant from the request body.
    expect(src).not.toMatch(/body\.user_id|body\.owner/);
  });
});

describe("an import is reversible (US-2518)", () => {
  it("records one effect row per change, with the prior values", () => {
    const src = read(ROUTE);
    expect(src).toMatch(/action: "inserted"/);
    expect(src).toMatch(/action: "filled"/);
    // Without `previous`, an undo of a fill would blank the column instead of
    // restoring what was there.
    expect(src).toMatch(/previous\[key\] = prior\[key\] \?\? null/);
  });

  it("undo restores filled columns and deletes only what it created", () => {
    const src = read(ROUTE);
    expect(src).toMatch(/export async function undoImportRun/);
    expect(src).toMatch(/\.from\("inventory_items"\)\s*\n\s*\.delete\(\)/);
    expect(src).toMatch(/\.eq\("user_id", ownerId\)/);
  });

  it("undo leaves an item that has since been published alone", () => {
    const src = read(ROUTE);
    // Deleting an item under a live marketplace listing would strand it.
    expect(src).toMatch(/\.not\("platform_listing_id", "is", null\)/);
    expect(src).toMatch(/keptPublished\+\+/);
  });

  it("undo refuses a run that is still going", () => {
    const src = read(ROUTE);
    expect(src).toMatch(/Wait for the import to finish first/);
    expect(src).toMatch(/already undone/);
  });

  it("the page offers the undo and says what it will do", () => {
    const src = read(PAGE);
    expect(src).toContain("Undo this import");
    expect(src).toMatch(/\/undo/);
    // Wrapped across lines in the JSX, so match the clause that survives it.
    expect(src).toMatch(/already published to a[\s\n]+marketplace is left alone/);
  });
});

describe("the migration carries the US-1108 triple (US-2518)", () => {
  it("is idempotent, RLS-enabled and self-recording", () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.flipdesk_import_runs/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.flipdesk_import_effects/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS/);
    expect(sql).toMatch(
      /insert into public\.applied_migrations \(version\) values \('00592'\)/,
    );
  });

  it("the schema version was bumped in the same commit", () => {
    const version = read("services/edge-functions/src/lib/schema-version.ts");
    expect(version).toMatch(/EXPECTED_SCHEMA_VERSION = "00592"/);
  });
});
