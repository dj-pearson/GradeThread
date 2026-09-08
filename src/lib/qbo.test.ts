import { describe, it, expect } from "vitest";
import { qboEnvironmentView, type QboConnectionStatus } from "./qbo";

// US-3138 — where a QuickBooks sync ACTUALLY goes.

function status(
  serverEnv: "sandbox" | "production",
  connectionEnv: "sandbox" | "production" | null,
): QboConnectionStatus {
  return {
    configured: true,
    environment: serverEnv,
    connected: connectionEnv !== null,
    connection:
      connectionEnv === null
        ? null
        : {
            id: "c1",
            realm_id: "9130",
            environment: connectionEnv,
            company_name: "Pearson Media LLC",
            token_expires_at: null,
            refresh_token_expires_at: null,
            refresh_error: null,
          },
  };
}

describe("which environment a sync reaches", () => {
  it("uses the server setting when nothing is connected yet", () => {
    const v = qboEnvironmentView(status("production", null));
    expect(v.effective).toBe("production");
    expect(v.mismatch).toBe(false);
    expect(v.warning).toBeNull();
  });

  it("uses the CONNECTION's environment once there is one", () => {
    // The environment is stamped on the row at consent time and qboFetch picks
    // the Intuit host off the row, not off the variable. The row is therefore
    // the only honest answer to "where do my documents go".
    const v = qboEnvironmentView(status("production", "sandbox"));
    expect(v.effective).toBe("sandbox");
    expect(v.label).toBe("Sandbox (test data)");
  });

  it("warns when the setting was flipped under an existing connection", () => {
    // THE REAL CASE, 2026-09-07: QBO_ENVIRONMENT was sandbox, somebody
    // connected, then it was changed to production and the edge redeployed.
    // The badge read the variable and said "Live company" while every document
    // was still going to a test company nobody reads.
    const v = qboEnvironmentView(status("production", "sandbox"));
    expect(v.mismatch).toBe(true);
    expect(v.warning).toContain("disconnect and connect again");
  });

  it("warns in the other direction too", () => {
    // Production connection, server set back to sandbox. Less dangerous and
    // still a disagreement the seller should not have to work out.
    const v = qboEnvironmentView(status("sandbox", "production"));
    expect(v.effective).toBe("production");
    expect(v.mismatch).toBe(true);
    expect(v.warning).not.toBeNull();
  });

  it("says nothing when the two agree", () => {
    for (const env of ["sandbox", "production"] as const) {
      const v = qboEnvironmentView(status(env, env));
      expect(v.mismatch).toBe(false);
      expect(v.warning).toBeNull();
    }
  });

  it("names both sides in the warning, so it can be acted on", () => {
    const v = qboEnvironmentView(status("production", "sandbox"));
    expect(v.warning).toContain("sandbox");
    expect(v.warning).toContain("production");
  });

  it("does not claim the setting moves an existing connection", () => {
    // It does not: a fresh consent INSERTS a row (user + realm + environment is
    // the identity), so the old one is still there and still active until it is
    // disconnected. Saying otherwise would send somebody looking for a change
    // that never happens.
    const v = qboEnvironmentView(status("production", "sandbox"));
    expect(v.warning).toContain("does not move an existing connection");
  });
});
