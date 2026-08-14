import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2545. The seller who PAID for the grade could only see the evidence photos
// as thumbnails, while any buyer holding the public certificate link could open
// the same photos full screen. The page also offered two buttons to one place,
// and stacked five post-grade cards below three screens of report detail.

const DETAIL = "src/pages/submission-detail.tsx";
const CERT = "src/pages/certificate.tsx";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("the seller can enlarge the evidence (US-2545 AC2)", () => {
  it("the submitted-photo grid opens the lightbox", () => {
    const src = read(DETAIL);
    expect(src).toContain('from "@/components/certificate/image-lightbox"');
    expect(src).toContain("<ImageLightbox");
    expect(src).toContain("setLightboxIndex(i)");
  });

  it("it is the SAME viewer the certificate uses, not a second one", () => {
    // Two viewers means two sets of keyboard handling, two focus traps, and one
    // of them rotting. Both pages import from the same module.
    const cert = read(CERT);
    const detail = read(DETAIL);
    const from = /from "(@\/components\/certificate\/image-lightbox)"/;
    expect(from.exec(cert)?.[1]).toBe(from.exec(detail)?.[1]);
  });

  it("every thumbnail is a real button, so it is keyboard-reachable", () => {
    const src = read(DETAIL);
    const grid = src.slice(src.indexOf("{images.map((img, i) =>"));
    expect(grid).toContain('type="button"');
    expect(grid).toMatch(/aria-label=\{`View \$\{formatLabel\(img\.image_type\)\} photo full screen`\}/);
  });

  it("the index space is unfiltered, so a click opens the photo clicked", () => {
    // The lightbox is fed `images` straight through. Filtering one side and not
    // the other is how a click on photo 3 opens photo 5.
    const src = read(DETAIL);
    expect(src).toMatch(/images=\{images\.map\(\(img\) => \(\{/);
    expect(src).toContain("images.map((img, i) =>");
  });
});

describe("one destination, one button (US-2545 AC3)", () => {
  it("the dead /dashboard/inventory link is gone", () => {
    // InventoryItemRedirect rewrites /dashboard/inventory/:id to the FlipDesk
    // item page, which the primary button already opened. Two buttons, one
    // place.
    const src = read(DETAIL);
    expect(src).not.toContain("/dashboard/inventory/${linkedItem.id}");
  });

  it("the surviving button still reaches the item", () => {
    const src = read(DETAIL);
    expect(src).toContain("/dashboard/flipdesk/items/${linkedItem.id}");
  });

  it("the redirect it relied on really does collapse the two", () => {
    // If this ever stops being true, a second button becomes worth having
    // again - so the assumption is asserted, not just commented.
    const routes = read("src/routes/index.tsx");
    expect(routes).toContain("/dashboard/inventory/:id");
    expect(routes).toMatch(
      /InventoryItemRedirect[\s\S]{0,300}"\/dashboard\/flipdesk\/items\/"/,
    );
  });
});

describe("the post-grade cards are one section (US-2545 AC4)", () => {
  it("they sit under a single heading", () => {
    const src = read(DETAIL);
    expect(src).toContain("What's next");
  });

  it("the section is gated once, not five times", () => {
    const src = read(DETAIL);
    const start = src.indexOf("What's next");
    expect(start).toBeGreaterThan(-1);
    const open = src.lastIndexOf(
      "{submission.status === \"completed\" && gradeReport && (",
      start,
    );
    expect(open, "the section has no single gate").toBeGreaterThan(-1);
    expect(start - open).toBeLessThan(600);
  });

  it("the dispute card and the photo grid stay OUTSIDE it", () => {
    // Those are status and evidence. Folding them into "what's next" would
    // hide an open dispute behind a heading about selling.
    const src = read(DETAIL);
    const next = src.indexOf("What's next");
    const dispute = src.indexOf("{/* Dispute Status */}");
    const gallery = src.indexOf("{/* Image Gallery */}");
    expect(dispute).toBeGreaterThan(next);
    expect(gallery).toBeGreaterThan(next);
    expect(src.indexOf("</section>")).toBeLessThan(dispute);
  });
});
