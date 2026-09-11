// US-3365: the three writes that named a PARTIAL unique index actually LAND.
//
// What shipped was not a missing write. All three were there, all three were
// checked, and all three failed on every call:
//
//   POST /rest/v1/grade_outcomes?on_conflict=buyer_purchase_id
//   POST /rest/v1/grade_outcomes?on_conflict=grade_report_id,sale_id
//   POST /rest/v1/changelog_entries?on_conflict=source_ref
//   HTTP 400
//   {"code":"42P10","message":"there is no unique or exclusion constraint
//     matching the ON CONFLICT specification"}
//
// Postgres refuses a partial index as an ON CONFLICT target unless the statement
// repeats the predicate, and PostgREST cannot send one. A control upsert naming
// the NON-partial primary key on each of the same two tables got past the
// planner in the same session, so it is the predicate and not the table.
//
// THE LESSON THIS FILE ENCODES, same as US-3364's: a test that asserts the
// upsert was CALLED with the right string is green while the database rejects
// every call. So each case here reads the row back out of a real Postgres.
//
// Watch the second trap too. With the dedupe broken, the ROW COUNT can still be
// right, because the partial index catches the duplicate at the database. A
// count assertion alone is therefore green against a broken write path, which is
// why every dedupe case below also asserts that nothing raced.
//
// Run against the throwaway local stack:
//
//   supabase db start
//   docker start supabase_rest_gradethread supabase_kong_gradethread
//   TEST_SUPABASE_URL=http://127.0.0.1:54321 \
//   TEST_SUPABASE_SERVICE_ROLE_KEY=<local service key> \
//   deno test --allow-net --allow-env --allow-read src/tests/grade-outcome-lands_test.ts
//
// (If another project holds 54321, put an nginx container on
// supabase_network_gradethread that proxies /rest/v1/ to
// supabase_rest_gradethread:3000 and point TEST_SUPABASE_URL at that instead.)

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireIntegrationFixtures } from "./integration-required.ts";
import { resetSupabaseAdminForTests } from "../lib/supabase.ts";
import { recordBuyerGradeOutcome } from "../lib/buyer-grade-confirmation.ts";
import { recordSnadOutcomesToDb, SNAD_OUTCOME_SOURCE } from "../lib/grade-snad-signal.ts";
import { autoCaptureChangelogDrafts } from "../lib/changelog-job.ts";

const URL_ENV = Deno.env.get("TEST_SUPABASE_URL");
const KEY = Deno.env.get("TEST_SUPABASE_SERVICE_ROLE_KEY");
const CONFIGURED = Boolean(URL_ENV && KEY);

const RUN = requireIntegrationFixtures(
  "grade-outcome-lands",
  ["TEST_SUPABASE_URL", "TEST_SUPABASE_SERVICE_ROLE_KEY"],
  CONFIGURED,
);

/** A marker nothing else uses, so every cleanup below is exact. */
const TAG = "us3365";

function db(): SupabaseClient {
  return createClient(URL_ENV!, KEY!, { auth: { persistSession: false } });
}

/** Point the LIBRARY's own service-role client at this database.
 *
 *  The client is memoized on first use, so setting the env and dropping the memo
 *  is enough -- and it means the code under test is the shipped code rather than
 *  a copy of it that takes a client parameter. */
function useTestDatabase(): void {
  Deno.env.set("SUPABASE_URL", URL_ENV!);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", KEY!);
  resetSupabaseAdminForTests();
}

function restoreEnv(): void {
  Deno.env.set("SUPABASE_URL", "http://localhost:54321");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
  resetSupabaseAdminForTests();
}

/**
 * Capture console.warn so a case can assert NOTHING RACED.
 *
 * The race counter is the only signal that separates "the dedupe read worked"
 * from "the dedupe read did nothing and the unique index cleaned up after it".
 * All three fixes announce a race on console.warn rather than swallowing it, for
 * exactly this reason, so the assertion is available without changing a return
 * type that production code depends on.
 */
function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  return { lines, restore: () => { console.warn = original; } };
}

function assertNothingRaced(lines: string[], what: string): void {
  const raced = lines.filter((l) => l.includes("lost a race"));
  assertEquals(
    raced,
    [],
    `${what} fell through to the unique index instead of recognising the row it ` +
      `had already written. The row COUNT is still correct, because the index ` +
      `catches the duplicate -- which is exactly why the race has to be asserted ` +
      `rather than inferred from a count.`,
  );
}

/** A grade report to hang outcomes on. grade_outcomes.grade_report_id is a NOT
 *  NULL FK, so a made-up uuid fails for a reason that has nothing to do with
 *  this story. */
async function anyGradeReport(c: SupabaseClient): Promise<string> {
  const { data, error } = await c.from("grade_reports").select("id").limit(1).maybeSingle();
  assertEquals(error, null);
  assert(data, "this database has no grade_reports row, so no outcome can be written against it");
  return (data as { id: string }).id;
}

async function anyUser(c: SupabaseClient): Promise<string> {
  const { data, error } = await c.from("users").select("id").limit(1).maybeSingle();
  assertEquals(error, null);
  assert(data, "this database has no users row");
  return (data as { id: string }).id;
}

// ── 1. the buyer verdict (the one that THREW) ──────────────────────────────

Deno.test({
  name: "US-3365: a buyer confirm/dispute outcome LANDS, and a re-submit updates one row",
  ignore: !RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    useTestDatabase();
    const c = db();
    const reportId = await anyGradeReport(c);
    const userId = await anyUser(c);
    const certificateId = `${TAG}-cert-${crypto.randomUUID()}`;

    const clean = async () => {
      const { data } = await c.from("buyer_purchases").select("id")
        .eq("certificate_id", certificateId);
      for (const p of (data ?? []) as Array<{ id: string }>) {
        await c.from("grade_outcomes").delete().eq("buyer_purchase_id", p.id);
        await c.from("buyer_purchases").delete().eq("id", p.id);
      }
    };
    await clean();

    const { data: created, error: purchaseErr } = await c
      .from("buyer_purchases")
      .insert({
        user_id: userId,
        grade_report_id: reportId,
        certificate_id: certificateId,
        title: `${TAG} fixture purchase`,
      })
      .select("id")
      .single();
    assertEquals(purchaseErr, null, "could not create the buyer_purchases fixture row");
    const purchaseId = (created as { id: string }).id;

    const countOutcomes = async (): Promise<number> => {
      const { data, error } = await c.from("grade_outcomes").select("id")
        .eq("buyer_purchase_id", purchaseId);
      assertEquals(error, null);
      return (data ?? []).length;
    };

    const warn = captureWarnings();
    try {
      // The shape that shipped, proved still broken on THIS database. Without
      // this the test could go green because the schema changed rather than
      // because the code did.
      const { error: oldShape } = await c.from("grade_outcomes").upsert(
        {
          grade_report_id: reportId,
          buyer_user_id: userId,
          buyer_purchase_id: purchaseId,
          match_status: "disputed",
          source: "buyer_arrival",
        },
        { onConflict: "buyer_purchase_id" },
      );
      assert(oldShape, "the old upsert succeeded, so this is not the database the story is about");
      assertEquals(
        oldShape.code,
        "42P10",
        `expected 42P10 from the partial-index conflict target, got ${oldShape.code}: ${oldShape.message}`,
      );
      assertEquals(await countOutcomes(), 0, "a 42P10 statement must write nothing");

      // ── verdict 1 ──
      // Disputed with a reason and no structured issues: overall_delta 0, so the
      // severity is cosmetic and the human-review / reward fan-out stays out of
      // the way. This case is about the WRITE.
      const first = await recordBuyerGradeOutcome({
        userId,
        purchase: { id: purchaseId, grade_report_id: reportId },
        verdict: { matchStatus: "disputed", disputeReason: "first verdict", issues: [] },
      });
      assertEquals(first.matchStatus, "disputed");
      assertEquals(
        await countOutcomes(),
        1,
        "the buyer's verdict did not land. This is the write that used to throw, " +
          "which the route turns into a 500 for the buyer",
      );

      // ── verdict 2, the buyer changes their mind ──
      await recordBuyerGradeOutcome({
        userId,
        purchase: { id: purchaseId, grade_report_id: reportId },
        verdict: { matchStatus: "confirmed", disputeReason: null, issues: [] },
      });
      assertEquals(
        await countOutcomes(),
        1,
        "a re-submitted verdict created a SECOND outcome row for one purchase",
      );
      const { data: row } = await c.from("grade_outcomes")
        .select("match_status, dispute_reason")
        .eq("buyer_purchase_id", purchaseId).maybeSingle();
      assertEquals(
        (row as { match_status: string } | null)?.match_status,
        "confirmed",
        "the row still carries the FIRST verdict; the update leg did not run",
      );
      assertEquals((row as { dispute_reason: string | null } | null)?.dispute_reason, null);
      assertNothingRaced(warn.lines, "the buyer verdict re-submit");
    } finally {
      warn.restore();
      await clean();
      restoreEnv();
    }
  },
});

// ── 2. the SNAD sweep (logs and continues, so it looked healthy) ───────────

Deno.test({
  name: "US-3365: a SNAD observation LANDS, and a second sweep records no duplicate",
  ignore: !RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    useTestDatabase();
    const c = db();
    const reportId = await anyGradeReport(c);
    const userId = await anyUser(c);
    const itemTitle = `${TAG} fixture item ${crypto.randomUUID()}`;

    const warn = captureWarnings();
    let itemId = "";
    let saleId = "";
    const clean = async () => {
      if (saleId) await c.from("grade_outcomes").delete().eq("sale_id", saleId);
      if (itemId) {
        await c.from("grade_outcomes").delete()
          .eq("inventory_item_id", itemId).eq("source", SNAD_OUTCOME_SOURCE);
        await c.from("sales").delete().eq("inventory_item_id", itemId);
        await c.from("inventory_items").delete().eq("id", itemId);
      }
    };

    try {
      const { data: item, error: itemErr } = await c.from("inventory_items")
        .insert({ user_id: userId, title: itemTitle }).select("id").single();
      assertEquals(itemErr, null, "could not create the inventory_items fixture row");
      itemId = (item as { id: string }).id;

      const { data: sale, error: saleErr } = await c.from("sales")
        .insert({ user_id: userId, inventory_item_id: itemId, sale_price: 42 })
        .select("id").single();
      assertEquals(saleErr, null, "could not create the sales fixture row");
      saleId = (sale as { id: string }).id;

      const countSnad = async (sale: string | null): Promise<number> => {
        let q = c.from("grade_outcomes").select("id")
          .eq("grade_report_id", reportId).eq("source", SNAD_OUTCOME_SOURCE);
        q = sale === null ? q.is("sale_id", null) : q.eq("sale_id", sale);
        const { data, error } = await q;
        assertEquals(error, null);
        return (data ?? []).length;
      };

      // The shape that shipped, still broken on THIS database.
      const { error: oldShape } = await c.from("grade_outcomes").upsert(
        [{
          grade_report_id: reportId,
          inventory_item_id: itemId,
          sale_id: saleId,
          dispute_reported: true,
          source: SNAD_OUTCOME_SOURCE,
        }],
        { onConflict: "grade_report_id,sale_id", ignoreDuplicates: true },
      );
      assert(oldShape, "the old upsert succeeded, so this is not the database the story is about");
      assertEquals(
        oldShape.code,
        "42P10",
        `expected 42P10, got ${oldShape.code}: ${oldShape.message}`,
      );
      assertEquals(await countSnad(saleId), 0, "a 42P10 statement must write nothing");

      // ── sweep 1: one linked case and one case with no sale ──
      const rows = [
        { gradeReportId: reportId, inventoryItemId: itemId, saleId },
        { gradeReportId: reportId, inventoryItemId: itemId, saleId: null },
      ];
      assertEquals(
        await recordSnadOutcomesToDb(rows),
        2,
        "the sweep reported writing no observations; the dispute rate this feeds saw nothing",
      );
      assertEquals(await countSnad(saleId), 1, "the sale-linked observation did not land");
      assertEquals(await countSnad(null), 1, "the unlinked observation did not land");

      // ── sweep 2, fifteen minutes later, same two cases ──
      assertEquals(
        await recordSnadOutcomesToDb(rows),
        0,
        "the second sweep wrote again. A sweep every 15 minutes would manufacture " +
          "a dispute rate out of one return",
      );
      assertEquals(
        await countSnad(saleId),
        1,
        "two rows for one returned item. Note the row count alone is NOT the " +
          "proof here -- the partial index would have held this at 1 even with " +
          "the dedupe broken, which is why the insert count above is asserted too",
      );
      // The unlinked case is the one the index CANNOT hold: sale_id IS NULL is
      // outside the predicate and two NULLs never conflict in Postgres. Only the
      // read-based dedupe stops it.
      assertEquals(
        await countSnad(null),
        1,
        "the unlinked case duplicated. The index does not cover a NULL sale_id, " +
          "so this row count is a real assertion and not the index doing the work",
      );
      assertNothingRaced(warn.lines, "the second SNAD sweep");
    } finally {
      warn.restore();
      await clean();
      restoreEnv();
    }
  },
});

// ── 3. the changelog auto-capture (logs and continues) ────────────────────

Deno.test({
  name: "US-3365: an auto-captured changelog draft LANDS, and a re-run adds none",
  ignore: !RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    useTestDatabase();
    const c = db();
    const signalId = crypto.randomUUID();
    const sourceRef = `blog:${signalId}`;

    const clean = async () => {
      await c.from("changelog_entries").delete().eq("source_ref", sourceRef);
      await c.from("content_history_index").delete().eq("id", signalId);
    };
    await clean();

    const countDrafts = async (): Promise<number> => {
      const { data, error } = await c.from("changelog_entries").select("id")
        .eq("source_ref", sourceRef);
      assertEquals(error, null);
      return (data ?? []).length;
    };

    const warn = captureWarnings();
    try {
      const { error: sigErr } = await c.from("content_history_index").insert({
        id: signalId,
        surface: "blog",
        product_focus: "both",
        title: `${TAG} fixture post`,
        summary_one_line: "a fixture post for US-3365",
        published_at: new Date().toISOString(),
      });
      assertEquals(sigErr, null, "could not create the content_history_index fixture row");

      // The shape that shipped, still broken on THIS database.
      const { error: oldShape } = await c.from("changelog_entries").upsert(
        [{ title: `${TAG} old shape`, source: "auto", status: "draft", source_ref: sourceRef }],
        { onConflict: "source_ref", ignoreDuplicates: true },
      );
      assert(oldShape, "the old upsert succeeded, so this is not the database the story is about");
      assertEquals(
        oldShape.code,
        "42P10",
        `expected 42P10, got ${oldShape.code}: ${oldShape.message}`,
      );
      assertEquals(await countDrafts(), 0, "a 42P10 statement must write nothing");

      // ── run 1 ──
      const first = await autoCaptureChangelogDrafts(Date.now());
      assert(first >= 1, "auto-capture reported creating no drafts at all");
      assertEquals(await countDrafts(), 1, "the auto-captured draft did not land");

      // ── run 2, the next day, same blog post ──
      const before = await countDrafts();
      await autoCaptureChangelogDrafts(Date.now());
      assertEquals(
        await countDrafts(),
        before,
        "a re-run duplicated the draft for one blog post",
      );
      assertNothingRaced(warn.lines, "the changelog auto-capture re-run");
    } finally {
      warn.restore();
      await clean();
      restoreEnv();
    }
  },
});
