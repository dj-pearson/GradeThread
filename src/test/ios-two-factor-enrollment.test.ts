import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2671. A workspace member blocked by their owner's 2FA policy is denied on
// EVERY request, and until this shipped the app told them to go to
// gradethread.com because there was no enrollment surface on the phone.
//
// This checkout can READ Swift and cannot compile it — iOS CI on macOS runners
// is the compile gate. What a source scan CAN hold is the set of properties a
// later refactor would quietly drop, and the load-bearing one is not the
// enrollment flow at all: it is the ELEVATION path. Password sign-in mints an
// `aal1` token no matter how many verified factors the account has, so a build
// that only enrolls looks finished, demos correctly, and leaves the member
// blocked again the next morning.

const STORE = "ios/GradeThread/Settings/TwoFactorStore.swift";
const SHEET = "ios/GradeThread/Settings/TwoFactorSheet.swift";
const SHELL = "ios/GradeThread/ContentView.swift";
const EDGE_ERROR = "ios/GradeThread/Networking/EdgeAPIError.swift";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/**
 * The file with comments stripped. Swift `///` doc comments describe the very
 * calls these assertions look for, so an un-stripped scan would be satisfied by
 * a paragraph about a deleted function — the failure mode this repo has hit
 * three times.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the enrollment surface exists on device (US-2671 AC3)", () => {
  it("the store drives the Supabase MFA endpoints", () => {
    const src = code(STORE);
    expect(src).toContain("auth.mfa.enroll(");
    expect(src).toContain("auth.mfa.challenge(");
    expect(src).toContain("auth.mfa.verify(");
    expect(src).toContain("auth.mfa.listFactors()");
  });

  it("Settings has a row that opens it", () => {
    const src = code(SHELL);
    expect(src).toContain('Label("Two-factor authentication", systemImage:');
    expect(src).toContain("TwoFactorSheet()");
  });

  it("the sheet shows a scannable QR and the manual key", () => {
    // Enrollment is unusable if it renders only one of the two: a QR alone
    // fails anyone whose authenticator lives on the same phone.
    const src = code(SHEET);
    expect(src).toContain("qrImage(from:");
    expect(src).toContain("groupedSecret(");
  });
});

describe("the enrolled state is visible and removable (US-2671 AC4)", () => {
  it("a verified factor renders as on, and can be turned off", () => {
    const src = code(SHEET);
    expect(src).toContain("Two-factor authentication is on.");
    expect(src).toContain("store.disable()");
  });

  it("removal goes through unenroll rather than a local flag", () => {
    expect(code(STORE)).toContain("auth.mfa.unenroll(");
  });

  it("an abandoned enrollment is cleaned up server-side", () => {
    // GoTrue keeps the unverified factor an interrupted enrollment created, and
    // the next enroll collides with it. Without this the SECOND attempt fails
    // and the user has no way to see why.
    // The CALL, not the declaration: deleting the one line that invokes it
    // leaves the function in the file, and a name-only check stays green.
    const src = code(STORE);
    expect(src).toContain("try await discardUnverifiedFactors()");
    expect(src).toContain("status == .unverified");
  });
});

describe("elevation is what actually unblocks the member", () => {
  it("the store can raise this session to aal2 with a code", () => {
    const src = code(STORE);
    expect(src).toContain("func elevate(code: String)");
    expect(src).toContain("getAuthenticatorAssuranceLevel()");
    expect(src).toContain('aal.currentLevel == "aal2"');
  });

  it("the sheet offers the code box when the session is NOT elevated", () => {
    // The state a blocked member is in after every cold sign-in. A build that
    // renders only the green badge here is the silent failure this guard exists
    // for: enrolled, correct-looking, and still denied on every request.
    //
    // Asserted as a PAIR inside one slice rather than as two independent
    // `toContain`s. The first version did the latter and stayed green when the
    // branch was removed: `if !aal2` also opens the footer sentence further
    // down, so the second occurrence satisfied a check meant for the first.
    const src = code(SHEET);
    const start = src.indexOf("if !aal2 {");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 1200);
    expect(block).toContain("store.elevate(code: code)");
  });

  it("turning 2FA off is refused until the session is elevated", () => {
    // GoTrue rejects an aal1 unenroll of a verified factor, so offering the
    // button anyway produces an error the user cannot act on.
    const src = code(SHEET);
    expect(src).toContain("store.busy || !aal2");
  });
});

describe("the block notice now points at the phone, not a browser", () => {
  it("the workspace-MFA alert opens enrollment in app", () => {
    const src = code(SHELL);
    const start = src.indexOf("workspaceMfaRequired");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 900);
    expect(block).toContain("fixesInApp: true");
    // The old behaviour, which is what regression looks like here.
    expect(block).not.toContain("dashboard/account?tab=settings");
  });

  it("the typed error still carries the SERVER's sentence (US-2532)", () => {
    // US-2671 changed where the fix lives, not who writes the explanation.
    const src = code(EDGE_ERROR);
    expect(src).toContain("workspace_mfa_required");
    expect(src).toContain("workspaceMfaRequired");
  });
});

describe("what the phone deliberately does NOT do", () => {
  it("recovery codes are not minted on device", () => {
    // They are one-time backups for losing this phone. Rendering them here
    // stores the backup beside the thing it backs up, and the edge route that
    // mints them shows each set exactly once.
    const src = code(SHEET) + code(STORE);
    expect(src).not.toContain("/api/account/mfa/recovery-codes");
  });

  it("and the sheet says where they live instead of staying silent", () => {
    expect(read(SHEET)).toContain("Recovery codes are managed on gradethread.com");
  });
});
