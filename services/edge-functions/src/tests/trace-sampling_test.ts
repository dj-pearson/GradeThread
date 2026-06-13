// US-578: edge trace/log sampling — bounds logging/tracing cost.
// Verifies traceSampleRate() parsing/clamping and the deterministic,
// per-correlation-id shouldSampleTrace() decision (errors/100% paths are
// enforced at the call sites in access-log.ts / timed(), not here).
import { assert, assertEquals } from "@std/assert";

const { traceSampleRate, shouldSampleTrace } = await import("../lib/observability.ts");

function withRate(value: string | undefined, fn: () => void) {
  const prev = Deno.env.get("EDGE_TRACE_SAMPLE_RATE");
  if (value === undefined) Deno.env.delete("EDGE_TRACE_SAMPLE_RATE");
  else Deno.env.set("EDGE_TRACE_SAMPLE_RATE", value);
  try {
    fn();
  } finally {
    if (prev === undefined) Deno.env.delete("EDGE_TRACE_SAMPLE_RATE");
    else Deno.env.set("EDGE_TRACE_SAMPLE_RATE", prev);
  }
}

Deno.test("traceSampleRate: unset/blank defaults to 1.0 (log everything)", () => {
  withRate(undefined, () => assertEquals(traceSampleRate(), 1));
  withRate("", () => assertEquals(traceSampleRate(), 1));
  withRate("   ", () => assertEquals(traceSampleRate(), 1));
});

Deno.test("traceSampleRate: invalid value fails open to 1.0", () => {
  withRate("abc", () => assertEquals(traceSampleRate(), 1));
});

Deno.test("traceSampleRate: clamps to [0,1]", () => {
  withRate("0.1", () => assertEquals(traceSampleRate(), 0.1));
  withRate("0", () => assertEquals(traceSampleRate(), 0));
  withRate("1", () => assertEquals(traceSampleRate(), 1));
  withRate("-5", () => assertEquals(traceSampleRate(), 0));
  withRate("9", () => assertEquals(traceSampleRate(), 1));
});

Deno.test("shouldSampleTrace: rate 1 keeps every trace", () => {
  withRate("1", () => {
    for (let i = 0; i < 50; i++) assert(shouldSampleTrace(`id-${i}`));
  });
});

Deno.test("shouldSampleTrace: rate 0 drops every (keyed) trace", () => {
  withRate("0", () => {
    for (let i = 0; i < 50; i++) assertEquals(shouldSampleTrace(`id-${i}`), false);
  });
});

Deno.test("shouldSampleTrace: an unkeyed trace is kept under fractional sampling", () => {
  // At a tiny-but-nonzero rate the hash path would drop almost everything, but
  // a trace with no correlation id can't be sampled coherently, so it's kept.
  withRate("0.0001", () => {
    assert(shouldSampleTrace(undefined));
    assert(shouldSampleTrace(""));
  });
});

Deno.test("shouldSampleTrace: rate 0 is an explicit drop-all (even unkeyed)", () => {
  withRate("0", () => {
    assertEquals(shouldSampleTrace(undefined), false);
    assertEquals(shouldSampleTrace("anything"), false);
  });
});

Deno.test("shouldSampleTrace: deterministic for the same id", () => {
  withRate("0.5", () => {
    const a = shouldSampleTrace("stable-correlation-id");
    for (let i = 0; i < 20; i++) {
      assertEquals(shouldSampleTrace("stable-correlation-id"), a);
    }
  });
});

Deno.test("shouldSampleTrace: ~rate fraction kept across many ids (±5%)", () => {
  withRate("0.1", () => {
    const N = 5000;
    let kept = 0;
    for (let i = 0; i < N; i++) if (shouldSampleTrace(crypto.randomUUID())) kept++;
    const frac = kept / N;
    assert(
      frac > 0.05 && frac < 0.15,
      `expected ~0.1 sampled, got ${frac.toFixed(3)}`,
    );
  });
});
