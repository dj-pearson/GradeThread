import { describe, expect, it } from "vitest";
import { hasPasswordIdentity, oauthProviderLabel } from "@/lib/auth";

// Mirrors the server rule in services/edge-functions/src/routes/account.ts
// (account delete re-auth): any "email" identity means a password exists.
describe("hasPasswordIdentity", () => {
  it("email only: has a password", () => {
    expect(
      hasPasswordIdentity({ app_metadata: { provider: "email", providers: ["email"] } }),
    ).toBe(true);
  });

  it("google only: no password", () => {
    const user = { app_metadata: { provider: "google", providers: ["google"] } };
    expect(hasPasswordIdentity(user)).toBe(false);
    expect(oauthProviderLabel(user)).toBe("Google");
  });

  it("google-first that later added a password: has a password", () => {
    expect(
      hasPasswordIdentity({
        app_metadata: { provider: "google", providers: ["google", "email"] },
      }),
    ).toBe(true);
  });

  it("apple only: no password", () => {
    const user = { app_metadata: { provider: "apple", providers: ["apple"] } };
    expect(hasPasswordIdentity(user)).toBe(false);
    expect(oauthProviderLabel(user)).toBe("Apple");
  });

  it("missing metadata or user: no password", () => {
    expect(hasPasswordIdentity(null)).toBe(false);
    expect(hasPasswordIdentity({ app_metadata: null })).toBe(false);
  });

  it("the settings components use the helper, not a provider === google check", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of [
      "src/components/settings/danger-zone-card.tsx",
      "src/components/settings/security-settings-tab.tsx",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src).toContain("hasPasswordIdentity(user)");
      expect(src).not.toMatch(/provider\s*===\s*"google"/);
    }
  });
});
