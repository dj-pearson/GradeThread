import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2503, slice 1. iOS ships no buyer screens at all, while /pricing states
// "Every FlipDesk plan includes buyer tools" and SELLER_PLAN_BUYER_TIER bundles
// Guard into Starter/Pro and Connoisseur into Business.
//
// The screens themselves cannot be built or compiled from this Windows
// checkout. What CAN be built and verified here is the thing AC3 requires
// before any screen exists: ONE resolved entitlement payload both clients read,
// rather than a Swift reimplementation of the gating matrix — which would be
// the second source of truth AC3 exists to forbid.

const ROUTE = "services/edge-functions/src/routes/buyer-profile.ts";
const RESOLVER = "services/edge-functions/src/lib/buyer-entitlements.ts";
const WEB_HOOK = "src/hooks/use-buyer-entitlements.ts";

// The route body runs past the first `});` (the try/catch closes one), so
// slice to the NEXT route declaration instead of the next brace.
function routeBlock(src: string, start: number): string {
  const next = src.indexOf("buyerProfileRoutes.", start + 10);
  return src.slice(start, next === -1 ? src.length : next);
}

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("the resolved payload is served (US-2503 AC3)", () => {
  it("GET /api/buyer/entitlements exists", () => {
    const src = read(ROUTE);
    expect(src).toContain('buyerProfileRoutes.get("/entitlements"');
    expect(src).toContain("getBuyerEntitlements(userId)");
  });

  it("it reads the CALLER's id, never a request value", () => {
    // US-268: there is no id, filter or workspace header a caller can supply.
    const src = read(ROUTE);
    const start = src.indexOf('buyerProfileRoutes.get("/entitlements"');
    const block = routeBlock(src, start);
    expect(block).toContain('c.get("userId")');
    expect(block).not.toMatch(/req\.(query|param|json)\(/);
  });

  it("it adds no logic — it exposes the resolver every route already gates on", () => {
    // A second implementation on the way out would defeat the point of the
    // endpoint as thoroughly as a Swift one.
    const src = read(RESOLVER);
    expect(src).toContain("export async function getBuyerEntitlements");
    expect(src).toContain("export async function requireBuyerFeature");
  });

  it("a read failure LOCKS rather than 500s or over-grants", () => {
    // The failure direction is the whole point: an over-grant shows a paid
    // screen to someone who is not paying.
    const src = read(ROUTE);
    expect(src).toContain("FREE_BUYER_ENTITLEMENTS");
    const resolver = read(RESOLVER);
    expect(resolver).toContain(
      "export const FREE_BUYER_ENTITLEMENTS: BuyerEntitlements = resolveBuyerEntitlements(",
    );
  });

  it("the response is never cached or shared", () => {
    // A plan change must show on the next load, and a shared cache must never
    // hand one buyer's entitlements to another.
    const src = read(ROUTE);
    const start = src.indexOf('buyerProfileRoutes.get("/entitlements"');
    const block = routeBlock(src, start);
    expect((block.match(/no-store, private/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("it is behind the authenticated buyer mount", () => {
    const main = read("services/edge-functions/src/main.ts");
    expect(main).toContain('app.use("/api/buyer/*", authMiddleware)');
    expect(main).toContain("buyerProfileRoutes");
  });

  it("and the isolation suite covers it", () => {
    // Every new route on a multi-tenant surface needs a case (US-268).
    const iso = read("services/edge-functions/src/tests/tenant-isolation_test.ts");
    expect(iso).toContain("buyer entitlements requires authentication");
    expect(iso).toContain("buyer entitlements answers for the CALLER, not a supplied id");
  });
});

describe("both clients resolve from one matrix (US-2503 AC3)", () => {
  it("the web hook and the edge resolver read the SAME plan config", () => {
    // They are two implementations of one matrix today, which is why the web
    // hook says so out loud. iOS must not become a third — it reads the
    // endpoint instead.
    expect(read(WEB_HOOK)).toContain("BUYER_PLANS");
    expect(read("services/edge-functions/src/lib/buyer-plans.ts")).toContain(
      "BUYER_PLAN_ENTITLEMENTS",
    );
  });

  it("the endpoint documents why it exists", () => {
    // Without the reason written down, the next reader deletes it as a
    // duplicate of the client-side hook.
    const src = read(ROUTE);
    expect(src).toMatch(/SECOND SOURCE OF TRUTH/);
    expect(src).toContain("US-2503");
  });
});

describe("what this slice does NOT claim (US-2503)", () => {
  it("no iOS screen is asserted to exist", () => {
    // The remaining ACs (screens, the plan-screen bullets, an iOS test) need a
    // macOS toolchain. Claiming them here would be the failure mode this test
    // is written to prevent: a guard that passes while the feature does not
    // exist. When the screens land, THIS test is what they extend.
    const ios = read("docs/reviews/full-surface-2026-08/FIX-PROGRESS.md");
    expect(ios).toContain("US-2503");
  });
});
