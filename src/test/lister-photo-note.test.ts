// US-1877 (AC4): what the seller is told about the photos after a prefill.
//
// THE BUG. attachPhotos returned a bare boolean, true if ANY photo landed. So a
// 6-of-8 attach reported clean success: the seller was told the photos were
// attached, published a listing missing two, and found out from a buyer. The two
// failures were invisible on the way through too — a non-ok fetch was silently
// `continue`d.
//
// The copy IS the fix here, so it is what gets tested. The extension now reports
// { attached, failed, total } and this turns it into the sentence the seller reads
// at the one moment they can still act on it — before they hit Submit.

import { describe, it, expect } from "vitest";
import { photoNote } from "@/components/flipdesk/listing-kit";

describe("US-1877: photo attach reporting", () => {
  it("says nothing when every photo attached", () => {
    // Silence is correct — there is nothing for the seller to do.
    expect(photoNote({ photosAttached: true, photosTotal: 8, photosFailed: 0 })).toBe("");
  });

  it("THE BIG ONE: a partial attach names the real numbers", () => {
    // This is the case that used to read as success.
    const note = photoNote({ photosAttached: false, photosTotal: 8, photosFailed: 2 });
    expect(note).toMatch(/6 of 8/);
    expect(note).toMatch(/drag the rest in/i);
  });

  it("a partial attach is reported even if the old boolean says attached", () => {
    // Defence in depth: photosAttached is now only true when failed === 0, but the
    // counts are the authority. If those ever disagree, the counts win — reporting
    // success over a known failure is the exact bug this story exists for.
    const note = photoNote({ photosAttached: true, photosTotal: 8, photosFailed: 2 });
    expect(note).toMatch(/6 of 8/);
  });

  it("distinguishes 'none attached' from 'some attached'", () => {
    // Different actions: drag ALL of them in, vs drag the rest in.
    const none = photoNote({ photosAttached: false, photosTotal: 8, photosFailed: 8 });
    expect(none).toMatch(/didn't attach/i);
    expect(none).not.toMatch(/0 of 8/);
  });

  it("stays quiet when there was nothing to attach", () => {
    // No file input on the form, or no photos on the item. Not a failure — nagging
    // here would train the seller to ignore the message that does matter.
    expect(photoNote({ photosAttached: true, photosTotal: 0, photosFailed: 0 })).toBe("");
  });

  it("US-2775: an unconfirmed attach neither claims success nor cries wolf", () => {
    // The page took the file list only through the shadow fallback, where the
    // only thing saying the photos landed is the extension reading back what it
    // just wrote. Silence would repeat US-2738's silent false success; "didn't
    // attach" would be a different lie, on hosts where the shadow works fine.
    const note = photoNote({
      photosAttached: true,
      photosTotal: 8,
      photosFailed: 0,
      photosUnverified: 8,
    });
    expect(note).not.toBe("");
    expect(note).toMatch(/couldn't confirm/i);
    // Not a failure claim: nothing here tells them to drag anything in.
    expect(note).not.toMatch(/drag/i);
  });

  it("US-2775: a real failure still reads as a failure, not as a doubt", () => {
    // The third state must not swallow the second. A refusal reports every photo
    // failed AND unverified 0, and the seller has to be told to drag them in.
    const note = photoNote({
      photosAttached: false,
      photosTotal: 8,
      photosFailed: 8,
      photosUnverified: 0,
    });
    expect(note).toMatch(/didn't attach/i);
  });

  it("US-2775: a confirmed attach carries no hedge", () => {
    // The mirror. A run the browser confirmed must stay silent, or the warning
    // fires on every ordinary send and stops meaning anything.
    expect(
      photoNote({ photosAttached: true, photosTotal: 8, photosFailed: 0, photosUnverified: 0 }),
    ).toBe("");
  });

  it("US-2738: a refusal by the PAGE names the refusal, not just the count", () => {
    // `none` is the uploader taking the file selection and rendering nothing out
    // of it. attachPhotos converts that to every photo failed, so without the
    // witness this lands on "Photos didn't attach" and the seller sends again
    // into the same wall.
    const note = photoNote({
      photosAttached: false,
      photosTotal: 8,
      photosFailed: 8,
      photosWitness: "none",
    });
    expect(note).toMatch(/never showed them/i);
    expect(note).toMatch(/not on the listing/i);
    // The instruction has to be the DIFFERENT mechanism, and it has to say why.
    expect(note).toMatch(/add them to the form yourself/i);
    expect(note).toMatch(/sending again will not help/i);
  });

  it("US-2738: 'page' settles the shadow hedge instead of doubting it", () => {
    // The page rendered a preview out of our bytes, so the uploader read the
    // list however it was set. Hedging anyway would fire a false alarm on the
    // only channel that can answer at all.
    expect(
      photoNote({
        photosAttached: true,
        photosTotal: 8,
        photosFailed: 0,
        photosUnverified: 8,
        photosWitness: "page",
      }),
    ).toBe("");
  });

  it("US-2738: 'page' does NOT silence a real partial failure", () => {
    // The witness is boolean and the counts are not. A confirmed preview says
    // the uploader read the list; it says nothing about the two photos we never
    // managed to fetch, and swallowing those would be this story's own bug.
    const note = photoNote({
      photosAttached: false,
      photosTotal: 8,
      photosFailed: 2,
      photosWitness: "page",
    });
    expect(note).toMatch(/6 of 8/);
  });

  it("US-2738: 'not-asked' adds no warning of its own", () => {
    // Four channels declare no preview selector and run this way every time.
    // "We could not check" belongs in the record, not in a toast, or the seller
    // learns to close the toast.
    expect(
      photoNote({
        photosAttached: true,
        photosTotal: 8,
        photosFailed: 0,
        photosWitness: "not-asked",
      }),
    ).toBe("");
    // But it must not swallow the shadow hedge either: unconfirmed by the
    // browser AND unasked of the page is still something to say.
    expect(
      photoNote({
        photosAttached: true,
        photosTotal: 8,
        photosFailed: 0,
        photosUnverified: 8,
        photosWitness: "not-asked",
      }),
    ).toMatch(/couldn't confirm/i);
  });

  it("US-2738: an absent witness leaves every older message exactly as it was", () => {
    // A build that sends no witness must read as it did yesterday. Only an
    // explicit `none` gets the new sentence.
    expect(
      photoNote({ photosAttached: false, photosTotal: 8, photosFailed: 8 }),
    ).toMatch(/didn't attach/i);
    expect(
      photoNote({ photosAttached: true, photosTotal: 8, photosFailed: 0 }),
    ).toBe("");
  });

  it("falls back to the old boolean for an extension that predates the counts", () => {
    // A seller on the previous build sends no counts. Undefined totals must not be
    // read as "0 of 0 attached" — fall back to the boolean rather than inventing a
    // number.
    expect(photoNote({ photosAttached: true })).toBe("");
    expect(photoNote({ photosAttached: false })).toMatch(/drag your downloaded photos in/i);
  });
});
