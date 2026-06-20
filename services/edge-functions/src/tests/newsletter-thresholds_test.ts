import { assertEquals } from "@std/assert";
import {
  DEFAULT_DELIVERABILITY_THRESHOLDS,
  evaluateDeliverability,
} from "../lib/newsletter-thresholds.ts";

const base = {
  sent: 1000,
  openRate: 0.4,
  bounceRate: 0.0,
  complaintRate: 0.0,
  unsubRate: 0.0,
};

Deno.test("healthy metrics → ok, no flags, no auto-pause", () => {
  const r = evaluateDeliverability(base);
  assertEquals(r.status, "ok");
  assertEquals(r.flags.length, 0);
  assertEquals(r.shouldAutoPause, false);
});

Deno.test("zero volume is never judged", () => {
  const r = evaluateDeliverability({ ...base, sent: 0, openRate: 0, bounceRate: 1 });
  assertEquals(r.status, "ok");
  assertEquals(r.flags.length, 0);
  assertEquals(r.shouldAutoPause, false);
});

Deno.test("complaint rate over threshold is critical + auto-pause", () => {
  const r = evaluateDeliverability({ ...base, complaintRate: 0.0015 });
  assertEquals(r.status, "critical");
  assertEquals(r.shouldAutoPause, true);
  assertEquals(r.flags[0]?.metric, "complaintRate");
  assertEquals(r.flags[0]?.severity, "critical");
});

Deno.test("bounce rate over threshold is critical + auto-pause", () => {
  const r = evaluateDeliverability({ ...base, bounceRate: 0.03 });
  assertEquals(r.status, "critical");
  assertEquals(r.shouldAutoPause, true);
  assertEquals(r.flags[0]?.metric, "bounceRate");
});

Deno.test("high unsub + low open are warnings only (no auto-pause)", () => {
  const r = evaluateDeliverability({ ...base, openRate: 0.05, unsubRate: 0.01 });
  assertEquals(r.status, "warning");
  assertEquals(r.shouldAutoPause, false);
  assertEquals(r.flags.length, 2);
  assertEquals(r.flags.every((f) => f.severity === "warning"), true);
});

Deno.test("exactly at threshold does not flag (strictly-greater)", () => {
  const r = evaluateDeliverability({
    ...base,
    complaintRate: DEFAULT_DELIVERABILITY_THRESHOLDS.complaintRate,
    bounceRate: DEFAULT_DELIVERABILITY_THRESHOLDS.bounceRate,
  });
  assertEquals(r.status, "ok");
  assertEquals(r.flags.length, 0);
});

Deno.test("custom (tightened) thresholds are honored", () => {
  const r = evaluateDeliverability(
    { ...base, bounceRate: 0.011 },
    { ...DEFAULT_DELIVERABILITY_THRESHOLDS, bounceRate: 0.01 },
  );
  assertEquals(r.status, "critical");
  assertEquals(r.flags[0]?.metric, "bounceRate");
});
