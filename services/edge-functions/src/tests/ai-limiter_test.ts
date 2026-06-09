// Unit tests for the global Claude concurrency + daily-ceiling limiter (US-414).
// The Semaphore and the ceiling decision are pure/injectable, so they run with
// no timers and no database.
//
// ai-limiter.ts only touches Supabase via the DEFAULT counter (lazy import), so
// the tests below either use the Semaphore directly or inject a counter — the
// service-role client is never constructed. Dummy creds are set defensively in
// case a future import path pulls it in.
import { assert, assertEquals, assertRejects } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { Semaphore, runAiCall, reserveGlobalDailyBudget, AiCeilingError } =
  await import("../lib/ai-limiter.ts");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

Deno.test("Semaphore bounds concurrency to max", async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const tasks = gates.map((g) =>
    sem.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await g.promise;
      active--;
    })
  );
  // Let the scheduler start whatever it can — only 2 slots exist.
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(sem.inUse, 2);
  assert(sem.waiting >= 1, "extra tasks should be queued");
  // Release one; a queued task takes the freed slot.
  gates[0].resolve();
  await Promise.resolve();
  await Promise.resolve();
  for (const g of gates) g.resolve();
  await Promise.all(tasks);
  assertEquals(peak, 2, "never more than max concurrent");
  assertEquals(sem.inUse, 0);
});

Deno.test("Semaphore.run releases the slot even when fn throws", async () => {
  const sem = new Semaphore(1);
  await assertRejects(() => sem.run(() => Promise.reject(new Error("boom"))));
  // Slot must be free again for the next caller.
  let ran = false;
  await sem.run(() => {
    ran = true;
    return Promise.resolve();
  });
  assert(ran);
  assertEquals(sem.inUse, 0);
});

Deno.test("Semaphore preserves FIFO order among waiters", async () => {
  const sem = new Semaphore(1);
  const order: number[] = [];
  const hold = deferred();
  // First task holds the only slot.
  const first = sem.run(async () => {
    order.push(0);
    await hold.promise;
  });
  // These queue behind it in order.
  const rest = [1, 2, 3].map((n) =>
    sem.run(() => {
      order.push(n);
      return Promise.resolve();
    })
  );
  await Promise.resolve();
  hold.resolve();
  await Promise.all([first, ...rest]);
  assertEquals(order, [0, 1, 2, 3]);
});

Deno.test("reserveGlobalDailyBudget: throws AiCeilingError past the ceiling", async () => {
  Deno.env.set("AI_GLOBAL_DAILY_CALL_CEILING", "3");
  try {
    let count = 0;
    const counter = () => Promise.resolve(++count);
    // counts 1,2,3 are allowed; 4 trips the ceiling.
    await reserveGlobalDailyBudget(counter);
    await reserveGlobalDailyBudget(counter);
    await reserveGlobalDailyBudget(counter);
    await assertRejects(
      () => reserveGlobalDailyBudget(counter),
      AiCeilingError,
    );
  } finally {
    Deno.env.delete("AI_GLOBAL_DAILY_CALL_CEILING");
  }
});

Deno.test("reserveGlobalDailyBudget: ceiling of 0 disables (never throws, never counts)", async () => {
  Deno.env.set("AI_GLOBAL_DAILY_CALL_CEILING", "0");
  try {
    let called = false;
    await reserveGlobalDailyBudget(() => {
      called = true;
      return Promise.resolve(1);
    });
    assert(!called, "disabled ceiling must not even hit the counter");
  } finally {
    Deno.env.delete("AI_GLOBAL_DAILY_CALL_CEILING");
  }
});

Deno.test("reserveGlobalDailyBudget: fails OPEN when the counter store errors", async () => {
  Deno.env.set("AI_GLOBAL_DAILY_CALL_CEILING", "1");
  try {
    // A DB blip must not halt grading — the concurrency cap still protects us.
    await reserveGlobalDailyBudget(() => Promise.reject(new Error("store down")));
  } finally {
    Deno.env.delete("AI_GLOBAL_DAILY_CALL_CEILING");
  }
});

Deno.test("runAiCall: runs fn under the limiter and returns its value", async () => {
  Deno.env.set("AI_GLOBAL_DAILY_CALL_CEILING", "0"); // disable ceiling for this unit
  try {
    const out = await runAiCall(() => Promise.resolve("ok"), {
      retrySleep: () => Promise.resolve(),
    });
    assertEquals(out, "ok");
  } finally {
    Deno.env.delete("AI_GLOBAL_DAILY_CALL_CEILING");
  }
});

Deno.test("runAiCall: retries a retryable error then succeeds (retry.ts wired)", async () => {
  Deno.env.set("AI_GLOBAL_DAILY_CALL_CEILING", "0");
  Deno.env.set("AI_MAX_RETRIES", "2");
  try {
    let calls = 0;
    const out = await runAiCall(
      () => {
        calls++;
        if (calls < 2) {
          const e = new Error("rate limit") as Error & { status: number };
          e.status = 429;
          return Promise.reject(e);
        }
        return Promise.resolve("recovered");
      },
      { skipCeiling: true, retrySleep: () => Promise.resolve() },
    );
    assertEquals(out, "recovered");
    assertEquals(calls, 2);
  } finally {
    Deno.env.delete("AI_GLOBAL_DAILY_CALL_CEILING");
    Deno.env.delete("AI_MAX_RETRIES");
  }
});

Deno.test("runAiCall: surfaces AiCeilingError before running fn", async () => {
  Deno.env.set("AI_GLOBAL_DAILY_CALL_CEILING", "1");
  try {
    let ran = false;
    await assertRejects(
      () =>
        runAiCall(
          () => {
            ran = true;
            return Promise.resolve("x");
          },
          { counter: () => Promise.resolve(2), retrySleep: () => Promise.resolve() },
        ),
      AiCeilingError,
    );
    assert(!ran, "fn must not run once the ceiling is hit");
  } finally {
    Deno.env.delete("AI_GLOBAL_DAILY_CALL_CEILING");
  }
});
