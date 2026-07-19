// US-2089 (C4): every path that changes tenant scope must drop the query cache.
//
// THE INVARIANT, and why it is enforced here rather than in the query keys:
// dozens of workspace/user-scoped TanStack keys deliberately omit the owner id
// (automation_rules, repricing suggestions, google_connection, most of
// use-ebay.ts — see the US-1624 comment in use-workspace.ts). Threading an owner
// through all of them was considered and rejected; the cache clear IS the
// isolation mechanism for those keys.
//
// That makes the clear load-bearing SECURITY code, not a nicety — and it lives
// in three unrelated files, which is exactly the shape that rots. There are
// three ways the scope changes:
//
//   1. SIGN-OUT        → use-auth.ts, on the SIGNED_OUT branch
//   2. WORKSPACE SWITCH → use-workspace.ts switchWorkspace()
//   3. IMPERSONATION   → impersonation.ts, both entering AND exiting
//
// (3) was MISSING until US-2089. It is the subtle one: verifyOtp() swaps
// sessions by firing SIGNED_IN with a DIFFERENT user, so it takes the
// `if (newSession?.user)` branch in onAuthStateChange and never reaches the
// SIGNED_OUT clear. The exit direction is the worse of the two — a support
// admin would be served the customer's cached data in their own session.
//
// If a FOURTH way to change scope appears, this test is the thing that should
// make someone think about it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("US-2089: tenant-scope changes clear the query cache", () => {
  it("sign-out clears it", () => {
    const src = read("src/hooks/use-auth.ts");
    expect(src).toMatch(/queryClient\.clear\(\)/);
  });

  it("a workspace switch clears it", () => {
    const src = read("src/hooks/use-workspace.ts");
    expect(src).toMatch(/queryClient\.clear\(\)/);
  });

  // The one that was missing. Both directions, because entering leaks the
  // admin's data into the target's session and exiting leaks the target's data
  // into the admin's — and the second is worse.
  it("impersonation clears it on BOTH entry and exit", () => {
    const src = read("src/lib/impersonation.ts");
    const clears = src.match(/queryClient\.clear\(\)/g) ?? [];
    expect(
      clears.length,
      "impersonation must clear the cache when starting AND when stopping — " +
        "verifyOtp fires SIGNED_IN with a different user, so onAuthStateChange " +
        "never reaches the SIGNED_OUT clear",
    ).toBe(2);

    // Ordering matters: clear BEFORE the session swap, so no request issued
    // under the new identity can be served from the old identity's cache.
    const startIdx = src.indexOf("export async function startImpersonation");
    const stopIdx = src.indexOf("export async function stopImpersonation");
    const startBody = src.slice(startIdx, stopIdx);
    const stopBody = src.slice(stopIdx);
    for (const [name, body] of [["start", startBody], ["stop", stopBody]] as const) {
      const clearAt = body.indexOf("queryClient.clear()");
      // Anchor on the CALL, not the bare word: the comments above these lines
      // explain the verifyOtp behaviour, and matching prose instead of code
      // made this assertion fail against correct source on first run.
      const swapAt = body.indexOf("supabase.auth.verifyOtp");
      expect(clearAt, `${name}Impersonation must clear the cache`).toBeGreaterThan(-1);
      expect(
        clearAt,
        `${name}Impersonation must clear BEFORE the verifyOtp session swap`,
      ).toBeLessThan(swapAt);
    }
  });
});
