import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { finishedRunNote, marketplaceLabel } from "@/lib/finished-queue-run";

// US-3425: a queued cross-post that RAN and still wants the seller.
//
// The danger this guards is not a missing feature, it is a WRONG SENTENCE.
// The edge gave these rows their own key precisely because the two lists the
// web app already renders would both lie about them, and one of the two lies
// costs money: "Nothing happened on the marketplace, do it there yourself, or
// queue it again", said about a run that DID happen, makes a seller post the
// same garment twice.

const ROOT = resolve(__dirname, "../..");
const MARKETPLACES = readFileSync(
  resolve(ROOT, "src/pages/flipdesk/marketplaces.tsx"),
  "utf8",
);
const ROUTE = readFileSync(
  resolve(ROOT, "services/edge-functions/src/routes/flipdesk-extension-queue.ts"),
  "utf8",
);
const HOOK = readFileSync(resolve(ROOT, "src/hooks/use-extension-queue.ts"), "utf8");

describe("one finished run, one sentence (US-3425)", () => {
  it("photos the page refused is the alarm, and it says the listing has none", () => {
    // The failure the whole US-2738 chain is named after, on the queued path.
    const note = finishedRunNote("poshmark", {
      photosWitness: "none",
      photosTotal: 8,
    });
    expect(note.severity).toBe("alarm");
    expect(note.sentence).toContain("Poshmark");
    expect(note.sentence).toMatch(/no images/i);
  });

  it("a partial attach counts, because 2 of 8 is not 'some'", () => {
    const note = finishedRunNote("mercari", { photosTotal: 8, photosFailed: 2 });
    expect(note.severity).toBe("alarm");
    expect(note.sentence).toContain("2 of 8");
  });

  it("a run that asked to be finished by hand says so, quietly", () => {
    const note = finishedRunNote("depop", { manual: true });
    expect(note.severity).toBe("notice");
    expect(note.sentence).toMatch(/by hand/i);
  });

  it("an unconfirmed save never claims it saved", () => {
    // `unverified` exists precisely because nothing proved it took. A sentence
    // that rounds that up to success is the bug, not the wording.
    const note = finishedRunNote("grailed", { unverified: true });
    expect(note.sentence).toMatch(/could not confirm/i);
    expect(note.sentence).not.toMatch(/\bsaved\.\s*$/i);
  });

  it("the server's own error text is shown, not reworded into something vaguer", () => {
    const note = finishedRunNote("vinted", { error: "The size field was rejected." });
    expect(note.sentence).toContain("The size field was rejected.");
  });

  it("every cause the edge qualifies a row on produces a sentence", () => {
    // Read the causes out of finishedNeedsReview() rather than listing them
    // here, so a new cause on the edge fails this instead of arriving with no
    // words -- which is the exact gap this story exists to close.
    const body = ROUTE.slice(
      ROUTE.indexOf("export function finishedNeedsReview"),
      ROUTE.indexOf("* The finished runs that still want a human"),
    );
    const causes: [string, object][] = [
      ['result.photosWitness === "none"', { photosWitness: "none", photosTotal: 4 }],
      ["result.photosFailed", { photosTotal: 4, photosFailed: 1 }],
      ["result.manual === true", { manual: true }],
      ["result.unverified === true", { unverified: true }],
      ["result.error", { error: "x" }],
    ];
    for (const [needle, result] of causes) {
      expect(body, `the edge no longer qualifies on ${needle}`).toContain(needle);
      const note = finishedRunNote("poshmark", result);
      expect(note.sentence.length, `no sentence for ${needle}`).toBeGreaterThan(10);
    }
    // Fail closed: if the slice stopped matching, every toContain above would
    // fail, but an empty body would also make the count meaningless.
    expect(body.length).toBeGreaterThan(200);
  });

  it("a row with no result still renders words rather than an empty line", () => {
    expect(finishedRunNote("poshmark", null).sentence.length).toBeGreaterThan(10);
    expect(finishedRunNote("poshmark", {}).sentence.length).toBeGreaterThan(10);
  });

  it("only a safe listing url becomes a link", () => {
    expect(finishedRunNote("poshmark", { listingUrl: "https://poshmark.com/x" }).href)
      .toBe("https://poshmark.com/x");
    expect(finishedRunNote("poshmark", { listingUrl: "javascript:alert(1)" }).href)
      .toBeNull();
    expect(finishedRunNote("poshmark", {}).href).toBeNull();
  });

  it("an unknown platform is named rather than dropped", () => {
    expect(marketplaceLabel("poshmark")).toBe("Poshmark");
    expect(marketplaceLabel("some-new-place")).toBe("some-new-place");
  });
});

describe("the third list is wired and cannot borrow the other two's words (US-3425)", () => {
  it("the client type carries every list the route returns", () => {
    // The whole defect: the route answered with four keys and the hook
    // declared three, so the third list was invisible to every web surface.
    const returned = ROUTE.slice(ROUTE.indexOf("return c.json({", ROUTE.indexOf('get("/"')));
    for (const key of ["pending", "needsAttention", "finishedNeedsReview", "lastDrainedAt"]) {
      expect(returned, `the route stopped returning ${key}`).toContain(`${key}:`);
      expect(HOOK, `the hook does not read ${key}`).toContain(`${key}:`);
    }
    // And it is defaulted, so an edge older than US-3370 renders empty rather
    // than throwing on a missing key.
    expect(HOOK).toContain("finishedNeedsReview: json.finishedNeedsReview ?? []");
  });

  it("the page renders the third list with its own heading", () => {
    expect(MARKETPLACES).toContain("finishedNeedsReview");
    expect(MARKETPLACES).toContain("Ran, and needs you");
    expect(MARKETPLACES).toContain("finishedRunNote");
  });

  it("a finished row never borrows either dangerous sentence", () => {
    // Scoped to the block, not the file: the two sentences legitimately exist
    // above it for the lists they belong to.
    const block = MARKETPLACES.slice(
      MARKETPLACES.indexOf("Ran, and needs you"),
      MARKETPLACES.indexOf("finished.map("),
    );
    expect(block).not.toMatch(/Runs in your desktop browser/);
    expect(block).not.toMatch(/Nothing happened on the marketplace/);
    expect(block).not.toMatch(/queue it again/i);
    // And it says the opposite out loud, because the seller's instinct after
    // seeing a problem row is to re-queue it.
    expect(block).toMatch(/do not queue them again/i);
  });

  it("the widget counts these apart from failed, and puts them first", () => {
    const widget = readFileSync(
      resolve(ROOT, "src/components/dashboard/widgets/flipdesk-extension-queue.tsx"),
      "utf8",
    );
    expect(widget).toContain("finishedNeedsReview.length");
    // A live listing with something wrong on it outranks work that has not
    // happened yet, so its branch has to be tested before `failed`.
    expect(widget.indexOf("ranAndNeedsYou > 0")).toBeLessThan(
      widget.indexOf("failed > 0", widget.indexOf("sub={")),
    );
  });
});
