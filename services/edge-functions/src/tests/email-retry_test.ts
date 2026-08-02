// US-498: email outbox backoff schedule. email-retry.ts imports supabase at
// module init, so set dummy env before the dynamic import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { backoffMs } = await import("../lib/email-retry.ts");

Deno.test("backoff increases with attempts and caps", () => {
  const b1 = backoffMs(0);
  const b2 = backoffMs(1);
  const b3 = backoffMs(2);
  const b4 = backoffMs(3);
  const b5 = backoffMs(4);
  // Monotonically non-decreasing.
  assert(b1 <= b2 && b2 <= b3 && b3 <= b4 && b4 <= b5);
  // First retry ~1 min, cap at 6h.
  assertEquals(b1, 60_000);
  assertEquals(b5, 360 * 60_000);
});

Deno.test("backoff is clamped at the max for attempts beyond the schedule", () => {
  assertEquals(backoffMs(99), 360 * 60_000);
});

// ── US-2315: one poison row must not block the batch ─────────────────
//
// The scan orders by next_attempt_at ASC, and before this fix `attempts` and
// `next_attempt_at` were written only AFTER deliverEmail returned. So a row
// whose processing THREW kept its original next_attempt_at, sorted first on the
// next run, threw again, and aborted the remaining 49 rows — every five
// minutes, forever. These pin the recovery, not the send.

const { sweepDueRows } = await import("../lib/email-retry.ts");
type EmailRetryDeps = import("../lib/email-retry.ts").EmailRetryDeps;

interface Row {
  id: string;
  recipient: string;
  subject: string;
  html: string;
  category: string;
  attempts: number;
  max_attempts: number;
}

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    recipient: `${id}@example.com`,
    subject: "s",
    html: "<p>h</p>",
    category: "transactional",
    attempts: 0,
    max_attempts: 5,
    ...over,
  };
}

/** Deps where `poison` always throws and everything else delivers. */
function deps(
  poison: string,
  patches: Array<{ id: string; values: Record<string, unknown> }>,
) {
  return {
    getSuppression: (recipient: string) => {
      if (recipient.startsWith(`${poison}@`)) {
        throw new Error("suppression lookup exploded");
      }
      return Promise.resolve(null);
    },
    deliverEmail: () => Promise.resolve(true),
    patch: (id: string, values: Record<string, unknown>) => {
      patches.push({ id, values });
      return Promise.resolve();
    },
  } as unknown as EmailRetryDeps;
}

Deno.test("US-2315: a throwing row does not stop the rest of the batch", async () => {
  const patches: Array<{ id: string; values: Record<string, unknown> }> = [];
  // The poison row is FIRST, which is where next_attempt_at ASC would put it.
  const due = [row("poison"), row("b"), row("c"), row("d")];
  const res = await sweepDueRows(due, deps("poison", patches));

  assertEquals(res.scanned, 4);
  assertEquals(res.sent, 3, "b, c and d must still have been delivered");
  assertEquals(res.failed, 1);
  assert(
    patches.some((p) => p.id === "d"),
    "the LAST row was reached — the batch was not aborted",
  );
});

Deno.test("US-2315: the throwing row is advanced so it cannot sort first forever", async () => {
  const patches: Array<{ id: string; values: Record<string, unknown> }> = [];
  await sweepDueRows([row("poison", { attempts: 1 })], deps("poison", patches));

  const p = patches.find((x) => x.id === "poison");
  assert(p, "the throwing row must be written back");
  assertEquals(p.values.attempts, 2, "attempts advanced past the throw");
  assert(
    typeof p.values.next_attempt_at === "string",
    "next_attempt_at moved forward — this is what breaks the head-of-line stall",
  );
  assert(
    String(p.values.last_error).startsWith("threw:"),
    "the throw is recorded",
  );
});

Deno.test("US-2315: a row that keeps throwing eventually dead-letters", async () => {
  const patches: Array<{ id: string; values: Record<string, unknown> }> = [];
  // One attempt short of max: this throw is the last one.
  const res = await sweepDueRows([
    row("poison", { attempts: 4, max_attempts: 5 }),
  ], deps("poison", patches));

  assertEquals(res.dead_lettered, 1);
  const p = patches.find((x) => x.id === "poison");
  assertEquals(p?.values.status, "dead_letter");
  assertEquals(
    p?.values.next_attempt_at,
    undefined,
    "a dead-lettered row is not rescheduled — it stops being selected at all",
  );
});

Deno.test("US-2315: the sweep reports a failed count US-2312's recorder can read", async () => {
  const patches: Array<{ id: string; values: Record<string, unknown> }> = [];
  const res = await sweepDueRows(
    [row("poison"), row("b")],
    deps("poison", patches),
  );
  // `failed` is one of cron-run-outcome.ts's FAILURE_KEYS, so a sweep that
  // throws now records the run as an error instead of answering 200 quietly.
  assertEquals(res.failed, 1);
});

Deno.test("US-2315 REGRESSION: a clean batch is unchanged", async () => {
  const patches: Array<{ id: string; values: Record<string, unknown> }> = [];
  const res = await sweepDueRows(
    [row("a"), row("b")],
    deps("__none__", patches),
  );
  assertEquals(res.sent, 2);
  assertEquals(res.failed, 0);
  assertEquals(res.dead_lettered, 0);
  assertEquals(res.retried, 0);
});
