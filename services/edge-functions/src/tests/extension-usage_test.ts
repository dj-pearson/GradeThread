// US-1757 (AC2): extension usage-telemetry validation (pure). No DB.
//
// THE POINT OF THESE TESTS. The toggle in the popup says the counts are
// anonymous. That promise is not enforceable by reviewing the extension —
// extension code is client code, fully under the control of whoever installed
// it (or of anyone who modified the build). The SERVER has to be the thing that
// refuses to store an identifier. So the cases below are mostly hostile-client
// cases: what happens when the body is not what our own extension would send.
//
// The second half of the file is the CLIENT ⇄ SERVER vocabulary lockstep. The
// event and surface lists exist in two files that never import each other, and a
// drift there is silent in the worst possible way — the extension keeps sending,
// the endpoint keeps returning 204, and the counter simply never appears in the
// table. That is a funnel number that reads as "zero" instead of "broken".
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { parseUsagePing } = await import("../routes/public-grading.ts");

// ── happy path ──────────────────────────────────────────────────────────────

Deno.test("usage: accepts a well-formed tally", () => {
  const out = parseUsagePing({
    counts: { read: 12, "click_through:overlay": 3 },
    extVersion: "0.8.0",
  });
  assertEquals(out?.extVersion, "0.8.0");
  assertEquals(out?.counters.length, 2);
  const read = out?.counters.find((x) => x.event === "read");
  assertEquals(read?.surface, null, "a read has no surface, and must not invent one");
  assertEquals(read?.count, 12);
  const click = out?.counters.find((x) => x.event === "click_through");
  assertEquals(click?.surface, "overlay");
  assertEquals(click?.count, 3);
});

// ── hostile bodies ──────────────────────────────────────────────────────────

Deno.test("usage: an unknown event or surface is dropped, not stored", () => {
  // Only the one legitimate counter survives; the invented ones are gone.
  const out = parseUsagePing({
    counts: {
      read: 1,
      browsed_to: 40,
      "click_through:private-page": 9,
      "read:overlay:https://ebay.com/itm/1": 2,
    },
  });
  assertEquals(out?.counters.length, 1);
  assertEquals(out?.counters[0].event, "read");
});

Deno.test("usage: a URL cannot be smuggled through any field", () => {
  // There is deliberately no free-text column. Every place a string lands is
  // either a closed vocabulary or the charset-capped version — so this body,
  // which tries all of them at once, must store nothing identifying.
  const out = parseUsagePing({
    counts: { "click_through:https://www.ebay.com/itm/1": 1, "read": 1 },
    extVersion: "https://evil.test/?install=7f3c",
    listingUrl: "https://www.ebay.com/itm/1",
    instanceId: "gt-abc-123",
    userId: "00000000-0000-0000-0000-000000000000",
  });
  assertEquals(out?.counters.length, 1);
  assertEquals(out?.counters[0].event, "read");
  assertEquals(out?.extVersion, null, "an over-long / non-version string must not be stored");
  // The parser's OUTPUT is the whole insert; extra keys on the request body have
  // nowhere to go by construction, not by filtering.
  assertEquals(Object.keys(out ?? {}).sort(), ["counters", "extVersion"]);
});

Deno.test("usage: counts are clamped and non-positive ones dropped", () => {
  const out = parseUsagePing({
    counts: {
      read: 1e9,
      "click_through:popup": 0,
      "click_through:flip": -5,
      "click_through:onboarding": 2.9,
    },
  });
  const byEvent = Object.fromEntries(
    (out?.counters ?? []).map((x) => [`${x.event}:${x.surface}`, x.count]),
  );
  assertEquals(byEvent["read:null"], 999, "the server clamps too — the client's cap is a courtesy");
  assertEquals(byEvent["click_through:popup"], undefined);
  assertEquals(byEvent["click_through:flip"], undefined);
  assertEquals(byEvent["click_through:onboarding"], 2, "a fractional count floors, never rounds up");
});

Deno.test("usage: rejects a ping carrying no signal", () => {
  // An empty tally still says "this install exists and ran today" — a heartbeat.
  // Nobody consented to a heartbeat, so it is refused rather than recorded.
  assertEquals(parseUsagePing({ counts: {} }), null);
  assertEquals(parseUsagePing({ counts: { browsed: 3 } }), null);
  assertEquals(parseUsagePing({ counts: { read: 0 } }), null);
});

Deno.test("usage: rejects junk bodies without throwing", () => {
  for (
    const body of [
      null,
      undefined,
      "read",
      42,
      [],
      {},
      { counts: null },
      { counts: [] },
      { counts: "read=1" },
    ]
  ) {
    assertEquals(parseUsagePing(body), null, `body ${JSON.stringify(body)} must parse to null`);
  }
});

Deno.test("usage: a flooded key list is refused wholesale", () => {
  // A well-formed batch cannot exceed events × (surfaces + 1). Anything longer
  // is not our extension, so it is dropped entirely rather than partially
  // accepted — partial acceptance would let a caller pad a real tally with junk
  // and still land the real part.
  const counts: Record<string, number> = {};
  for (let i = 0; i < 500; i++) counts[`read:x${i}`] = 1;
  counts.read = 5;
  assertEquals(parseUsagePing({ counts }), null);
});

// ── the client ⇄ server vocabulary lockstep ────────────────────────────────

Deno.test("usage: every event/surface the extension can send is accepted", async () => {
  // Read the SHIPPED extension module rather than restating its lists here.
  // Restating them would recreate exactly the drift this test exists to catch.
  const src = await Deno.readTextFile(
    new URL("../../../../extension-unified/usage-telemetry.js", import.meta.url),
  );
  const list = (name: string): string[] => {
    const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(src);
    assert(m, `usage-telemetry.js must declare ${name}`);
    return Array.from(m![1].matchAll(/"([^"]+)"/g)).map((x) => x[1]);
  };
  const events = list("EVENTS");
  const surfaces = list("SURFACES");
  assert(events.length > 0 && surfaces.length > 0);

  for (const event of events) {
    assert(
      parseUsagePing({ counts: { [event]: 1 } }) !== null,
      `the extension can send "${event}" but /usage rejects it — the ping would 204 ` +
        "and the counter would silently never exist, which reads as a zero rather " +
        "than as a break",
    );
    for (const surface of surfaces) {
      assert(
        parseUsagePing({ counts: { [`${event}:${surface}`]: 1 } }) !== null,
        `the extension can send "${event}:${surface}" but /usage rejects it`,
      );
    }
  }
});

Deno.test("usage: the vocabulary is still CLOSED", () => {
  // The guard on the guard. If someone ever replaces the closed sets with a
  // permissive check, the lockstep test above still passes (everything the
  // client sends is accepted) — this is the half that notices.
  assertEquals(parseUsagePing({ counts: { anything_at_all: 1 } }), null);
  assertEquals(parseUsagePing({ counts: { "read:anywhere": 1 } }), null);
});
