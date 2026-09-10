// US-3223 — ordering for async work that starts OUTSIDE a useEffect.
//
// An effect gets its guard for free: `let superseded = false` in the body, set
// to true in the cleanup, checked before every setState. Three sites were fixed
// that way on 2026-09-09 (grade-this-item-card, bulk-reprice-dialog,
// command-palette).
//
// Work started from a click handler has the same hazard and no cleanup to hang
// the flag on. The two interleavings that bite:
//
//   1. handler vs handler — the seller changes an input and fires the same
//      request again. Two responses, no ordering guarantee, and the slower
//      FIRST one lands last and wins.
//   2. handler vs reset — the seller edits the thing the request was about, or
//      saves and moves on. The code that clears the state runs immediately, the
//      response lands afterwards and puts the OLD answer back on a screen that
//      has moved on.
//
// A RunOwner gives the handler the same flag an effect gets. `begin()` marks
// whatever ran before as superseded and hands back a fresh flag; `supersede()`
// is what a reset calls. The read stays at the call site and stays readable:
//
//   const run = runs.begin();
//   const res = await fetchSomething();
//   if (run.superseded) return;   // a newer run owns this state now
//   setSomething(res);
//
// Deliberately NOT a request-id counter. `if (myId !== counterRef.current)`
// forces the reader to reconstruct what the counter means; `if (run.superseded)`
// says it.

/** One run of some async work. `superseded` is set by whoever invalidates it. */
export interface Run {
  superseded: boolean;
}

export interface RunOwner {
  /**
   * Start a run and take ownership. Any run still in flight is marked
   * superseded, so its response is dropped when it finally lands.
   */
  begin(): Run;
  /**
   * Invalidate the current run without starting one. Call this from whatever
   * makes an in-flight answer wrong: clearing the form it was about, saving and
   * resetting, switching to a different record.
   */
  supersede(): void;
  /** The run that currently owns the state, or null. Testing/diagnostics. */
  peek(): Run | null;
}

export function createRunOwner(): RunOwner {
  let current: Run | null = null;
  return {
    begin(): Run {
      if (current) current.superseded = true;
      const run: Run = { superseded: false };
      current = run;
      return run;
    },
    supersede(): void {
      if (current) current.superseded = true;
      current = null;
    },
    peek(): Run | null {
      return current;
    },
  };
}
