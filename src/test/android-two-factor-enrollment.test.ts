import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2685, mirroring src/test/ios-two-factor-enrollment.test.ts against the
// Kotlin sources.
//
// A workspace member blocked by their owner's 2FA policy is denied on EVERY
// request until their session reaches aal2, and before this there was no TOTP
// surface anywhere in the Android app — a grep for totp/aal2/two-factor across
// android/app/src/main returned zero files.
//
// WHAT A SCAN IS FOR HERE, given Android DOES compile on this checkout (unlike
// the iOS twin): the policy itself is unit-tested for real in
// TwoFactorPolicyTest, and Kotlin compilation catches the API. What neither
// catches is a WIRING property — a screen that stops offering the code box, a
// removal that becomes a local flag, a notice that goes back to pointing at a
// browser. Those are what this holds.
//
// The load-bearing one is not enrollment at all: it is ELEVATION. Password
// sign-in mints an aal1 token no matter how many verified factors the account
// has, so a build that only enrolls looks finished, demos correctly, and leaves
// the member blocked again the next morning.

const POLICY = "android/app/src/main/java/com/gradethread/app/settings/TwoFactorPolicy.kt";
const STORE = "android/app/src/main/java/com/gradethread/app/settings/TwoFactorStore.kt";
const DIALOG = "android/app/src/main/java/com/gradethread/app/settings/TwoFactorDialog.kt";
const SETTINGS = "android/app/src/main/java/com/gradethread/app/settings/SettingsScreen.kt";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/**
 * The file with comments stripped, blocks first.
 *
 * These files document the very calls the assertions look for — the store's
 * header explains `aal2` at length — so an un-stripped scan would be satisfied
 * by a paragraph about a deleted function. Stripping by line prefix alone
 * leaves the interior of a block comment behind, which is the variant that bit
 * on US-2686.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the enrollment surface exists on device (US-2685 AC1)", () => {
  it("the store drives the Supabase MFA endpoints", () => {
    const src = code(STORE);
    expect(src).toContain("auth.mfa.enroll(");
    expect(src).toContain("auth.mfa.createChallenge(");
    expect(src).toContain("auth.mfa.verifyChallenge(");
    expect(src).toContain("FactorType.TOTP");
  });

  it("Settings has a row that opens it", () => {
    const src = code(SETTINGS);
    expect(src).toContain("TwoFactorDialog(");
    expect(
      src,
      "the Settings row that opens two-factor is gone, so the screen exists and " +
        "nothing reaches it",
    ).toContain("twoFactorOpen = true");
  });

  it("the setup step shows a key the user can actually enter", () => {
    // A screen that enrolls without displaying the secret has minted a factor
    // the user cannot add to their authenticator.
    expect(code(DIALOG)).toContain("phase.secret");
  });
});

describe("the enrolled state is visible and removable (US-2685 AC2)", () => {
  it("a verified factor renders as on, and can be turned off", () => {
    expect(code(DIALOG)).toContain("Turn off");
    expect(code(STORE)).toContain("fun remove()");
  });

  it("removal goes through unenroll rather than a local flag", () => {
    // A local flag would leave the factor on the account: the badge says off,
    // GoTrue still demands a code, and the member is locked out by their own
    // settings screen.
    expect(code(STORE)).toContain("auth.mfa.unenroll(");
  });
});

describe("elevation is what actually unblocks the member (US-2685 AC3)", () => {
  it("the store can raise this session to aal2 with a code", () => {
    const src = code(STORE);
    expect(src).toContain("fun elevate(");
    expect(
      src,
      "the store no longer reads the session's assurance level, so it cannot " +
        "tell an enrolled-but-unelevated member from a verified one",
    ).toContain("getAuthenticatorAssuranceLevel()");
    expect(src).toContain("AAL2");
  });

  it("the enabled phase carries whether THIS session is elevated", () => {
    // Not a boolean "enabled". The gate is the assurance level, not the
    // presence of a factor, so the phase has to be able to say "enrolled and
    // still blocked".
    expect(code(STORE)).toMatch(/data class Enabled\([^)]*aal2: Boolean/);
  });

  it("the screen offers the code box when the session is NOT elevated", () => {
    // The criterion the iOS twin nearly shipped without. Without this branch a
    // returning member sees a reassuring badge and has nothing to press.
    const src = code(DIALOG);
    expect(src).toContain("phase.aal2");
    expect(
      src,
      "the dialog no longer calls elevate(), so an enrolled member on a cold " +
        "sign-in has no way to reach aal2 from this screen",
    ).toContain("store.elevate(");
  });
});

describe("the IPv6 retry policy is ported, not re-invented (US-2685 AC4)", () => {
  const src = code(POLICY);

  it("the mismatch is matched on GoTrue's wire vocabulary", () => {
    expect(src).toContain("mfa_ip_address_mismatch");
  });

  it("a wrong code is never retried", () => {
    // The negative half, and the one that matters: retrying a genuine
    // rejection burns the user's remaining attempts against a lockout they
    // cannot see. TwoFactorPolicyTest proves the behaviour; this stops the
    // guard clause being deleted.
    expect(src).toContain("if (!isIpMismatch(e)) return Outcome.Failed(e)");
  });

  it("the retry re-runs the CHALLENGE, so the IP is re-stamped", () => {
    // Re-verifying against the same challenge retries against the stale stamp
    // and fails identically every time — which looks like the retry working.
    const fn = src.slice(src.indexOf("suspend fun challengeAndVerify"));
    expect(fn.indexOf("challenge()")).toBeGreaterThan(-1);
    expect(
      fn.slice(0, fn.indexOf("verify(")),
      "the challenge call moved outside the retry loop",
    ).toContain("for (attempt in");
  });

  it("a challenge failure is terminal", () => {
    expect(src).toContain("return Outcome.Failed(e)");
  });
});

describe("recovery codes stay on the web (US-2685 AC6)", () => {
  it("nothing here mints them", () => {
    const src = code(DIALOG) + code(STORE);
    expect(src).not.toContain("recoveryCode");
    expect(src).not.toMatch(/generateRecovery|mintRecovery/);
  });

  it("the screen says where they live instead of staying silent", () => {
    // A backup kept on the device it protects is a copy in the same box. The
    // screen has to say so, or the member assumes there is no backup at all.
    expect(read(DIALOG)).toContain("Recovery codes live on gradethread.com");
  });
});

describe("the block points at the phone, not a browser (US-2685 AC5)", () => {
  const ERROR = "android/app/src/main/java/com/gradethread/app/platform/net/EdgeApiError.kt";
  const API = "android/app/src/main/java/com/gradethread/app/platform/net/EdgeApi.kt";
  const SCOPE = "android/app/src/main/java/com/gradethread/app/platform/workspace/WorkspaceScope.kt";
  const SWITCHER = "android/app/src/main/java/com/gradethread/app/workspace/WorkspaceSwitcherRow.kt";

  it("the workspace-MFA refusal has its own error case", () => {
    // Collapsed into Forbidden it rendered as "you don't have permission",
    // which sends a member who has simply not entered a code to ask their
    // owner for access they already have.
    const src = code(ERROR);
    expect(src).toContain("object WorkspaceMfaRequired");
    expect(src).toContain('payload?.discriminator == "workspace_mfa_required"');
  });

  it("it is matched BEFORE the generic 403 branch", () => {
    // That branch keys on `error` being non-blank, which this body also has,
    // so ordering is the whole of the discrimination.
    const src = code(ERROR);
    const mfa = src.indexOf('discriminator == "workspace_mfa_required"');
    const generic = src.indexOf("!payload?.error.isNullOrBlank()");
    expect(mfa).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(-1);
    expect(
      mfa,
      "the generic 403 branch now runs first and swallows the MFA refusal",
    ).toBeLessThan(generic);
  });

  it("the refusal is announced and still thrown", () => {
    // Announced so the UI can offer the code box; re-thrown because the request
    // really did fail and the caller still has to handle that.
    const src = code(API);
    const at = src.indexOf("EdgeApiError.WorkspaceMfaRequired");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 200);
    expect(block).toContain("onMfaRequired()");
    expect(block, "the error is swallowed instead of re-thrown").toContain("throw error");
  });

  it("it does NOT drop the workspace scope, unlike a revocation", () => {
    // Revocation means the scope is gone. This means the scope is fine and the
    // SESSION is not elevated. Clearing it here would log a member out of a
    // workspace they still belong to, over a code they can enter in seconds.
    const src = code(SCOPE);
    const fn = src.slice(src.indexOf("fun handleMfaRequired()"));
    const body = fn.slice(0, fn.indexOf("\n    }"));
    expect(body).toContain("Event.MfaRequired");
    expect(body, "handleMfaRequired clears the active scope").not.toContain("store?.put(null)");
  });

  it("the notice opens the enrollment screen rather than a link", () => {
    const src = code(SWITCHER);
    expect(src).toContain("state.mfaRequired");
    expect(src).toContain("TwoFactorDialog(");
    expect(
      src,
      "the MFA block sends the member to a browser again",
    ).not.toMatch(/mfaRequired[\s\S]{0,400}gradethread\.com/);
  });
});
