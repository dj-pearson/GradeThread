// US-9101: the connector's monthly allowance.
//
// This is the number a plan is sold on, so the tests are about the two ways it
// stops meaning what the pricing page says:
//
//   • FAILING OPEN. An allowance we cannot read must not read as unlimited for
//     something that publishes listings.
//   • COUNTING THE WRONG THINGS. A preview, a read or a refused call must cost
//     nothing — charging for "can I?" teaches a model to ask less, which is the
//     opposite of what the whole preview protocol wants.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { checkConnectorAllowance, connectorActionsUsed, monthWindow } = await import(
  "../lib/connector-allowance.ts"
);
const { WRITE_TOOL_NAMES, TOOLS } = await import("../lib/mcp-tools.ts");

// Mid-March 2026, so the month boundaries are unambiguous.
const NOW = Date.UTC(2026, 2, 17, 12, 0, 0);
const USER = "user-1";

/** A db stub answering the users lookup and the mcp_tool_calls count. */
function stubDb(opts: {
  plan?: string | null;
  count?: number;
  countError?: boolean;
} = {}) {
  const filters: Record<string, unknown> = {};
  return {
    filters,
    db: {
      from(table: string) {
        if (table === "users") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: opts.plan === null ? null : {
                      flipdesk_plan: opts.plan ?? "pro",
                      subscription_status: "active",
                      trial_ends_at: null,
                      past_due_since: null,
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        // mcp_tool_calls
        const chain = {
          eq(col: string, value: unknown) {
            filters[col] = value;
            return chain;
          },
          in(col: string, value: unknown) {
            filters[col] = value;
            return chain;
          },
          gte(col: string, value: unknown) {
            filters[col] = value;
            return Promise.resolve(
              opts.countError
                ? { count: null, error: { message: "counter down" } }
                : { count: opts.count ?? 0, error: null },
            );
          },
        };
        return { select: () => chain };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// the window
// ---------------------------------------------------------------------------

Deno.test("the window is the calendar month in UTC", () => {
  const { startIso, resetsAtIso } = monthWindow(NOW);
  assertEquals(startIso, "2026-03-01T00:00:00.000Z");
  assertEquals(resetsAtIso, "2026-04-01T00:00:00.000Z");
});

Deno.test("December rolls into the next YEAR, not into month thirteen", () => {
  const { resetsAtIso } = monthWindow(Date.UTC(2026, 11, 31, 23, 59));
  assertEquals(resetsAtIso, "2027-01-01T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// what is counted
// ---------------------------------------------------------------------------

Deno.test("only SUCCESSFUL calls to the named write tools are counted", async () => {
  const { db, filters } = stubDb({ count: 7 });
  const used = await connectorActionsUsed(USER, ["gradethread_publish_listing"], NOW, db);
  assertEquals(used, 7);
  assertEquals(filters.owner_user_id, USER);
  assertEquals(filters.result_status, "ok", "a refused call must not cost an action");
  assertEquals(filters.tool_name, ["gradethread_publish_listing"]);
  assertEquals(filters.created_at, "2026-03-01T00:00:00.000Z");
});

Deno.test("an empty write-tool list counts nothing rather than everything", async () => {
  // The shape of a nasty bug: an `.in()` with an empty array is not "match all"
  // in every client, and guessing which would be a coin flip on a money gate.
  const { db } = stubDb({ count: 999 });
  assertEquals(await connectorActionsUsed(USER, [], NOW, db), 0);
});

Deno.test("the write-tool list is DERIVED from the registry, not hand-written", () => {
  // A hand-listed version is a list that is right on the day it is written.
  const expected = TOOLS
    .filter((t) => t.annotations.destructiveHint === true && !t.sandbox)
    .map((t) => t.name)
    .sort();
  assertEquals([...WRITE_TOOL_NAMES].sort(), expected);
  assert(WRITE_TOOL_NAMES.length > 0, "no write tools are being counted at all");
});

Deno.test("no READ tool and no SANDBOX tool is in the counted set", () => {
  for (const tool of TOOLS) {
    if (tool.annotations.readOnlyHint === true || tool.sandbox) {
      assert(
        !WRITE_TOOL_NAMES.includes(tool.name),
        `${tool.name} costs an allowance action and should not`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// the verdict
// ---------------------------------------------------------------------------

Deno.test("a pro seller inside the allowance is allowed", async () => {
  const { db } = stubDb({ plan: "pro", count: 10 });
  const verdict = await checkConnectorAllowance(USER, WRITE_TOOL_NAMES, NOW, db);
  assert(verdict.allowed);
  assertEquals(verdict.used, 10);
  assertEquals(verdict.limit, 500);
});

Deno.test("the boundary: the last action fits, the next does not", async () => {
  const at = stubDb({ plan: "pro", count: 499 });
  assert((await checkConnectorAllowance(USER, WRITE_TOOL_NAMES, NOW, at.db)).allowed);

  const over = stubDb({ plan: "pro", count: 500 });
  assert(!(await checkConnectorAllowance(USER, WRITE_TOOL_NAMES, NOW, over.db)).allowed);
});

Deno.test("a starter seller has no allowance, and is told what to do", async () => {
  const { db } = stubDb({ plan: "starter", count: 0 });
  const verdict = await checkConnectorAllowance(USER, WRITE_TOOL_NAMES, NOW, db);
  assert(!verdict.allowed);
  assertEquals(verdict.limit, 0);
  assert(/pricing/.test(verdict.message ?? ""), "say where to upgrade");
});

Deno.test("an exhausted allowance names the number and when it resets", async () => {
  const { db } = stubDb({ plan: "pro", count: 500 });
  const verdict = await checkConnectorAllowance(USER, WRITE_TOOL_NAMES, NOW, db);
  assert(!verdict.allowed);
  assert(verdict.message!.includes("500"));
  assert(verdict.message!.includes("2026-04-01"), `no reset date: ${verdict.message}`);
});

Deno.test("an unresolvable user FAILS CLOSED", async () => {
  // "We could not read your plan" must not mean "unlimited" on a path that
  // publishes listings.
  const { db } = stubDb({ plan: null });
  const verdict = await checkConnectorAllowance(USER, WRITE_TOOL_NAMES, NOW, db);
  assert(!verdict.allowed);
  assertEquals(verdict.limit, 0);
});

Deno.test("a counter outage THROWS rather than reporting zero used", async () => {
  // Returning 0 would read as "nothing spent", which is the wrong default for
  // an allowance. The dispatcher catches it and fails closed.
  const { db } = stubDb({ plan: "pro", countError: true });
  let threw = false;
  try {
    await connectorActionsUsed(USER, WRITE_TOOL_NAMES, NOW, db);
  } catch {
    threw = true;
  }
  assert(threw, "the counter swallowed an outage and reported a number");
});

Deno.test("an expired trial falls back to Free, so the connector stops", async () => {
  // The whole reason the effective plan is resolved rather than the raw column:
  // a downgrade has to actually stop the paid behaviour.
  const db = {
    from(table: string) {
      if (table === "users") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    flipdesk_plan: "pro",
                    subscription_status: "trialing",
                    trial_ends_at: "2026-01-01T00:00:00Z",
                    past_due_since: null,
                  },
                  error: null,
                }),
            }),
          }),
        };
      }
      const chain = {
        eq: () => chain,
        in: () => chain,
        gte: () => Promise.resolve({ count: 0, error: null }),
      };
      return { select: () => chain };
    },
  };
  const verdict = await checkConnectorAllowance(USER, WRITE_TOOL_NAMES, NOW, db);
  assert(!verdict.allowed, "an expired trial kept its pro allowance");
  assertEquals(verdict.limit, 0);
});
