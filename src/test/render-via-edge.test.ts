// US-2619: the Pages-side half of the card fix, and its fallback behaviour.
//
// WHY THIS NEEDS TESTS AT ALL. The whole claim that this was safe to ship
// before US-2612 is finished rests on one property: **every failure path
// returns the branded fallback**, which is exactly what these three routes
// already serve. If any path threw, or returned an empty 200, shipping early
// would regress a live surface rather than leave it unchanged. So the fallback
// is not a detail here, it is the safety argument.
//
// Structural rather than executed. `render-via-edge.ts` imports
// `brandedFallbackResponse`, which reaches for `fetch` against the site origin,
// and `PagesFunction` types that only exist in the Cloudflare runtime. Standing
// up that much of a Worker to assert control flow would test the harness. The
// repo's own idiom for this is a source-shape assertion — cf.
// `upgrade-confirmation-gate_test.ts`, which pins a payments gate the same way.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "functions/_shared/render-via-edge.ts"),
  "utf8",
);

/** Body of `renderViaEdge`, brace-matched from its signature. */
function fnBody(): string {
  const start = SRC.indexOf("export async function renderViaEdge");
  expect(start, "renderViaEdge was renamed or removed").toBeGreaterThan(-1);
  let depth = 0;
  let i = SRC.indexOf("{", start);
  const from = i;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") {
      depth--;
      if (depth === 0) return SRC.slice(from, i + 1);
    }
  }
  throw new Error("could not brace-match renderViaEdge");
}

describe("US-2619: renderViaEdge fails to the branded card, never to a broken one", () => {
  it("every failure path returns the branded fallback", () => {
    const body = fnBody();
    // Four ways this can fail, and each must reach the same place. Counted
    // rather than merely present: one shared `catch` would satisfy a
    // "contains brandedFallbackResponse" assertion while an early return
    // path threw.
    const calls = (body.match(/brandedFallbackResponse\(/g) ?? []).length;
    expect(
      calls,
      "expected a fallback for: no secret on this side, a non-ok response, an " +
        "empty body, and the catch. Fewer means a path that does not fall back.",
    ).toBeGreaterThanOrEqual(4);
  });

  it("it buffers before responding, rather than streaming", () => {
    // US-2620's defect: a streamed body that fails mid-flight lands AFTER the
    // Response is constructed, so the caller's try/catch cannot see it and the
    // client gets a 200 with nothing in it. That is how blank previews shipped.
    const body = fnBody();
    expect(body).toMatch(/await res\.arrayBuffer\(\)/);
    expect(body).toMatch(/byteLength === 0/);
    // And the buffer, not the live body, is what goes back.
    expect(body).toMatch(/new Response\(buf/);
  });

  it("it sends the origin header and skips the call without a secret", () => {
    const body = fnBody();
    expect(body).toMatch(/"x-pages-origin": secret/);
    // The early return matters for noise as much as correctness: without it
    // every request earns its own 401 in the log while the secret is half-set,
    // which is the state production is in right now.
    const guard = body.indexOf("if (!secret)");
    const call = body.indexOf("fetch(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard, "the no-secret check must come before the round trip").toBeLessThan(call);
  });

  it("it bounds the wait", () => {
    // A crawler held open is worse than a branded card.
    expect(fnBody()).toMatch(/signal: controller\.signal/);
    expect(SRC).toMatch(/RENDER_TIMEOUT_MS\s*=\s*\d+/);
  });

  it("the three converted routes no longer render in-Function", () => {
    // The point of the change, asserted where it can regress: someone adding a
    // workers-og render back to one of these would undo it silently.
    const converted = [
      "functions/og/social/card.ts",
      "functions/og/blog/[slug].ts",
      "functions/og/verified/[handle].ts",
    ];
    const offenders = converted.filter((f) => {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      return src.includes("new ImageResponse") || !src.includes("renderViaEdge(env");
    });
    expect(
      offenders,
      "these were converted to render on the edge. A workers-og render here is " +
        "the failure this story exists to fix.",
    ).toEqual([]);
  });
});
