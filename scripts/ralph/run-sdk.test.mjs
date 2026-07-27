// Coverage for the pure decision logic in the SDK Ralph runner: which story
// gets picked and which model runs it. These were previously inline jq
// expressions in ralph.sh with no test at all — and one of them (the dependsOn
// `. as $d` binding) had already caused a real deadlock.
//
// Importing this module must NOT start a loop; run-sdk.mjs guards main() behind
// an entrypoint check, and that guard is itself load-bearing here.
import { describe, expect, it } from "vitest";
import { resolveModel, selectStory } from "./run-sdk.mjs";

const story = (over = {}) => ({
  id: "US-1",
  title: "t",
  priority: 0,
  passes: false,
  ...over,
});
const prd = (userStories) => ({ userStories });

describe("selectStory", () => {
  it("picks the highest priority open story", () => {
    const r = selectStory(
      prd([
        story({ id: "US-1", priority: -100 }),
        story({ id: "US-2", priority: -1 }),
        story({ id: "US-3", priority: -50 }),
      ]),
    );
    expect(r.story.id).toBe("US-2");
    expect(r.openCount).toBe(3);
  });

  it("ignores stories that already pass", () => {
    const r = selectStory(
      prd([story({ id: "US-1", priority: 100, passes: true }), story({ id: "US-2" })]),
    );
    expect(r.story.id).toBe("US-2");
    expect(r.openCount).toBe(1);
  });

  it("skips a story blocked by an OPEN dependency", () => {
    // The deadlock this guards: a high-priority dependent must not be selected
    // forever while its lower-priority dependency never gets a turn.
    const r = selectStory(
      prd([
        story({ id: "US-2", priority: 10, dependsOn: ["US-1"] }),
        story({ id: "US-1", priority: 1 }),
      ]),
    );
    expect(r.story.id).toBe("US-1");
  });

  it("treats a passing dependency as satisfied", () => {
    const r = selectStory(
      prd([
        story({ id: "US-2", priority: 10, dependsOn: ["US-1"] }),
        story({ id: "US-1", priority: 1, passes: true }),
      ]),
    );
    expect(r.story.id).toBe("US-2");
  });

  it("treats an ABSENT dependency as satisfied (it was archived)", () => {
    // Completed stories move to prd.archive.json, so a satisfied dep is often
    // simply missing. Treating absence as blocking would stall the whole loop.
    const r = selectStory(prd([story({ id: "US-2", dependsOn: ["US-999"] })]));
    expect(r.story.id).toBe("US-2");
  });

  it("does not treat a non-empty dependsOn as self-blocking", () => {
    // The original jq bug: `($open | index(.))` rebound `.` to $open, so every
    // story with any dependsOn was wrongly considered blocked.
    const r = selectStory(
      prd([story({ id: "US-2", dependsOn: ["US-1"] }), story({ id: "US-1", passes: true })]),
    );
    expect(r.story).not.toBeNull();
  });

  it("returns null when every open story is blocked (cycle), not 'complete'", () => {
    const r = selectStory(
      prd([
        story({ id: "US-1", dependsOn: ["US-2"] }),
        story({ id: "US-2", dependsOn: ["US-1"] }),
      ]),
    );
    expect(r.story).toBeNull();
    expect(r.openCount).toBe(2); // openCount > 0 + no story ⇒ authoring error, not done
  });

  it("reports openCount 0 when everything passes", () => {
    expect(selectStory(prd([story({ passes: true })])).openCount).toBe(0);
  });

  it("sorts a story with no priority last rather than first", () => {
    const r = selectStory(
      prd([story({ id: "US-1", priority: undefined }), story({ id: "US-2", priority: -500 })]),
    );
    expect(r.story.id).toBe("US-2");
  });
});

describe("resolveModel", () => {
  it("defaults to opus", () => {
    expect(resolveModel(story(), {})).toBe("opus");
  });
  it("honors an explicit per-story model", () => {
    expect(resolveModel(story({ model: "sonnet" }), {})).toBe("sonnet");
  });
  it("escalates a hard story to the hard model", () => {
    expect(resolveModel(story({ hard: true }), { RALPH_HARD_MODEL: "opus" })).toBe("opus");
    expect(resolveModel(story({ hard: true }), { RALPH_DEFAULT_MODEL: "sonnet" })).toBe("opus");
  });
  it("lets RALPH_FORCE_MODEL override everything", () => {
    expect(
      resolveModel(story({ model: "sonnet", hard: true }), { RALPH_FORCE_MODEL: "haiku" }),
    ).toBe("haiku");
  });
  it("respects RALPH_DEFAULT_MODEL for an unpinned story", () => {
    expect(resolveModel(story(), { RALPH_DEFAULT_MODEL: "sonnet" })).toBe("sonnet");
  });
});
