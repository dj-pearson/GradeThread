// US-3223. The admin bulk page resolves a pasted target list server-side and
// then fires credits, suspensions or regrades at whatever ended up in
// `resolved`. Editing the target box clears it -- that clear IS the safety --
// but it never cancelled the resolve already in flight.
import { describe, expect, it } from "vitest";

import { createRunOwner } from "@/lib/latest-run";
import { acceptResolution, type ResolvedUser } from "@/pages/admin/bulk-resolve";

function user(input: string, id: string): ResolvedUser {
  return {
    input,
    user_id: id,
    email: input,
    full_name: null,
    suspended: false,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("acceptResolution", () => {
  it("returns the resolved and unknown lists for a live run", () => {
    const owner = createRunOwner();
    const patch = acceptResolution(owner.begin(), {
      resolved: [user("a@example.com", "id-a")],
      unknown: ["nobody@example.com"],
    });
    expect(patch).toEqual({
      resolved: [user("a@example.com", "id-a")],
      unknown: ["nobody@example.com"],
    });
  });

  it("defaults both lists when the server omits them", () => {
    const owner = createRunOwner();
    expect(acceptResolution(owner.begin(), {})).toEqual({
      resolved: [],
      unknown: [],
    });
  });

  it("refuses a response whose run was superseded", () => {
    const owner = createRunOwner();
    const stale = owner.begin();
    owner.supersede();
    expect(
      acceptResolution(stale, { resolved: [user("a@example.com", "id-a")] }),
    ).toBeNull();
  });
});

describe("editing the target box while a resolve is in flight", () => {
  // The operator pastes two accounts, presses Resolve, then deletes one of them
  // from the box. resetResolution() runs on that keystroke and empties
  // `resolved`. Before the guard the response landed a moment later and put
  // BOTH accounts back -- invisibly, since the box above no longer showed the
  // second one -- and Confirm then suspended or credited an account the
  // operator had already removed.
  it("does not restore a target list the operator has edited away", async () => {
    const owner = createRunOwner();
    const inFlight = deferred<{ resolved: ResolvedUser[]; unknown: string[] }>();

    let resolved: ResolvedUser[] | null = null;

    const run = owner.begin();
    const pending = inFlight.promise.then((json) => {
      const patch = acceptResolution(run, json);
      if (!patch) return;
      resolved = patch.resolved;
    });

    // Keystroke in the target box.
    owner.supersede();
    resolved = null;

    inFlight.resolve({
      resolved: [user("keep@example.com", "id-a"), user("removed@example.com", "id-b")],
      unknown: [],
    });
    await pending;

    expect(resolved).toBeNull();
  });

  it("keeps only the newest list when the operator resolves twice", async () => {
    const owner = createRunOwner();
    const first = deferred<{ resolved: ResolvedUser[]; unknown: string[] }>();
    const second = deferred<{ resolved: ResolvedUser[]; unknown: string[] }>();

    let resolved: ResolvedUser[] | null = null;

    const firstRun = owner.begin();
    const firstPending = first.promise.then((json) => {
      const patch = acceptResolution(firstRun, json);
      if (patch) resolved = patch.resolved;
    });

    const secondRun = owner.begin();
    const secondPending = second.promise.then((json) => {
      const patch = acceptResolution(secondRun, json);
      if (patch) resolved = patch.resolved;
    });

    second.resolve({ resolved: [user("new@example.com", "id-new")], unknown: [] });
    await secondPending;
    first.resolve({ resolved: [user("old@example.com", "id-old")], unknown: [] });
    await firstPending;

    expect(resolved).toEqual([user("new@example.com", "id-new")]);
  });
});
