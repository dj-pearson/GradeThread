// US-2324 AC3: a record that fails every time stops being retried every time.
//
// The Etsy and Depop syncs keep no cursor, so every run re-reads the provider's
// recent window from the start. Per-record isolation (AC2) stopped one bad
// record killing the tail behind it; it did nothing about the record being
// attempted again on every run, forever, with its failure landing as one more
// line in a log nobody can read any more.

import { assert, assertEquals } from "@std/assert";

// The module now carries the database half beside the decisions, so it pulls in
// the service-role client, which throws at load without these.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  indexFailures,
  isQuarantined,
  nextFailureState,
  QUARANTINE_AFTER_ATTEMPTS,
} = await import("../lib/sync-quarantine.ts");

Deno.test("a first failure does NOT quarantine", () => {
  // The decisive case. These syncs talk to a live provider API, so one failure
  // is far more likely to be a timeout or a 502 than a genuinely bad record.
  // Quarantining on the first would set aside real orders during any provider
  // blip — converting a transient outage into a silent backlog, which is the
  // failure this exists to prevent rather than cause.
  const s = nextFailureState(undefined);
  assertEquals(s.attempts, 1);
  assertEquals(s.quarantine, false);
  assertEquals(s.justQuarantined, false);
});

Deno.test("the threshold-th failure quarantines, and says so once", () => {
  const second = nextFailureState({
    external_id: "r1",
    attempts: 1,
    quarantined_at: null,
  });
  assertEquals(second.quarantine, false);

  const third = nextFailureState({
    external_id: "r1",
    attempts: QUARANTINE_AFTER_ATTEMPTS - 1,
    quarantined_at: null,
  });
  assertEquals(third.attempts, QUARANTINE_AFTER_ATTEMPTS);
  assertEquals(third.quarantine, true);
  // The TRANSITION is reported once. Without this the caller logs "quarantined"
  // on every subsequent run, which is exactly the repeating noise the feature is
  // meant to remove.
  assertEquals(third.justQuarantined, true);
});

Deno.test("an already-quarantined record does not re-announce", () => {
  const s = nextFailureState({
    external_id: "r1",
    attempts: 9,
    quarantined_at: "2026-08-01T00:00:00Z",
  });
  assertEquals(s.quarantine, true);
  assertEquals(s.justQuarantined, false);
});

Deno.test("the skip decision reads the STORED flag, not the count", () => {
  // The retry path depends on this. An operator clears quarantined_at to try a
  // record again and DELIBERATELY leaves the attempt history — it is the
  // evidence of why it was skipped. Re-deriving the answer from `attempts`
  // would ignore that and skip the record anyway, making the retry action do
  // nothing while looking like it worked.
  assertEquals(
    isQuarantined({ external_id: "r1", attempts: 50, quarantined_at: null }),
    false,
  );
  assertEquals(
    isQuarantined({ external_id: "r1", attempts: 1, quarantined_at: "2026-08-01T00:00:00Z" }),
    true,
  );
  // A record with no failure history at all is not quarantined.
  assertEquals(isQuarantined(undefined), false);
});

Deno.test("failures are indexed by the provider's id, one lookup per record", () => {
  // A scan per record would be O(n²) across a few hundred orders — invisible in
  // testing and visible only once a seller gets large.
  const idx = indexFailures([
    { external_id: "a", attempts: 1, quarantined_at: null },
    { external_id: "b", attempts: 4, quarantined_at: "2026-08-01T00:00:00Z" },
  ]);
  assertEquals(idx.size, 2);
  assertEquals(isQuarantined(idx.get("b")), true);
  assertEquals(isQuarantined(idx.get("a")), false);
  assertEquals(idx.get("missing"), undefined);
});

Deno.test("the table is operator-only and avoids the tenant-discovery trap", () => {
  const sql = Deno.readTextFileSync(
    new URL(
      "../../../../supabase/migrations/00524_marketplace_sync_quarantine.sql",
      import.meta.url,
    ),
  );
  // Deny-all: RLS on, zero policies, and the grant revoked. Reading this from a
  // browser would show a seller raw provider error text; writing it would let
  // them clear their own quarantine.
  assert(sql.includes("ENABLE ROW LEVEL SECURITY"));
  assert(!/CREATE POLICY/i.test(sql), "a policy would open this to the browser");
  assert(sql.includes("REVOKE ALL ON public.marketplace_sync_failures FROM anon, authenticated"));

  // The owner column must NOT be called user_id: rls-guard_test discovers TENANT
  // tables by that literal string in the CREATE TABLE block, and a false hit
  // there would demand tenant policies on an operator table.
  const create = sql.slice(sql.indexOf("CREATE TABLE"), sql.indexOf(");"));
  assert(create.includes("owner_user_id"), "no owner column");
  assert(
    !/[^_]user_id/.test(create.replace(/owner_user_id/g, "")),
    "the CREATE TABLE block names a bare user_id — rls-guard will treat this as tenant data",
  );

  // US-1108: idempotent + self-recording.
  assert(sql.includes("CREATE TABLE IF NOT EXISTS"));
  assert(sql.includes("insert into public.applied_migrations (version) values ('00524')"));
});

Deno.test("both cursorless syncs consult the quarantine and both maintain it", () => {
  // Enumerated because the two connectors are the ONLY callers and they are the
  // reason the table exists. A sync that loads the list but never records a
  // failure would quarantine nothing; one that records but never loads would
  // skip nothing. Both halves, in both files.
  for (
    const [file, marketplace] of [
      ["../routes/flipdesk-etsy.ts", "etsy"],
      ["../routes/flipdesk-depop.ts", "depop"],
    ] as const
  ) {
    const src = Deno.readTextFileSync(new URL(file, import.meta.url));
    assert(
      src.includes(`loadSyncFailures(userId, "${marketplace}")`),
      `${file}: does not load the quarantine list`,
    );
    assert(src.includes("isQuarantined(prior)"), `${file}: never skips`);
    assert(src.includes("recordSyncFailure({"), `${file}: never records a failure`);
    assert(src.includes("clearSyncFailure("), `${file}: never clears on success`);

    // The skip must come BEFORE the handler call, or the record is processed and
    // then skipped, which is the opposite of the point.
    const skipAt = src.indexOf("isQuarantined(prior)");
    const handleAt = src.indexOf(
      marketplace === "etsy" ? "handleEtsyReceiptEvent(userId" : "handleDepopOrderEvent(userId",
    );
    assert(skipAt > -1 && handleAt > -1, `${file}: anchors missing`);
    assert(skipAt < handleAt, `${file}: the quarantine check runs after the work`);

    // A pass that is quiet because everything is quarantined must be
    // distinguishable from one that is quiet because everything worked.
    assert(
      src.includes("quarantined_skipped: quarantinedSkipped"),
      `${file}: does not report how many it skipped`,
    );
  }
});
