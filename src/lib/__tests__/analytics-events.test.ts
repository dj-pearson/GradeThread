import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_EVENTS,
} from "../analytics-events";
import {
  BUYER_FUNNEL_STEPS,
  buyerFunnelEventName,
} from "../buyer-analytics";

// US-2446. The registry is enforced by `tsc -b` — but ONLY for as long as
// `track()` keeps its narrow parameter type. Widen it back to `string` and every
// call site silently type-checks again while this suite stays green, which is the
// exact failure the registry was built to prevent. So these tests guard the
// GUARD, in both directions:
//
//   forward  — no literal reaches track() that the registry doesn't declare
//              (tsc's job; asserted here so a widened signature is caught)
//   backward — no registry entry sits there unemitted, going stale
//
// The backward direction matters more than it looks. A registry that only ever
// grows becomes a list of names that USED to be sent, and then it is worse than
// nothing: someone reads it, builds a dashboard on an entry, and waits for data
// that stopped flowing months ago.

const SRC = join(process.cwd(), "src");
const REGISTRY_FILE = join("lib", "analytics-events.ts");

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (/\.tsx?$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(SRC);
  return out;
}

const FILES = sourceFiles().map((path) => ({
  path,
  rel: path.slice(SRC.length + 1),
  text: readFileSync(path, "utf8"),
}));

// Files that legitimately mention names without emitting them.
const NON_EMITTING = (rel: string) =>
  rel.endsWith(REGISTRY_FILE) ||
  rel.includes("__tests__") ||
  rel.includes(join("test", "")) ||
  /\.test\.tsx?$/.test(rel);

describe("analytics event registry (US-2446)", () => {
  it("declares every literal name passed to track()", () => {
    const declared = new Set<string>(ANALYTICS_EVENT_NAMES);
    const undeclared: string[] = [];

    for (const f of FILES) {
      if (NON_EMITTING(f.rel)) continue;
      for (const m of f.text.matchAll(/\btrack\(\s*"([^"]+)"/g)) {
        const name = m[1]!;
        if (!declared.has(name)) undeclared.push(`${f.rel}: ${name}`);
      }
    }

    expect(undeclared).toEqual([]);
  });

  it("keeps track() typed against the registry, not string", () => {
    // If this fails, tsc has stopped enforcing the registry and every other
    // assertion in this file is measuring nothing.
    const analytics = readFileSync(join(SRC, "lib", "analytics.ts"), "utf8");
    expect(analytics).toMatch(/export function track\(\s*event: AnalyticsEvent/);
    expect(analytics).not.toMatch(/export function track\(\s*event: string/);
  });

  it("has no entry that nothing in the codebase emits", () => {
    const orphans: string[] = [];

    for (const name of ANALYTICS_EVENT_NAMES) {
      const quoted = `"${name}"`;
      const emitted = FILES.some((f) => !NON_EMITTING(f.rel) && f.text.includes(quoted));
      if (!emitted) orphans.push(name);
    }

    expect(orphans).toEqual([]);
  });

  it("gives every event a note that says what it observes", () => {
    const empty = Object.entries(ANALYTICS_EVENTS)
      .filter(([, note]) => note.trim().length < 15)
      .map(([name]) => name);
    expect(empty).toEqual([]);
  });

  it("declares BOTH naming conventions, because both are live", () => {
    // Not an aesthetic assertion. If a future edit "tidies" the dotted money
    // events into snake_case, the PostHog history behind every subscription and
    // credit-pack chart is orphaned on the same day. This fails first.
    const dotted = ANALYTICS_EVENT_NAMES.filter((n) => n.includes("."));
    const snake = ANALYTICS_EVENT_NAMES.filter((n) => !n.includes("."));
    expect(dotted.length).toBeGreaterThan(0);
    expect(snake.length).toBeGreaterThan(0);
    // The money surfaces are the dotted ones. Spot-check the load-bearing names.
    for (const n of ["subscription.paused", "credit_pack.purchased", "grade.paid"]) {
      expect(ANALYTICS_EVENT_NAMES).toContain(n);
    }
    for (const n of ["cert_share", "referral_share", "reward_celebration_shown"]) {
      expect(ANALYTICS_EVENT_NAMES).toContain(n);
    }
  });

  it("builds a legal event name for every buyer funnel step", () => {
    // The template-literal family is the one part tsc checks structurally rather
    // than against a list, so assert the generator and the type agree in fact.
    let checked = 0;
    for (const step of BUYER_FUNNEL_STEPS) {
      const name = buyerFunnelEventName(step);
      expect(name).toBe(`buyer_funnel_${step}`);
      checked++;
    }
    expect(buyerFunnelEventName("claim_dismissed")).toBe("buyer_funnel_claim_dismissed");
    expect(checked).toBe(BUYER_FUNNEL_STEPS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("never declares the same name twice under two spellings of one idea", () => {
    // Cheap proxy: no two names differing only by dots-vs-underscores.
    const normalized = new Map<string, string[]>();
    for (const n of ANALYTICS_EVENT_NAMES) {
      const k = n.replace(/[._]/g, "");
      normalized.set(k, [...(normalized.get(k) ?? []), n]);
    }
    const collisions = [...normalized.values()].filter((v) => v.length > 1);
    expect(collisions).toEqual([]);
  });
});
