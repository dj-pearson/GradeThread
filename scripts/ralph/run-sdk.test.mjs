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
  // US-2371: highest priority means the LOWEST number. The direction lives in
  // scripts/lib/prd-priority.mjs; these tests are the thing that stops it from
  // being flipped back by someone reading "highest" literally.
  it("picks the LOWEST-numbered priority, which is the highest priority", () => {
    const r = selectStory(
      prd([
        story({ id: "US-1", priority: -100 }),
        story({ id: "US-2", priority: -1 }),
        story({ id: "US-3", priority: -50 }),
      ]),
    );
    expect(r.story.id).toBe("US-1");
    expect(r.openCount).toBe(3);
  });

  it("ranks a large negative above a small positive", () => {
    // The exact case that made the direction load-bearing: the Android block
    // sits near -98700 and must outrank the two-digit stories, not sort behind
    // every one of them.
    const r = selectStory(
      prd([story({ id: "US-1421", priority: 58 }), story({ id: "US-1299", priority: -98701 })]),
    );
    expect(r.story.id).toBe("US-1299");
  });

  it("breaks a priority tie on id so two runs agree", () => {
    const r = selectStory(
      prd([story({ id: "US-9", priority: 5 }), story({ id: "US-4", priority: 5 })]),
    );
    expect(r.story.id).toBe("US-4");
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
    // forever while its lower-priority dependency never gets a turn. US-2 is the
    // higher priority here BECAUSE its number is lower, so without the dependsOn
    // check it would win every round.
    const r = selectStory(
      prd([
        story({ id: "US-2", priority: 1, dependsOn: ["US-1"] }),
        story({ id: "US-1", priority: 10 }),
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

  // Operator-gated stories. Selection is stateless, so a story the agent cannot
  // finish is not a one-iteration loss — it is re-picked every iteration and
  // eats the entire run. These must be stepped over, and reported so they are
  // not silently forgotten either.
  it("steps over an operator-gated story and takes the next one", () => {
    const r = selectStory(
      prd([
        story({ id: "US-2380", priority: 59, title: "[OPERATOR] Apply to eBay for a scope" }),
        story({ id: "US-2407", priority: 2379, title: "Android: team management" }),
      ]),
    );
    expect(r.story.id).toBe("US-2407");
    expect(r.operatorGated.map((s) => s.id)).toEqual(["US-2380"]);
    expect(r.openCount).toBe(2); // still open — skipped, not completed
  });

  it("recognizes all three operator markers", () => {
    const titles = [
      "[OPERATOR] Apply for a scope",
      "[OPS — USER ACTION REQUIRED, DEFERRED for agent loop] Prod reconciliation",
      "Something DEFERRED for agent loop",
    ];
    for (const title of titles) {
      const r = selectStory(prd([story({ id: "US-1", title }), story({ id: "US-2", priority: 9 })]));
      expect(r.story.id, title).toBe("US-2");
    }
  });

  it("does NOT gate on the marker appearing in notes", () => {
    // `notes` is append-only prose that routinely describes OTHER stories'
    // operator steps. Matching there would gate work that is perfectly runnable.
    const r = selectStory(
      prd([story({ id: "US-1", notes: "AC1 is [OPERATOR] work tracked in US-2380" })]),
    );
    expect(r.story.id).toBe("US-1");
  });

  it("returns null when every open story is operator-gated", () => {
    // Same shape as the dependsOn cycle: open work remains, so the loop must not
    // report COMPLETE.
    const r = selectStory(prd([story({ id: "US-1", title: "[OPERATOR] do a thing" })]));
    expect(r.story).toBeNull();
    expect(r.openCount).toBe(1);
    expect(r.operatorGated).toHaveLength(1);
  });

  it("sorts a story with no priority last rather than first", () => {
    const r = selectStory(
      prd([story({ id: "US-1", priority: undefined }), story({ id: "US-2", priority: -500 })]),
    );
    expect(r.story.id).toBe("US-2");
  });

  it("still sorts an unranked story last when every ranked one is positive", () => {
    // Ascending order makes this the dangerous direction: `undefined` must not
    // be coerced to 0 and beat a story at 5.
    const r = selectStory(
      prd([story({ id: "US-1", priority: undefined }), story({ id: "US-2", priority: 5 })]),
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
