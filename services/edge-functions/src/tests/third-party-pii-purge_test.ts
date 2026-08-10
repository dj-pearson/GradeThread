// US-2433: erasure for a data subject who never had an account.
//
// The assertions that matter are (a) every column the story names is actually
// written, (b) the plan's column names exist in the migrations, and (c) the
// purge does not reach past its subject. (c) is AC5 and is the one that can
// cause harm if wrong: over-reach here destroys a payout audit trail and
// another person's record, which is a worse outcome than under-erasure.

import { assert, assertEquals } from "@std/assert";

import {
  canonicalMatchValue,
  matchesAddress,
  purgeThirdPartySubject,
  redactionPatch,
  REDACTED_EMAIL,
  RESIDUAL_FREE_TEXT,
  THIRD_PARTY_PURGE_PLAN,
  type ThirdPartyPurgeIO,
} from "../lib/third-party-pii-purge.ts";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);

interface Row {
  id: string;
  [col: string]: string | null;
}

/** A store that records every write, so over-reach is visible rather than inferred. */
function fakeStore(tables: Record<string, Row[]>) {
  const reports: string[] = [];
  const io: ThirdPartyPurgeIO = {
    findRows: (table, column, value) =>
      Promise.resolve({
        rows: (tables[table] ?? [])
          .filter((r) => (r[column] ?? "") === value)
          .map((r) => ({ id: r.id })),
        error: null,
      }),
    update: (table, id, patch) => {
      const row = (tables[table] ?? []).find((r) => r.id === id);
      if (!row) return Promise.resolve({ error: { message: "no such row" } });
      Object.assign(row, patch);
      return Promise.resolve({ error: null });
    },
    report: (m) => void reports.push(m),
  };
  return { io, reports };
}

Deno.test("US-2433: a claim buyer's identifiers are all written, and the audit row survives", async () => {
  const tables = {
    guarantee_claims: [
      {
        id: "claim-1",
        claimant_email: "buyer@example.com",
        claimant_name: "A Buyer",
        order_reference: "ORD-991",
        reason: "sleeve had a hole the certificate did not mention",
        status: "approved",
        seller_user_id: "seller-1",
      },
    ],
  };
  const { io } = fakeStore(tables);
  const res = await purgeThirdPartySubject("claim_buyer", "Buyer@Example.com ", io);

  assertEquals(res.notFound, false, "the address is matched case-insensitively and trimmed");
  assertEquals(res.anonymized.guarantee_claims, ["claim-1"]);
  assertEquals(res.failed.guarantee_claims, []);

  const row = tables.guarantee_claims[0]!;
  // Every column AC2 names.
  assertEquals(row.claimant_email, REDACTED_EMAIL);
  assertEquals(row.claimant_name, null);
  assertEquals(row.order_reference, null);
  // NOT NULL means the address is OVERWRITTEN, never nulled. A null here would
  // be rejected by the database (23502) and the real address would stay put.
  assert(row.claimant_email !== null, "claimant_email is NOT NULL — it must be redacted, not nulled");
  // The audit substance survives: this row is what proves a payout decision was
  // made, and claim_accuracy_signals + guarantee_remedies cascade from it.
  assertEquals(row.status, "approved");
  assertEquals(row.seller_user_id, "seller-1");
});

Deno.test("US-2433 AC5: the purge does not reach another subject's rows", async () => {
  const tables = {
    guarantee_claims: [
      { id: "mine", claimant_email: "buyer@example.com", claimant_name: "A Buyer", order_reference: "ORD-1" },
      { id: "theirs", claimant_email: "other@example.com", claimant_name: "B Buyer", order_reference: "ORD-2" },
      // Same seller, different buyer — the tempting wrong implementation is to
      // scope by seller_user_id because that is how the row is normally owned.
      { id: "same-seller", claimant_email: "third@example.com", claimant_name: "C Buyer", order_reference: "ORD-3" },
    ],
  };
  const { io } = fakeStore(tables);
  await purgeThirdPartySubject("claim_buyer", "buyer@example.com", io);

  assertEquals(tables.guarantee_claims[1]!.claimant_email, "other@example.com");
  assertEquals(tables.guarantee_claims[1]!.claimant_name, "B Buyer");
  assertEquals(tables.guarantee_claims[2]!.claimant_email, "third@example.com");
  assertEquals(tables.guarantee_claims[2]!.order_reference, "ORD-3");
});

Deno.test("US-2433: two consignors of one seller get DISTINCT tombstones", async () => {
  // UNIQUE(user_id, name) on consignors (00107). Redacting both to the same
  // constant raises 23505 on the second, which fails the write and leaves that
  // consignor's real name in place — a purge that reports partial success while
  // the second subject is untouched.
  const tables = {
    consignors: [
      { id: "aaaaaaaa-1111-2222-3333-444444444444", name: "Real Name", contact_email: "c@x.com", contact_phone: "+15551234567", user_id: "seller-1" },
      { id: "bbbbbbbb-1111-2222-3333-444444444444", name: "Other Name", contact_email: "d@x.com", contact_phone: "+15559999999", user_id: "seller-1" },
    ],
  };
  const { io } = fakeStore(tables);
  await purgeThirdPartySubject("consignor", "aaaaaaaa-1111-2222-3333-444444444444", io);
  await purgeThirdPartySubject("consignor", "bbbbbbbb-1111-2222-3333-444444444444", io);

  const [a, b] = tables.consignors;
  assertEquals(a!.contact_email, null);
  assertEquals(a!.contact_phone, null);
  assert(a!.name !== "Real Name", "the name must be replaced");
  assert(b!.name !== "Other Name", "the second one too");
  assert(
    a!.name !== b!.name,
    `both consignors were redacted to "${a!.name}" — UNIQUE(user_id, name) would ` +
      "reject the second write and leave that person's real name in the table",
  );
  // The seller's own record survives; inventory_items.consignor_id still resolves.
  assertEquals(a!.user_id, "seller-1");
});

Deno.test("US-2433: a subject kind cannot run the other kind's plan", async () => {
  // The two targets match on different columns (claimant_email vs id). A
  // mismatched pair matches nothing and would report a clean run over data it
  // never touched, which is the most dangerous possible false success here.
  const tables = {
    consignors: [{ id: "c-1", name: "Real Name", contact_email: "c@x.com", contact_phone: null, user_id: "s" }],
    guarantee_claims: [{ id: "claim-1", claimant_email: "c@x.com", claimant_name: "A", order_reference: "O" }],
  };
  const { io } = fakeStore(tables);
  const res = await purgeThirdPartySubject("claim_buyer", "c@x.com", io);

  assertEquals(res.anonymized.guarantee_claims, ["claim-1"]);
  assertEquals(res.anonymized.consignors, undefined, "the consignor plan must not run");
  assertEquals(tables.consignors[0]!.name, "Real Name");
  assertEquals(tables.consignors[0]!.contact_email, "c@x.com");
});

Deno.test("US-2433: an unknown subject reports notFound rather than a clean run", async () => {
  const { io } = fakeStore({ guarantee_claims: [] });
  const res = await purgeThirdPartySubject("claim_buyer", "nobody@example.com", io);
  assertEquals(res.notFound, true);
  // A blank input must not read as "erased everything for the empty subject".
  const blank = await purgeThirdPartySubject("claim_buyer", "   ", io);
  assertEquals(blank.notFound, true);
});

Deno.test("US-2433: a failing write is recorded, and the rest of the subject still runs", async () => {
  const tables = {
    guarantee_claims: [
      { id: "ok", claimant_email: "b@x.com", claimant_name: "A", order_reference: "O1" },
      { id: "broken", claimant_email: "b@x.com", claimant_name: "B", order_reference: "O2" },
    ],
  };
  const { io, reports } = fakeStore(tables);
  const wrapped: ThirdPartyPurgeIO = {
    ...io,
    update: (table, id, patch) =>
      id === "broken"
        ? Promise.resolve({ error: { message: "permission denied" } })
        : io.update(table, id, patch),
  };
  const res = await purgeThirdPartySubject("claim_buyer", "b@x.com", wrapped);

  assertEquals(res.anonymized.guarantee_claims, ["ok"]);
  assertEquals(res.failed.guarantee_claims, ["broken"]);
  assert(reports.some((r) => r.includes("broken")), "the failure names the row");
  // Abandoning the loop on the first failure would leave MORE of the subject's
  // data behind than logging and continuing.
  assertEquals(tables.guarantee_claims[0]!.claimant_email, REDACTED_EMAIL);
});

Deno.test("US-2433: every column the plan writes exists in the migrations", async () => {
  // A wrong column name is the failure this cannot afford: PostgREST answers
  // 42703, the module logs it and moves on, and the run reports as a purge.
  let sql = "";
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (e.isFile && e.name.endsWith(".sql")) {
      sql += await Deno.readTextFile(new URL(e.name, MIGRATIONS));
    }
  }
  assert(sql.length > 100_000, "the migration corpus did not load — the checks below would be vacuous");

  for (const t of THIRD_PARTY_PURGE_PLAN) {
    assert(
      new RegExp(`create table[^;]*public\\.${t.table}\\b`, "i").test(sql),
      `${t.table} is not created by any migration`,
    );
    const cols = [
      t.matchColumn,
      ...t.nulls,
      ...Object.keys(t.redact),
      ...Object.keys(t.redactUnique),
      ...t.residual,
    ];
    for (const col of cols) {
      assert(
        new RegExp(`^\\s*${col}\\s+`, "im").test(sql),
        `${t.table}.${col} appears in the purge plan but in no migration`,
      );
    }
    assert(t.reason.trim().length >= 40, `${t.table}: the mode needs a written reason (AC3)`);
  }
});

Deno.test("US-2433: the residual free-text columns are named, not silently skipped", () => {
  // These are columns the plan knowingly leaves alone. Pinning the list means
  // a future reader who deletes the explanation has to delete this too, rather
  // than the comment quietly drifting out of date while the behaviour stays.
  assertEquals([...RESIDUAL_FREE_TEXT].sort(), [
    "consignors.notes",
    "guarantee_claims.evidence_urls",
    "guarantee_claims.reason",
  ]);
  for (const t of THIRD_PARTY_PURGE_PLAN) {
    for (const col of t.residual) {
      assert(
        RESIDUAL_FREE_TEXT.includes(`${t.table}.${col}`),
        `${t.table}.${col} is left alone by the plan but is not in RESIDUAL_FREE_TEXT, ` +
          "so nothing tells a reader it was a decision rather than an oversight",
      );
    }
  }
});

// ── The caller (US-2433 AC1) ────────────────────────────────────────────────

const SCRIPT = new URL("../../scripts/purge-third-party-subject.ts", import.meta.url);

/**
 * A store that compares addresses the way the operator script does — canonical
 * form on BOTH ends — rather than the way `.eq()` does. The difference between
 * this and `fakeStore` is the whole finding below.
 */
function canonicalStore(tables: Record<string, Row[]>) {
  const reports: string[] = [];
  const io: ThirdPartyPurgeIO = {
    findRows: (table, column, value) =>
      Promise.resolve({
        rows: (tables[table] ?? [])
          .filter((r) =>
            column === "id"
              ? r.id === value
              : canonicalMatchValue("claim_buyer", r[column] ?? "") === value
          )
          .map((r) => ({ id: r.id })),
        error: null,
      }),
    update: (table, id, patch) => {
      const row = (tables[table] ?? []).find((r) => r.id === id);
      if (!row) return Promise.resolve({ error: { message: "no such row" } });
      Object.assign(row, patch);
      return Promise.resolve({ error: null });
    },
    report: (m) => void reports.push(m),
  };
  return { io, reports };
}

Deno.test("US-2433: a STORED mixed-case address is missed by an .eq() lookup, and the miss looks like success", async () => {
  // THE FINDING, and it is about the stored side rather than the input side.
  // guarantee_claims.claimant_email is plain `text` (00197) and the public
  // intake stores what the buyer typed — asString() in guarantee-public.ts
  // trims and truncates and does NOT lowercase. purgeThirdPartySubject
  // canonicalizes the value it is given. So a claim filed as `Buyer@Example.com`
  // is invisible to a `.eq()` on the canonical form.
  //
  // The existing pass-case above seeds a LOWERCASE stored address, so it proves
  // the input is normalized and says nothing about the column. This is the case
  // production actually holds.
  const stored = () => [{
    id: "claim-1",
    claimant_email: "Buyer@Example.com",
    claimant_name: "A Buyer",
    order_reference: "ORD-1",
  }];

  const naive = { guarantee_claims: stored() };
  const naiveRes = await purgeThirdPartySubject("claim_buyer", "buyer@example.com", fakeStore(naive).io);
  // Not an exception, not an error — a clean "there was nothing to erase",
  // which is what an operator would relay to the data subject while the address
  // sits exactly where it was. Under-erasure that reports as success is worse
  // than a loud failure.
  assertEquals(naiveRes.notFound, true);
  assertEquals(naive.guarantee_claims[0]!.claimant_email, "Buyer@Example.com");

  const correct = { guarantee_claims: stored() };
  const okRes = await purgeThirdPartySubject("claim_buyer", "buyer@example.com", canonicalStore(correct).io);
  assertEquals(okRes.notFound, false);
  assertEquals(correct.guarantee_claims[0]!.claimant_email, REDACTED_EMAIL);
  assertEquals(correct.guarantee_claims[0]!.claimant_name, null);
});

Deno.test("US-2433: canonicalMatchValue folds an address and leaves a row id alone", () => {
  assertEquals(canonicalMatchValue("claim_buyer", "  Buyer@Example.COM "), "buyer@example.com");
  // A uuid's case is not ours to fold, and a consignor is matched by row id.
  assertEquals(canonicalMatchValue("consignor", "  AB12-CD34 "), "AB12-CD34");
});

Deno.test("US-2433: matchesAddress compares the stored value, NULLs included", () => {
  assertEquals(matchesAddress("Buyer@Example.com", "buyer@example.com"), true);
  assertEquals(matchesAddress("  buyer@example.com ", "buyer@example.com"), true);
  assertEquals(matchesAddress("other@example.com", "buyer@example.com"), false);
  // consignors.contact_email is nullable — a consignor recorded by name alone
  // is reached by row id, not by an address that is not there.
  assertEquals(matchesAddress(null, "buyer@example.com"), false);
  assertEquals(matchesAddress(undefined, "buyer@example.com"), false);
});

Deno.test("US-2433 AC5: an underscore in an address is a character, not a wildcard", async () => {
  // Why the script compares in TypeScript rather than with ILIKE. `_` matches
  // any single character in SQL LIKE and is legal in an email local part, so
  // an ILIKE lookup for `a_b@x.test` would also match `axb@x.test` — a
  // different person, whose payout audit record we would then anonymize.
  const tables = {
    guarantee_claims: [
      { id: "subject", claimant_email: "a_b@x.test", claimant_name: "Subject", order_reference: "ORD-1" },
      { id: "bystander", claimant_email: "axb@x.test", claimant_name: "Bystander", order_reference: "ORD-2" },
    ],
  };
  const res = await purgeThirdPartySubject("claim_buyer", "A_B@X.test", canonicalStore(tables).io);

  assertEquals(res.anonymized.guarantee_claims, ["subject"]);
  assertEquals(tables.guarantee_claims[1]!.claimant_email, "axb@x.test");
  assertEquals(tables.guarantee_claims[1]!.claimant_name, "Bystander");
});

Deno.test("US-2433 AC1: the operator script keeps its guardrails", async () => {
  const src = await Deno.readTextFile(SCRIPT);

  // No pattern operator, for the reason the case above demonstrates.
  for (const f of ["ilike(", ".like(", '"ilike"', "'ilike'"]) {
    assert(!src.includes(f), `the script uses ${f} — an email may contain _ or %`);
  }
  // One normalization rule, shared. A second copy drifts silently into notFound.
  //
  // Asserting the IMPORT is not enough and I had it that way first: a mutation
  // that rewrote a single comparison to `stored.trim() === canonical` left the
  // import line intact and the guard stayed green. So the assertion is on the
  // SHAPE a re-implementation takes — a bare equality against the canonical
  // address — not on the presence of a name.
  assert(src.includes("matchesAddress"), "address equality belongs to the module");
  for (const rhs of ["canonical", "value"]) {
    assert(
      !new RegExp(`===\\s*${rhs}\\b`).test(src),
      `the script compares something directly against \`${rhs}\`. Address equality ` +
        "is matchesAddress() in third-party-pii-purge.ts — a local copy is a " +
        "second normalization rule, and when the two drift the lookup matches " +
        "nothing and reports notFound, which reads as 'already clean'.",
    );
  }
  // Anonymize, never delete: both rows are load-bearing for someone else.
  assert(!src.includes(".delete("), "the third-party purge anonymizes; it does not delete");
  // Dry run by default.
  assert(src.includes("--apply"), "the script must be dry-run by default");
  assert(
    src.includes("if (!apply) return { error: null };"),
    "the dry run must suppress the WRITE, not just the wording",
  );
  // --find reads. A find that could act is the deletion oracle in local form.
  assert(src.includes("--find never writes"), "--find must say it is read-only");
  // Still not a route (AC1). If this ever becomes self-serve, the verification
  // is the story, and it is not this file.
  for (const routeish of ["hono", "app.post", "app.get", "Hono("]) {
    assert(!src.includes(routeish), `the script must not become an endpoint (${routeish})`);
  }
});

Deno.test("US-2433: redactionPatch writes no real identifier", () => {
  for (const t of THIRD_PARTY_PURGE_PLAN) {
    const patch = redactionPatch(t, "12345678-abcd-0000-0000-000000000000");
    for (const col of t.nulls) assertEquals(patch[col], null, `${t.table}.${col}`);
    for (const col of Object.keys(t.redact)) {
      assert(typeof patch[col] === "string" && patch[col]!.length > 0, `${t.table}.${col} must be overwritten`);
    }
    for (const col of Object.keys(t.redactUnique)) {
      assert(patch[col]!.includes("12345678"), `${t.table}.${col} must carry the row id slice`);
    }
    // Nothing in the plan may leave an identifying column untouched.
    const written = new Set(Object.keys(patch));
    for (const col of [...t.nulls, ...Object.keys(t.redact), ...Object.keys(t.redactUnique)]) {
      assert(written.has(col), `${t.table}.${col} is planned but not written`);
    }
  }
});
