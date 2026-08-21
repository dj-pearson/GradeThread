// US-2755: the plan gate and the AI quota now run concurrently, so something
// has to decide which refusal the caller sees when both fail.
//
// The failure this guards is not a crash. It is a seller on an expired plan
// being told "monthly AI limit reached" — a message about a different problem,
// with a different fix, that sends them to top up an allowance they cannot use.

import "./_env.ts";
import { assertEquals } from "@std/assert";
import { whichRefusal } from "../lib/gate-order.ts";

Deno.test("both passing means no refusal", () => {
  assertEquals(whichRefusal(false, true), null);
});

Deno.test("the plan gate alone refuses", () => {
  assertEquals(whichRefusal(true, true), "gate");
});

Deno.test("the quota alone refuses", () => {
  assertEquals(whichRefusal(false, false), "quota");
});

Deno.test("BOTH failing returns the plan gate, exactly as the sequential code did", () => {
  // The behaviour-preserving case, and the whole reason this is a named rule.
  // Sequentially, requireFlipdesk returned first and the quota check was never
  // reached. Concurrently both answers arrive, and the plan gate must still win
  // — a quota only means something inside a plan that grants one.
  assertEquals(whichRefusal(true, false), "gate");
});

Deno.test("the rule is total: every combination has an answer", () => {
  for (const gate of [true, false]) {
    for (const quota of [true, false]) {
      const out = whichRefusal(gate, quota);
      assertEquals(
        out === "gate" || out === "quota" || out === null,
        true,
        `whichRefusal(${gate}, ${quota}) returned something unexpected`,
      );
    }
  }
});

// ── the route actually runs them together ──────────────────────────────────

Deno.test("the /appraise handler awaits the gate and the quota concurrently", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-scout.ts", import.meta.url),
  );
  const start = src.indexOf('flipdeskScoutRoutes.post("/appraise", ');
  const end = src.indexOf('flipdeskScoutRoutes.post("/appraise-url"');
  const handler = src.slice(start, end);

  // Scoped to this handler: the file has five of these pairs and a file-wide
  // search would pass on any one of them being right.
  const seq = /const gate = await requireFlipdesk\(/.test(handler);
  assertEquals(
    seq,
    false,
    "the /appraise handler still awaits requireFlipdesk on its own line, so the " +
      "quota check is still queued behind it",
  );
  assertEquals(
    /Promise\.all\(\[[\s\S]{0,200}requireFlipdesk\(/.test(handler),
    true,
    "the gate and quota are no longer started together",
  );
  assertEquals(
    /whichRefusal\(/.test(handler),
    true,
    "the handler no longer uses the named precedence rule, so which refusal wins " +
      "is back to being implicit in statement order",
  );
});

Deno.test("reserving an AI action still happens AFTER both checks", async () => {
  // Reserving for a request that is about to be refused would charge a seller
  // for work that never runs. The refund path exists for a grade that throws,
  // not for a gate that was always going to say no.
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-scout.ts", import.meta.url),
  );
  const start = src.indexOf('flipdeskScoutRoutes.post("/appraise", ');
  const end = src.indexOf('flipdeskScoutRoutes.post("/appraise-url"');
  const handler = src.slice(start, end);

  const refusalAt = handler.indexOf("whichRefusal(");
  const reserveAt = handler.indexOf("reserveAiActionSafe(");
  assertEquals(refusalAt !== -1 && reserveAt !== -1, true, "could not find both calls");
  assertEquals(
    refusalAt < reserveAt,
    true,
    "an AI action is reserved before the refusals are resolved",
  );
});
