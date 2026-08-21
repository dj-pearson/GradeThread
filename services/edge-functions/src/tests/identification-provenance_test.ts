// US-2774: the identification decisions get written down.
//
// The property under test is not "a row is inserted". It is that the three
// states a visual candidate can end in stay TELLABLE APART after storage:
// never offered, offered and ignored, offered and refused. Collapse those and
// the table cannot answer the question it exists for — is the visual provider
// any good — while still looking full of data.

import { assert, assertEquals } from "@std/assert";
import {
  buildCategoryPatch,
  buildExtractionRow,
  recordCategoryDecision,
  recordExtractionProvenance,
} from "../lib/identification-provenance.ts";
import type { CategoryDecision } from "../lib/category-decision.ts";

interface Call {
  table: string;
  op: "insert" | "update";
  row: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

function fakeSupabase(opts: { error?: string; id?: string } = {}) {
  const calls: Call[] = [];
  const err = opts.error ? { message: opts.error } : null;

  function chain(call: Call) {
    const self = {
      eq(col: string, val: unknown) {
        call.filters.push([col, val]);
        return self;
      },
      select() {
        return self;
      },
      single() {
        return Promise.resolve({
          data: err ? null : { id: opts.id ?? "prov-1" },
          error: err,
        });
      },
      then(
        // deno-lint-ignore no-explicit-any
        resolve: (v: any) => unknown,
      ) {
        return Promise.resolve({ data: null, error: err }).then(resolve);
      },
    };
    return self;
  }

  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          const call: Call = { table, op: "insert", row, filters: [] };
          calls.push(call);
          return chain(call);
        },
        update(row: Record<string, unknown>) {
          const call: Call = { table, op: "update", row, filters: [] };
          calls.push(call);
          return chain(call);
        },
      };
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { client, calls };
}

const CANDIDATES = [
  { field: "brand", value: "Lululemon", support: 4, outOf: 5 },
  { field: "type", value: "Hoodie", support: 3, outOf: 5 },
  { field: "style", value: "Scuba", support: 2, outOf: 5 },
];

Deno.test("the row keeps what was OFFERED, not only what came back", () => {
  const row = buildExtractionRow({
    ownerUserId: "u1",
    itemId: "i1",
    candidates: CANDIDATES,
    // The model refused one, accepted one, and said nothing about the third.
    rulings: [
      { field: "brand", value: "Lululemon", verdict: "rejected", evidence: null },
      {
        field: "type",
        value: "Hoodie",
        verdict: "accepted",
        evidence: "tag_wordmark",
      },
    ],
  });

  const offered = row.visual_candidates as Array<Record<string, unknown>>;
  const ruled = row.visual_rulings as Array<Record<string, unknown>>;
  assertEquals(offered.length, 3);
  assertEquals(ruled.length, 2);

  const ruledValues = new Set(ruled.map((r) => `${r.field}:${r.value}`));
  const verdictOf = (v: string) =>
    ruled.find((r) => r.value === v)?.verdict ?? null;

  // Refused on evidence — the provider was wrong, and that is measurable.
  assertEquals(verdictOf("Lululemon"), "rejected");
  // Accepted, with the evidence that accepted it named.
  assertEquals(verdictOf("Hoodie"), "accepted");
  assertEquals(ruled.find((r) => r.value === "Hoodie")?.evidence, "tag_wordmark");
  // Offered and IGNORED — present in the offer, absent from the rulings. A
  // table storing only rulings would make this identical to never-offered.
  assert(!ruledValues.has("style:Scuba"));
  assert(offered.some((c) => c.value === "Scuba"));
});

Deno.test("nothing offered is a different row from everything rejected", () => {
  const nothingOffered = buildExtractionRow({
    ownerUserId: "u1",
    candidates: [],
    rulings: [],
  });
  const allRejected = buildExtractionRow({
    ownerUserId: "u1",
    candidates: CANDIDATES,
    rulings: CANDIDATES.map((c) => ({
      field: c.field,
      value: c.value,
      verdict: "rejected" as const,
      evidence: null,
    })),
  });

  assertEquals((nothingOffered.visual_candidates as unknown[]).length, 0);
  assertEquals((nothingOffered.visual_rulings as unknown[]).length, 0);
  assertEquals((allRejected.visual_candidates as unknown[]).length, 3);
  assertEquals((allRejected.visual_rulings as unknown[]).length, 3);
});

Deno.test("the offered support is carried as counts, not as a ratio", () => {
  // 2 of 2 and 2 of 5 are different evidence. Storing a percentage would throw
  // away the sample size, which is the half that says how much to trust it.
  const row = buildExtractionRow({
    ownerUserId: "u1",
    candidates: [{ field: "brand", value: "Nike", support: 2, outOf: 5 }],
    rulings: [],
  });
  const offered = (row.visual_candidates as Array<Record<string, unknown>>)[0]!;
  assertEquals(offered.support, 2);
  assertEquals(offered.out_of, 5);
});

const DECIDED_AT = "2026-08-21T12:00:00.000Z";

Deno.test("a losing vote's reason is stored, not just the winner", () => {
  const decision: CategoryDecision = {
    categoryId: "57990",
    categoryName: "Men's Hoodies",
    method: "keyword",
    support: 0,
    rejectedReason: "tied",
  };
  const patch = buildCategoryPatch(decision, DECIDED_AT);
  assertEquals(patch.category_method, "keyword");
  assertEquals(patch.category_rejected_reason, "tied");
  assertEquals(patch.category_id, "57990");
  assertEquals(patch.category_decided_at, DECIDED_AT);
});

Deno.test("a vote that WON stores its support and no rejection", () => {
  const patch = buildCategoryPatch({
    categoryId: "155183",
    categoryName: "Sweatshirts",
    method: "visual_consensus",
    support: 4,
    rejectedReason: null,
  }, DECIDED_AT);
  assertEquals(patch.category_method, "visual_consensus");
  assertEquals(patch.category_support, 4);
  assertEquals(patch.category_rejected_reason, null);
});

Deno.test("recordExtractionProvenance writes the owner and returns the row id", async () => {
  const { client, calls } = fakeSupabase({ id: "prov-9" });
  const id = await recordExtractionProvenance(client, {
    ownerUserId: "u1",
    itemId: "i1",
    enrichmentLogId: "log-1",
    candidates: CANDIDATES,
    rulings: [],
  });
  assertEquals(id, "prov-9");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].table, "identification_provenance");
  assertEquals(calls[0].op, "insert");
  assertEquals(calls[0].row.owner_user_id, "u1");
  assertEquals(calls[0].row.enrichment_log_id, "log-1");
});

Deno.test("a failed provenance write is swallowed, never thrown", async () => {
  // The record of a decision is worth less than the decision. An extraction
  // that threw here would cost the seller the whole run.
  const { client } = fakeSupabase({ error: "boom" });
  assertEquals(
    await recordExtractionProvenance(client, {
      ownerUserId: "u1",
      candidates: [],
      rulings: [],
    }),
    null,
  );
  assertEquals(
    await recordCategoryDecision(client, {
      ownerUserId: "u1",
      provenanceId: "prov-1",
      decision: {
        categoryId: null,
        categoryName: null,
        method: "none",
        support: 0,
        rejectedReason: "no_votes",
      },
    }),
    false,
  );
});

Deno.test("the category update is scoped by owner as well as by id (US-268)", async () => {
  const { client, calls } = fakeSupabase();
  const ok = await recordCategoryDecision(client, {
    ownerUserId: "u1",
    itemId: "i1",
    provenanceId: "prov-1",
    decision: {
      categoryId: "1",
      categoryName: "X",
      method: "keyword",
      support: 0,
      rejectedReason: null,
    },
  });
  assert(ok);
  assertEquals(calls[0].op, "update");
  assertEquals(calls[0].filters, [["id", "prov-1"], ["owner_user_id", "u1"]]);
});

Deno.test("with no row to complete, the decision opens its own", async () => {
  // The extraction insert can fail. Dropping the decision because its row is
  // missing would lose the half that is still knowable.
  const { client, calls } = fakeSupabase();
  const ok = await recordCategoryDecision(client, {
    ownerUserId: "u1",
    itemId: "i1",
    provenanceId: null,
    decision: {
      categoryId: null,
      categoryName: null,
      method: "none",
      support: 0,
      rejectedReason: "below_min_support",
    },
  });
  assert(ok);
  assertEquals(calls[0].op, "insert");
  assertEquals(calls[0].row.owner_user_id, "u1");
  assertEquals(calls[0].row.inventory_item_id, "i1");
  assertEquals(calls[0].row.category_method, "none");
  assertEquals(calls[0].row.category_rejected_reason, "below_min_support");
});

Deno.test("no owner, no write", async () => {
  const { client, calls } = fakeSupabase();
  assertEquals(
    await recordExtractionProvenance(client, {
      ownerUserId: "",
      candidates: [],
      rulings: [],
    }),
    null,
  );
  assertEquals(
    await recordCategoryDecision(client, {
      ownerUserId: "",
      decision: {
        categoryId: null,
        categoryName: null,
        method: "none",
        support: 0,
        rejectedReason: null,
      },
    }),
    false,
  );
  assertEquals(calls.length, 0);
});
