import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2875.
//
// The story called it "four lines" and it is not, for one reason worth
// recording: `showingOnboarding` in ContentView is
//
//     @State private var showingOnboarding = !OnboardingState().hasCompleted
//
// which is seeded ONCE at view init. Clearing the stored flag from Settings --
// the literal four-line fix -- would set a UserDefaults key and put nothing on
// screen until the next cold launch. To the person who tapped it, the button
// does nothing. So the replay posts a notification and the view listens, which
// is the same shape this file already uses for .onboardingDidFinish.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const STATE = "ios/GradeThread/Onboarding/OnboardingState.swift";
const CONTENT = "ios/GradeThread/ContentView.swift";
const CHECKLIST = "ios/GradeThread/Onboarding/ActivationChecklist.swift";
const WEB_SETTINGS = "src/pages/settings.tsx";

/** Swift and TSX comments both, so a scan never fires on its own prose. */
const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/\/?.*$/gm, "");

describe("iOS can replay the tour at all (US-2875 AC1)", () => {
  const state = stripComments(read(STATE));
  const content = stripComments(read(CONTENT));

  it("there is a replay that clears the completion flag", () => {
    expect(state).toContain("func replay()");
    const fn = state.slice(state.indexOf("func replay()"));
    expect(fn.slice(0, 200)).toContain("hasCompleted = false");
  });

  it("it keeps the recorded use case", () => {
    // Somebody rewatching the intro has not stopped being a reseller. Wiping
    // it would silently re-persona them, and the web equivalent does not.
    const fn = state.slice(state.indexOf("func replay()"), state.indexOf("func complete("));
    expect(
      /selectedUseCase/.test(fn),
      "replay() touches selectedUseCase; AC1 says replay must not clear it",
    ).toBe(false);
  });

  it("Settings offers it", () => {
    expect(content).toContain("OnboardingState().replay()");
  });

  it("something actually puts the carousel back on screen", () => {
    // The part the "four lines" framing misses. Without this the flag flips
    // and nothing happens until relaunch.
    expect(state).toContain("onboardingReplayRequested");
    expect(state).toMatch(/post\(name: \.onboardingReplayRequested/);
    expect(content).toMatch(
      /publisher\(for: \.onboardingReplayRequested\)[\s\S]{0,120}showingOnboarding = true/,
    );
  });
});

describe("a replay cannot yank a working user (US-2875 AC2)", () => {
  const state = stripComments(read(STATE));

  it("complete() skips pendingFirstAction while replaying", () => {
    const fn = state.slice(state.indexOf("func complete("));
    expect(fn).toContain("if isReplaying");
    // The queue must sit in the ELSE branch, not run regardless.
    const queueAt = fn.indexOf("pendingFirstAction = true");
    const elseAt = fn.indexOf("} else {");
    expect(queueAt).toBeGreaterThan(-1);
    expect(elseAt).toBeGreaterThan(-1);
    expect(
      elseAt,
      "pendingFirstAction is still queued before the replay branch, so a " +
        "replay would route the user to another tab",
    ).toBeLessThan(queueAt);
  });

  it("the replay flag is cleared once the replay finishes", () => {
    // Otherwise the NEXT genuine completion is treated as a replay and the
    // first-action nudge is lost for good.
    const fn = state.slice(state.indexOf("func complete("));
    expect(fn).toContain("isReplaying = false");
  });

  it("replay() itself does not queue a first action", () => {
    const fn = state.slice(state.indexOf("func replay()"), state.indexOf("func complete("));
    expect(/pendingFirstAction/.test(fn)).toBe(false);
  });
});

describe("both platforms say the same thing (US-2875 AC3)", () => {
  const web = stripComments(read(WEB_SETTINGS));
  const content = stripComments(read(CONTENT));

  // The web has had both entries since US-378. iOS matches its wording rather
  // than inventing a second phrasing for the same action.
  const SHARED = ["Replay tour", "Setup checklist"];

  for (const label of SHARED) {
    it(`"${label}" appears on both`, () => {
      expect(web, `the web no longer says "${label}"`).toContain(label);
      expect(content, `iOS does not say "${label}"`).toContain(label);
    });
  }

  it("iOS did not invent its own phrasing alongside", () => {
    // The AC's own draft wording. If somebody adds it later, the two
    // platforms are back to saying different things about one action.
    expect(content).not.toContain("Replay the welcome tour");
  });
});

describe("the checklist comes back too (US-2875 AC4)", () => {
  const checklist = stripComments(read(CHECKLIST));
  const content = stripComments(read(CONTENT));
  const web = stripComments(read(WEB_SETTINGS));

  it("iOS exposes an un-dismiss", () => {
    expect(checklist).toContain("static func undismiss()");
    expect(checklist).toMatch(/undismiss\(\)[\s\S]{0,200}set\(false, forKey: Self\.dismissKey\)/);
  });

  it("Settings calls it, on the real class", () => {
    // The class is ActivationChecklistStore. I wrote ...Model first, from the
    // shape rather than the source, and it would have been a build break on a
    // machine this repo cannot compile on.
    expect(content).toContain("ActivationChecklistStore.undismiss()");
    expect(content).not.toContain("ActivationChecklistModel");
  });

  it("the web still has its own", () => {
    expect(web).toContain("undismissActivation");
  });

  it("un-dismissing resets no progress", () => {
    // The steps recompute from real data, so bringing the card back shows what
    // is genuinely outstanding rather than starting anybody over.
    const fn = checklist.slice(checklist.indexOf("static func undismiss()"));
    const body = fn.slice(0, fn.indexOf("}") + 1);
    expect(/gradeCount|itemCount|removeObject|reset/.test(body)).toBe(false);
  });
});
