// US-3178: the learning, driven against rows a REAL edge service returned
// from a REAL database.
//
// The unit suite beside this one builds its own RawObservation objects, which
// proves the rules and cannot prove the WIRING: that the columns the route
// selects are the columns the learner reads, that a batch written as three
// rows in one session comes back as one run, and that another seller's rows
// are not in the answer. Those are questions about two pieces agreeing, and
// only real rows can ask them.
//
// SKIPS with a reason when the stack is absent, like the live browser spec.
// A red for a missing environment is a red nobody reads.

import { describe, it, expect } from "vitest";
import {
  learnDurations,
  learnedFor,
  learnedSetupFor,
  type RawObservation,
} from "@/lib/work-duration-learning";
import { estimateDuration, isUnestimated } from "@/lib/work-duration";

const EDGE = process.env.LIVE_EDGE_URL;
const TOKEN_A = process.env.LIVE_TOKEN_A;
const TOKEN_B = process.env.LIVE_TOKEN_B;
const READY = Boolean(EDGE && TOKEN_A && TOKEN_B);

interface Row {
  task_id: string;
  session_id: string;
  position: number;
  action_key: string;
  task_state: string;
  session_state: string;
  work_context: string;
  confirmed_minutes: number | null;
  correction_minutes: number | null;
  ended_at: string | null;
}

/** The same mapping use-planner.ts does, deliberately duplicated so this
 *  test fails if the hook's shape and the route's columns drift apart. */
function toObservations(rows: Row[]): RawObservation[] {
  const out: RawObservation[] = [];
  for (const r of rows) {
    const d = estimateDuration({ action: r.action_key });
    if (isUnestimated(d)) continue;
    out.push({
      taskId: r.task_id,
      sessionId: r.session_id,
      position: r.position,
      family: d.family,
      context: r.work_context === "phone_only" ? "phone_only" : "home",
      taskState: r.task_state,
      sessionState: r.session_state,
      confirmedMinutes: r.confirmed_minutes,
      correctionMinutes: r.correction_minutes,
      endedAt: r.ended_at,
    });
  }
  return out;
}

async function observations(token: string): Promise<Row[]> {
  const res = await fetch(`${EDGE}/api/flipdesk/planner/observations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`observations read failed: ${res.status}`);
  const body = await res.json();
  return body.observations as Row[];
}

describe.skipIf(!READY)("learning from real rows (US-3178)", () => {
  it("reads the seller's own completed work", async () => {
    const rows = await observations(TOKEN_A!);
    expect(rows.length).toBeGreaterThan(0);
    // Every row is completed work in a completed session; the route filters
    // both, so anything else here means the query drifted.
    for (const r of rows) {
      expect(r.task_state).toBe("completed");
      expect(r.session_state).toBe("completed");
    }
  });

  it("a three-task photo batch learns 4 per item, not 12", async () => {
    // The fixture is five sessions of 12, 4, 4. A flat median over all
    // fifteen numbers is 4 too, so the assertion that separates the two
    // models is the SAMPLE COUNT: ten per-item samples out of fifteen tasks.
    const result = learnDurations(toObservations(await observations(TOKEN_A!)));
    const learned = learnedFor(result, "photo", "home");
    expect(learned).not.toBeNull();
    expect(learned!.typicalMinutes).toBe(4);
    expect(learned!.allocation).toBe("per_item");
    expect(learned!.sampleCount).toBe(10);
  });

  it("and reads the setup cost out of the difference", async () => {
    const result = learnDurations(toObservations(await observations(TOKEN_A!)));
    const setup = learnedSetupFor(result, "photo", "home");
    expect(setup).not.toBeNull();
    expect(setup!.setupMinutes).toBe(8);
  });

  it("the estimate says learned, with the seller's own evidence", async () => {
    const result = learnDurations(toObservations(await observations(TOKEN_A!)));
    const learned = learnedFor(result, "photo", "home")!;
    const d = estimateDuration({ action: "photograph", learned });
    if (isUnestimated(d)) throw new Error("should estimate");
    expect(d.source).toBe("learned");
    // The R1 default for photograph is 8. This seller's own pace is 4.
    expect(d.typical).toBe(4);
    expect(d.learnedFrom?.sampleCount).toBe(10);
  });

  it("THE OTHER SELLER'S 45-MINUTE HISTORY CANNOT REACH IT", async () => {
    const mine = await observations(TOKEN_A!);
    const theirs = await observations(TOKEN_B!);
    expect(theirs.length).toBeGreaterThan(0);
    const myIds = new Set(mine.map((r) => r.task_id));
    expect(theirs.filter((r) => myIds.has(r.task_id))).toEqual([]);

    // And the learned answers differ in the direction the fixture set up.
    const a = learnedFor(learnDurations(toObservations(mine)), "photo", "home")!;
    const b = learnedFor(learnDurations(toObservations(theirs)), "photo", "home")!;
    expect(a.typicalMinutes).toBe(4);
    expect(b.typicalMinutes).toBe(45);
  });
});
