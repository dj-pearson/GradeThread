// The US-2403 probe must never call a quiet stack "safe" without its control.
//
// A denied function call from a role in supautils.hint_roles segfaults the
// database. The probe cannot test that directly against prod, because the test
// IS the denial of service, so it reads a proxy: does a denied TABLE read come
// back carrying the supautils hint? No hint means the hint path is not running
// for that role, which means the function path is not either.
//
// THE FAILURE MODE THIS PINS. `hint: null` has two causes that look identical
// from the client: supautils is quiet, or hints never reach the client at all.
// The second reads as "mitigated" on every stack on earth, including the one
// that crashes. That is why the control exists, and why a failed control must
// produce INCONCLUSIVE rather than a comforting answer — a security probe whose
// broken state looks like a pass is worse than no probe.
import { describe, expect, it } from "vitest";
import { verdict } from "../../scripts/probe-supautils-hint.mjs";

describe("supautils hint probe verdict", () => {
  it("is inconclusive when the control produced no hint, whatever the subject said", () => {
    for (const subjectHint of [true, false]) {
      const v = verdict({
        control: { hintPresent: false },
        subject: { hintPresent: subjectHint },
      });
      expect(v.conclusive).toBe(false);
      expect(v.finding).toBe("control_failed");
    }
  });

  it("reports the crash path LIVE when a hint comes back for the denied read", () => {
    const v = verdict({ control: { hintPresent: true }, subject: { hintPresent: true } });
    expect(v.finding).toBe("hint_path_active");
    expect(v.conclusive).toBe(true);
    // It must not invite the confirming call. The confirming call is the attack.
    expect(v.say).toMatch(/do not confirm by calling one/i);
  });

  it("reports quiet only when the control passed and the subject was silent", () => {
    const v = verdict({ control: { hintPresent: true }, subject: { hintPresent: false } });
    expect(v.finding).toBe("hint_path_quiet");
    expect(v.conclusive).toBe(true);
  });

  it("never overstates the quiet result as proof", () => {
    // It infers from a gate the table path and the function path share. Wording
    // that hardens into "proved prod is safe" is how 00527 gets applied into an
    // unpatched image, which multiplies the entry points from 14 to about 80.
    const v = verdict({ control: { hintPresent: true }, subject: { hintPresent: false } });
    expect(v.say).toMatch(/evidence, not proof/i);
    expect(v.say).not.toMatch(/\bproves\b|\bproven\b|\bconfirmed safe\b/i);
  });
});
