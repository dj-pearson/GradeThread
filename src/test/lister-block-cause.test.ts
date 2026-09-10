// US-3295: telling a paying seller to buy the plan they already have.
//
// The extension turns the Lister off whenever `capabilities.lister` is false,
// and that is false for two unrelated reasons: the install holds no account
// token, or it holds one and the account is on Free. Every build up to the
// current store release reports both as `needsUpgrade`, so the composer showed
// "Cross-listing needs an active paid FlipDesk plan" — with a link to /pricing —
// to a Business seller whose extension had simply never been connected.
//
// The account's own plan is deliberately NOT consulted to tell them apart
// (US-2720): the extension is the party enforcing the gate, so the extension is
// the party asked. What changed is WHICH question it is asked.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { listerBlockCause } from "@/lib/lister-extension";

const code = (p: string) => readFileSync(p, "utf8");

describe("listerBlockCause", () => {
  it("believes a build that names the cause itself", async () => {
    let asked = 0;
    const cause = await listerBlockCause({ needsSignIn: true }, async () => {
      asked++;
      return {};
    });
    expect(cause).toBe("signin");
    // No ping needed: the extension already answered the question.
    expect(asked).toBe(0);
  });

  it("asks an older build, and reads a connected install as a plan problem", async () => {
    const cause = await listerBlockCause(
      { needsUpgrade: true },
      async () => ({ capabilities: { authenticated: true, sellerEnabled: false } }),
    );
    expect(cause).toBe("plan");
  });

  it("asks an older build, and reads an unconnected install as a sign-in problem", async () => {
    const cause = await listerBlockCause(
      { needsUpgrade: true },
      async () => ({ capabilities: { authenticated: false, sellerEnabled: false } }),
    );
    expect(cause).toBe("signin");
  });

  it("treats a silent or broken extension as unconnected, never as unpaid", async () => {
    // The asymmetry is the point. Sending a connected Free seller to Connect
    // costs them a click. Sending a Business seller to /pricing tells them the
    // product does not know what they pay for, which is the failure that
    // actually happened.
    expect(await listerBlockCause({ needsUpgrade: true }, async () => ({}))).toBe("signin");
    expect(
      await listerBlockCause({ needsUpgrade: true }, async () => ({ capabilities: {} })),
    ).toBe("signin");
    expect(
      await listerBlockCause({ needsUpgrade: true }, async () => {
        throw new Error("port closed");
      }),
    ).toBe("signin");
  });

  it("does not accept a truthy non-true `authenticated`", async () => {
    const cause = await listerBlockCause(
      { needsUpgrade: true },
      async () => ({ capabilities: { authenticated: "yes" } }),
    );
    expect(cause).toBe("signin");
  });
});

describe("the composer routes each cause to its own fix", () => {
  const KIT = "src/components/flipdesk/listing-kit.tsx";

  it("keeps both flags on the wire, so an older extension still lands somewhere", () => {
    const src = code(KIT);
    expect(src).toContain("res.needsUpgrade || res.needsSignIn");
  });

  it("names the connection, not the plan, when the install is not connected", () => {
    const src = code(KIT);
    expect(src).toContain("not connected to your GradeThread account");
    expect(src).toContain('to="/connect-extension"');
  });

  it("still names the plan when the plan really is the gate", () => {
    const src = code(KIT);
    expect(src).toContain("Cross-listing needs an active paid FlipDesk plan.");
    expect(src).toContain('to="/pricing"');
  });
});
