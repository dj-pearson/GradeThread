// US-2690: the background style-code sweep's work-list.
//
// Pure tests — no eBay, no database, and the clock is injected. Every rule that
// decides where a tick spends its budget is asserted here rather than observed
// in production.
import { assert, assertEquals } from "@std/assert";

// style-code-sweep.ts transitively imports the service-role supabase client at
// load (through style-code-observations.ts) — set dummy env BEFORE the dynamic
// import (standard pattern).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  buildSweepWorkList,
  isCoolingOff,
  summarizeSweep,
  sweepOneCode,
  CONFIRMED_SEEN_COUNT,
  HIT_RECHECK_DAYS,
  MISS_COOLDOWN_DAYS,
} = await import("../lib/style-code-sweep.ts");

const CANDIDATE = {
  brandKey: "lululemon",
  brandLabel: "Lululemon",
  styleCodeRaw: "M7A83S",
  styleCodeNorm: "M7A83S",
};

const NOW = new Date("2026-08-19T12:00:00.000Z");

/** An ISO timestamp N days before NOW. */
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

function build(overrides: {
  seen?: { brandKey: string; styleCodeRaw: string }[];
  observations?: { brand_key: string; style_code_norm: string; seen_count: number }[];
  sweeps?: {
    brand_key: string;
    style_code_norm: string;
    titles_found: number;
    last_swept_at: string;
  }[];
  budget?: number;
} = {}) {
  return buildSweepWorkList({
    seen: overrides.seen ?? [],
    observations: overrides.observations ?? [],
    sweeps: overrides.sweeps ?? [],
    budget: overrides.budget ?? 100,
    now: NOW,
  });
}

Deno.test("US-2690: distinct codes survive, and the same code seen twice is one candidate", () => {
  const list = build({
    seen: [
      { brandKey: "lululemon", styleCodeRaw: "LW7DVCS" },
      { brandKey: "lululemon", styleCodeRaw: "lw7d-vcs" }, // same code, different spelling
      { brandKey: "lululemon", styleCodeRaw: "M7A83S" },
    ],
  });
  assertEquals(list.considered, 2);
  assertEquals(list.candidates.length, 2);
  // The first raw spelling is the one kept for display.
  const codes = list.candidates.map((c) => c.styleCodeRaw).sort();
  assertEquals(codes, ["LW7DVCS", "M7A83S"]);
});

Deno.test("US-2690: the same code under two brands is two candidates", () => {
  // Codes collide across brand namespaces, which is why the index is brand-scoped.
  const list = build({
    seen: [
      { brandKey: "lululemon", styleCodeRaw: "AB1234" },
      { brandKey: "patagonia", styleCodeRaw: "AB1234" },
    ],
  });
  assertEquals(list.considered, 2);
  assertEquals(list.candidates.length, 2);
});

Deno.test("US-2690: a code too short to be an identity is skipped, not swept", () => {
  const list = build({
    seen: [
      { brandKey: "lululemon", styleCodeRaw: "AB" },
      { brandKey: "lululemon", styleCodeRaw: "6" },
      { brandKey: "lululemon", styleCodeRaw: "M7A83S" },
    ],
  });
  assertEquals(list.skippedTooShort, 2);
  assertEquals(list.candidates.length, 1);
});

Deno.test("US-2690: a well-confirmed code is not asked again", () => {
  const list = build({
    seen: [{ brandKey: "lululemon", styleCodeRaw: "M7A83S" }],
    observations: [
      {
        brand_key: "lululemon",
        style_code_norm: "M7A83S",
        seen_count: CONFIRMED_SEEN_COUNT,
      },
    ],
  });
  assertEquals(list.skippedConfirmed, 1);
  assertEquals(list.candidates, []);
});

Deno.test("US-2690: one sighting short of the floor is still worth asking about", () => {
  const list = build({
    seen: [{ brandKey: "lululemon", styleCodeRaw: "M7A83S" }],
    observations: [
      {
        brand_key: "lululemon",
        style_code_norm: "M7A83S",
        seen_count: CONFIRMED_SEEN_COUNT - 1,
      },
    ],
  });
  assertEquals(list.skippedConfirmed, 0);
  assertEquals(list.candidates.length, 1);
});

Deno.test("US-2690: a code the market had nothing for is not re-asked inside the cooldown", () => {
  const swept = {
    brand_key: "lululemon",
    style_code_norm: "M7A83S",
    titles_found: 0,
    last_swept_at: daysAgo(MISS_COOLDOWN_DAYS - 1),
  };
  const cooling = build({
    seen: [{ brandKey: "lululemon", styleCodeRaw: "M7A83S" }],
    sweeps: [swept],
  });
  assertEquals(cooling.skippedCooldown, 1);
  assertEquals(cooling.candidates, []);

  // One day past the window and it is fair game again.
  const expired = build({
    seen: [{ brandKey: "lululemon", styleCodeRaw: "M7A83S" }],
    sweeps: [{ ...swept, last_swept_at: daysAgo(MISS_COOLDOWN_DAYS + 1) }],
  });
  assertEquals(expired.skippedCooldown, 0);
  assertEquals(expired.candidates.length, 1);
});

Deno.test("US-2690: a code that DID resolve waits far longer before a recheck", () => {
  const hit = {
    brand_key: "lululemon",
    style_code_norm: "M7A83S",
    titles_found: 2,
    last_swept_at: daysAgo(MISS_COOLDOWN_DAYS + 1),
  };
  // Past the MISS window, nowhere near the HIT window.
  assert(isCoolingOff(hit, NOW));
  assert(!isCoolingOff({ ...hit, titles_found: 0 }, NOW));
  assert(!isCoolingOff({ ...hit, last_swept_at: daysAgo(HIT_RECHECK_DAYS + 1) }, NOW));
});

Deno.test("US-2690: never-swept codes go first, then the ones swept longest ago", () => {
  const list = build({
    seen: [
      { brandKey: "lululemon", styleCodeRaw: "RECENT01" },
      { brandKey: "lululemon", styleCodeRaw: "OLDEST01" },
      { brandKey: "lululemon", styleCodeRaw: "NEVER001" },
    ],
    sweeps: [
      {
        brand_key: "lululemon",
        style_code_norm: "RECENT01",
        titles_found: 0,
        last_swept_at: daysAgo(MISS_COOLDOWN_DAYS + 1),
      },
      {
        brand_key: "lululemon",
        style_code_norm: "OLDEST01",
        titles_found: 0,
        last_swept_at: daysAgo(MISS_COOLDOWN_DAYS + 200),
      },
    ],
  });
  assertEquals(
    list.candidates.map((c) => c.styleCodeNorm),
    ["NEVER001", "OLDEST01", "RECENT01"],
  );
});

Deno.test("US-2690: over-budget codes are DEFERRED and counted, never silently dropped", () => {
  const list = build({
    seen: [
      { brandKey: "lululemon", styleCodeRaw: "AAAA0001" },
      { brandKey: "lululemon", styleCodeRaw: "AAAA0002" },
      { brandKey: "lululemon", styleCodeRaw: "AAAA0003" },
    ],
    budget: 2,
  });
  assertEquals(list.candidates.length, 2);
  assertEquals(list.deferred, 1);
  assertEquals(list.considered, 3);
});

Deno.test("US-2690: a zero budget asks nothing and defers everything", () => {
  const list = build({
    seen: [{ brandKey: "lululemon", styleCodeRaw: "AAAA0001" }],
    budget: 0,
  });
  assertEquals(list.candidates, []);
  assertEquals(list.deferred, 1);
});

Deno.test("US-2690: an unparseable last_swept_at reads as never swept, not as fresh", () => {
  // Fail toward doing the work: a corrupt timestamp must not silently retire a
  // code from the sweep forever.
  const list = build({
    seen: [{ brandKey: "lululemon", styleCodeRaw: "M7A83S" }],
    sweeps: [
      {
        brand_key: "lululemon",
        style_code_norm: "M7A83S",
        titles_found: 0,
        last_swept_at: "not-a-date",
      },
    ],
  });
  assertEquals(list.skippedCooldown, 0);
  assertEquals(list.candidates.length, 1);
});

// ── sweeping one code: what happens on a miss, and on an outage ─────────────

function stubDeps(overrides: Record<string, unknown> = {}) {
  const calls = { observed: 0, marked: [] as number[] };
  const deps = {
    search: () => Promise.resolve([{ title: "Lululemon Commission Short 11", url: null }]),
    observe: () => {
      calls.observed++;
      return Promise.resolve(1);
    },
    markSwept: (_c: unknown, titlesFound: number) => {
      calls.marked.push(titlesFound);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, calls };
}

Deno.test("US-2690: a hit is observed and marked swept", async () => {
  const { deps, calls } = stubDeps();
  assertEquals(await sweepOneCode(CANDIDATE, deps as never), "learned");
  assertEquals(calls.observed, 1);
  assertEquals(calls.marked, [1]);
});

Deno.test("US-2690: a MISS is still marked swept — that is what starts the cooldown", () => {
  const { deps, calls } = stubDeps({ search: () => Promise.resolve([]) });
  return sweepOneCode(CANDIDATE, deps as never).then((outcome) => {
    assertEquals(outcome, "no_hits");
    // Nothing to observe, but the attempt is recorded, or 00627 buys nothing.
    assertEquals(calls.observed, 0);
    assertEquals(calls.marked, [0]);
  });
});

Deno.test("US-2690: an eBay outage is NOT marked swept", async () => {
  // "eBay was down" is not evidence about the code. Recording it would put the
  // code on a 30-day cooldown for somebody else's outage.
  const { deps, calls } = stubDeps({
    search: () => Promise.reject(new Error("502 from Browse")),
  });
  assertEquals(await sweepOneCode(CANDIDATE, deps as never), "error");
  assertEquals(calls.marked, []);
  assertEquals(calls.observed, 0);
});

Deno.test("US-2690: a failed write reports an error rather than throwing the tick", async () => {
  const { deps } = stubDeps({
    markSwept: () => Promise.reject(new Error("pg down")),
  });
  assertEquals(await sweepOneCode(CANDIDATE, deps as never), "error");
});

// ── the cron itself: a second tick must do NOTHING ──────────────────────────

Deno.test("US-2690: a tick that cannot take the lock sweeps nothing", async () => {
  Deno.env.set("FLIPDESK_INTERNAL_JOB_SECRET", "test-job-secret");
  const { handleStyleCodeSweepCron } = await import(
    "../routes/jobs-style-code-sweep.ts"
  );

  let searched = 0;
  const deps = {
    search: () => {
      searched++;
      return Promise.resolve([]);
    },
    observe: () => Promise.resolve(1),
    markSwept: () => Promise.resolve(),
  };

  let released = 0;
  const heldLock = () =>
    Promise.resolve({
      acquired: false as const,
      reason: "held by another worker",
      release: () => {
        released++;
        return Promise.resolve();
      },
    });

  const body: Record<string, unknown>[] = [];
  const ctx = {
    req: { header: (name: string) => name === "X-Internal-Job-Secret" ? "test-job-secret" : undefined },
    json: (payload: Record<string, unknown>) => {
      body.push(payload);
      return new Response(JSON.stringify(payload));
    },
  };

  await handleStyleCodeSweepCron(ctx as never, deps as never, heldLock as never);

  assertEquals(body[0]?.skipped, true);
  // The point of the assertion: not a smaller sweep, not a retry. Zero calls.
  assertEquals(searched, 0);
  // And a lock it never took is not released out from under the running tick.
  assertEquals(released, 0);
});

Deno.test("US-2690: the summary counts each outcome exactly once", () => {
  assertEquals(
    summarizeSweep(["learned", "no_hits", "learned", "error", "no_hits", "no_hits"]),
    { learned: 2, noHits: 3, errors: 1 },
  );
  assertEquals(summarizeSweep([]), { learned: 0, noHits: 0, errors: 0 });
});
