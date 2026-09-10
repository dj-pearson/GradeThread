// US-3223. The run-scoped flag that async work started OUTSIDE a useEffect uses
// to tell whether its answer is still wanted.
//
// Every case here resolves the SECOND request before the first, because that is
// the interleaving nobody writes a manual test for and the one that produces a
// screen holding an answer to a question the user has already changed.
import { describe, expect, it } from "vitest";

import { createRunOwner, type Run } from "@/lib/latest-run";

/** A promise plus the handle to settle it whenever the test wants. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createRunOwner", () => {
  it("supersedes the run in flight when a newer one begins", () => {
    const owner = createRunOwner();
    const first = owner.begin();
    expect(first.superseded).toBe(false);

    const second = owner.begin();
    expect(first.superseded).toBe(true);
    expect(second.superseded).toBe(false);
  });

  it("supersede() invalidates without starting a replacement", () => {
    const owner = createRunOwner();
    const run = owner.begin();

    owner.supersede();

    expect(run.superseded).toBe(true);
    expect(owner.peek()).toBeNull();
  });

  it("supersede() on a fresh owner is a no-op", () => {
    const owner = createRunOwner();
    expect(() => owner.supersede()).not.toThrow();
    expect(owner.peek()).toBeNull();
  });

  it("a second supersede() does not un-supersede anything", () => {
    const owner = createRunOwner();
    const run = owner.begin();
    owner.supersede();
    owner.supersede();
    expect(run.superseded).toBe(true);
  });

  it("keeps the newest run current across begin/supersede/begin", () => {
    const owner = createRunOwner();
    owner.begin();
    owner.supersede();
    const third = owner.begin();
    expect(owner.peek()).toBe(third);
    expect(third.superseded).toBe(false);
  });
});

describe("out-of-order resolution", () => {
  it("drops the older answer when the slower FIRST request lands last", async () => {
    const owner = createRunOwner();
    const slowFirst = deferred<string>();
    const fastSecond = deferred<string>();
    const applied: string[] = [];

    async function work(run: Run, source: Promise<string>) {
      const value = await source;
      if (run.superseded) return;
      applied.push(value);
    }

    const a = work(owner.begin(), slowFirst.promise);
    const b = work(owner.begin(), fastSecond.promise);

    // Second request answers first, then the first finally comes back.
    fastSecond.resolve("second");
    await b;
    slowFirst.resolve("first");
    await a;

    expect(applied).toEqual(["second"]);
  });

  it("still drops the older answer when three runs overlap", async () => {
    const owner = createRunOwner();
    const d = [deferred<string>(), deferred<string>(), deferred<string>()];
    const applied: string[] = [];

    const runs = d.map((x) => {
      const run = owner.begin();
      return x.promise.then((v) => {
        if (run.superseded) return;
        applied.push(v);
      });
    });

    d[2]!.resolve("third");
    d[0]!.resolve("first");
    d[1]!.resolve("second");
    await Promise.all(runs);

    expect(applied).toEqual(["third"]);
  });

  // The intake.tsx interleaving: AI Fill goes out, the seller presses "Save &
  // add another", the form resets for the next garment, and only then does the
  // extract come back. Without the supersede in the reset path it repopulates
  // the panel -- and intake feeds aiResult.suggestions.garment_type straight
  // into the NEXT item's insert.
  it("a reset between request and response discards the response", async () => {
    const owner = createRunOwner();
    const extract = deferred<{ brand: string }>();
    let panel: { brand: string } | null = null;

    const run = owner.begin();
    const inFlight = extract.promise.then((result) => {
      if (run.superseded) return;
      panel = result;
    });

    // "Save & add another" clears the form.
    owner.supersede();
    panel = null;

    extract.resolve({ brand: "Carhartt" });
    await inFlight;

    expect(panel).toBeNull();
  });

  it("a rejection from a superseded run can be told apart from a live one", async () => {
    const owner = createRunOwner();
    const failed = deferred<string>();
    const toasts: string[] = [];

    const run = owner.begin();
    const inFlight = failed.promise.catch((err) => {
      if (run.superseded) return;
      toasts.push(String(err));
    });

    owner.supersede();
    failed.reject(new Error("gone"));
    await inFlight;

    expect(toasts).toEqual([]);
  });
});
