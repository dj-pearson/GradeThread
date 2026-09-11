// US-2738: the photo witness, rendered.
//
// THE GAP THIS CLOSES. attachPhotos learned to ask the PAGE whether it had
// rendered a preview out of the bytes we handed it, runFlow learned to keep the
// answer, and `photosWitness` has been riding home in the extension result and
// persisting into extension_jobs.result ever since. Nothing read it. A run where
// Poshmark's uploader took the file selection and ignored it looked, from the
// SaaS, exactly like a run where it worked.
//
// These cases DRIVE the component rather than grepping it for a word. A string
// that appears in a branch which never runs is the whole failure mode here: the
// bug being fixed is a claim with nothing behind it, and a test asserting the
// file mentions "confirmed" would be the same bug one level further out again.
//
// renderToStaticMarkup is this repo's convention (no @testing-library), which
// also means every assertion below is on markup a seller would actually see.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PhotoWitnessLine } from "@/components/flipdesk/listing-kit";
import { photoWitnessState, type ListerResult } from "@/lib/lister-extension";

const render = (res: ListerResult, label = "Poshmark") =>
  renderToStaticMarkup(<PhotoWitnessLine res={res} platformLabel={label} />);

// The shape the extension sends on a channel that declares `photoConfirm` and
// got its answer. Counts and witness agree, because attachPhotos makes them.
const confirmed: ListerResult = {
  ok: true,
  filled: true,
  photosAttached: true,
  photosTotal: 8,
  photosFailed: 0,
  photosWitness: "page",
};

// The refusal. The page took the file selection and rendered nothing out of it
// for six seconds, so attachPhotos converted every photo to failed.
const refused: ListerResult = {
  ok: true,
  filled: true,
  photosAttached: false,
  photosTotal: 8,
  photosFailed: 8,
  photosWitness: "none",
};

// Mercari, Grailed, Vinted, Facebook: no `photoConfirm` selector, so nobody
// asked. The browser taking a file selection is not the page taking the photos.
const notAsked: ListerResult = {
  ok: true,
  filled: true,
  photosAttached: true,
  photosTotal: 8,
  photosFailed: 0,
  photosWitness: "not-asked",
};

describe("US-2738: PhotoWitnessLine", () => {
  it("says the page refused, and says it as a problem", () => {
    const html = render(refused);
    // A seller must be able to tell at a glance that this one is wrong.
    expect(html).toContain("text-brand-red-text");
    expect(html).toContain("Poshmark never showed the photos it was handed");
    expect(html).toContain("they are not on the listing");
    // And the next step has to be the DIFFERENT mechanism. The same uploader
    // handed the same list produces the same nothing, so "try again" is the one
    // instruction that cannot work here.
    expect(html).toContain("Add them to the form yourself");
    expect(html).not.toMatch(/send (it )?again/i);
  });

  it("confirms without overclaiming", () => {
    const html = render(confirmed);
    expect(html).toContain("previewed the photos we sent");
    // The witness is a BOOLEAN. Some uploaders draw one carousel node for eight
    // files, so "the page took them" is provable and "all eight are there" is
    // not. The line has to say which one it is saying.
    expect(html).toContain("not a count");
    expect(html).toContain("glance at all 8");
    // Not an alarm: a working run must not look like a broken one.
    expect(html).not.toContain("text-brand-red-text");
  });

  it("THE BIG ONE: a channel nobody asked reads as unknown, not as success", () => {
    const html = render(notAsked);
    expect(html).toContain("Nothing confirmed the photos reached Poshmark");
    expect(html).toContain("recorded no answer either way");
    // It must not borrow the confirmation's words. `not-asked` and `page` were
    // both written as `confirmed:false` and `confirmed:true` off the same
    // boolean once, and the whole reason the tri-state exists is that an
    // unchecked claim was indistinguishable from a checked one.
    expect(html).not.toContain("previewed the photos we sent");
    // And it must not be an ALARM either. This fires on every ordinary run of
    // four channels; amber here trains the seller to dismiss the bar that means
    // something.
    expect(html).not.toContain("text-brand-red-text");
  });

  it("an absent witness reads as unknown too, never as success", () => {
    // An install that predates the field sends counts and no witness. Absence
    // is not confirmation.
    const older: ListerResult = {
      ok: true,
      filled: true,
      photosAttached: true,
      photosTotal: 8,
      photosFailed: 0,
    };
    const html = render(older);
    expect(html).toContain("Nothing confirmed the photos reached Poshmark");
    expect(html).not.toContain("previewed the photos we sent");
  });

  it("an install old enough to send no counts is unknown, not silent", () => {
    // The pre-US-1877 boolean: `photosAttached: true` with nothing behind it.
    // Rendering nothing there is what a seller reads as fine.
    const ancient: ListerResult = { ok: true, filled: true, photosAttached: true };
    expect(render(ancient)).toContain("Nothing confirmed the photos reached");
  });

  it("a witness word this build does not know is unknown, not confirmed", () => {
    // Forward compatibility that fails the safe way. A future extension adding
    // a fourth outcome must not have it default into the success sentence.
    const future = {
      ok: true,
      filled: true,
      photosTotal: 8,
      photosFailed: 0,
      photosWitness: "server-echo",
    } as unknown as ListerResult;
    expect(render(future)).toContain("Nothing confirmed the photos reached");
  });

  it("says nothing when there were no photos in play", () => {
    // No file input on the form, or no photos on the item. There is no claim to
    // qualify, and nagging here is how the real message gets ignored.
    expect(render({ ok: true, filled: true, photosTotal: 0, photosFailed: 0 })).toBe("");
  });

  it("the three answers do not render alike", () => {
    // The collapse guard. Two of these being the same markup is precisely the
    // state the story describes: a claim with a witness behind it reading
    // exactly like a claim with none.
    const seen = [render(confirmed), render(refused), render(notAsked)];
    expect(new Set(seen).size).toBe(3);
    expect(seen.every((h) => h !== "")).toBe(true);
  });

  it("names the platform the seller is looking at", () => {
    expect(render(refused, "Mercari")).toContain("Mercari never showed");
    expect(render(notAsked, "Grailed")).toContain("reached Grailed");
  });
});

describe("US-2738: the line is actually wired into the kit", () => {
  // THE WEAKER CHECK, and it is here because the strong one is not available:
  // the panel that owns `lastFill` is built on useQueryClient, supabase and
  // three hooks, and this repo carries no @testing-library/react to mount it.
  // So the rendering above is driven for real and only the WIRING is read off
  // the source. Everything this can catch is a deletion; nothing it says means
  // a branch ran. Treat a green here as "the call site exists", no more.
  it("keeps the fill result and renders the line from it", () => {
    // Repo-root relative, the convention lister-field-notes.test.ts already
    // uses: vitest does not give this file a `file:` import.meta.url.
    const src = readFileSync("src/components/flipdesk/listing-kit.tsx", "utf8");
    expect(src).toContain("setLastFill(res);");
    expect(src).toContain(
      "{lastFill && <PhotoWitnessLine res={lastFill} platformLabel={spec.label} />}",
    );
    // And it must be cleared where the run it describes stops being the current
    // one, or a stale "the page took them" sits over a fresh send.
    expect(src).toContain("setLastFill(null);");
  });
});

describe("US-2738: photoWitnessState", () => {
  it("maps the extension's three words", () => {
    expect(photoWitnessState({ photosWitness: "page", photosTotal: 8 })).toBe("confirmed");
    expect(photoWitnessState({ photosWitness: "none", photosTotal: 8 })).toBe("refused");
    expect(photoWitnessState({ photosWitness: "not-asked", photosTotal: 8 })).toBe("unknown");
  });

  it("everything else that is not a yes is unknown", () => {
    expect(photoWitnessState({ photosTotal: 8 })).toBe("unknown");
    expect(photoWitnessState({ photosWitness: null, photosTotal: 8 })).toBe("unknown");
    expect(photoWitnessState({ photosWitness: "", photosTotal: 8 })).toBe("unknown");
    expect(photoWitnessState({ photosAttached: true })).toBe("unknown");
    expect(photoWitnessState({ photosAttached: false })).toBe("unknown");
  });

  it("separates 'no photos' from 'no answer'", () => {
    // Only the first of these is silence. A run with photos and no witness has
    // something to say.
    expect(photoWitnessState({ photosTotal: 0 })).toBe("nothing-to-attach");
    expect(photoWitnessState({})).toBe("nothing-to-attach");
    expect(photoWitnessState({ photosTotal: 1 })).toBe("unknown");
  });

  it("a witness outranks a missing count", () => {
    // The witness is the page's own answer; the counts are ours. If a build ever
    // sends one without the other, the page wins.
    expect(photoWitnessState({ photosWitness: "none" })).toBe("refused");
    expect(photoWitnessState({ photosWitness: "page" })).toBe("confirmed");
  });
});
