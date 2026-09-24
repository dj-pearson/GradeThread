import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisputeEvidencePicker } from "@/components/grade/dispute-evidence-picker";
import {
  addEvidenceFiles,
  dataUrlBytes,
  prepareEvidence,
  MAX_DISPUTE_EVIDENCE,
} from "@/lib/dispute-evidence";

// SUB-10: dispute evidence fits the request, stops at 8, and each photo can be
// removed from the keyboard.

const MB = 1024 * 1024;
const EDGE_LIMIT = 15 * MB; // UPLOAD_MAX_BYTES, middleware/body-limit.ts

function jpeg(name: string, bytes = 10): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
}

/** A data URL of exactly the length a blob of that size encodes to. */
async function fakeDataUrl(blob: Blob): Promise<string> {
  return "x".repeat(dataUrlBytes(blob.size));
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  let n = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:fake/${n++}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("the evidence cap (SUB-10)", () => {
  it("a 9th file is refused client-side", () => {
    const eight = Array.from({ length: 8 }, (_, i) => jpeg(`p${i}.jpg`));
    expect(addEvidenceFiles(eight, [jpeg("p8.jpg")])).toEqual({ photos: eight, refused: 1 });
    expect(MAX_DISPUTE_EVIDENCE).toBe(8);
  });

  it("says so, visibly", () => {
    let photos = Array.from({ length: 7 }, (_, i) => jpeg(`p${i}.jpg`));
    const render = () =>
      root.render(
        <DisputeEvidencePicker photos={photos} onChange={(next) => (photos = next)} />,
      );
    act(render);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = [jpeg("a.jpg"), jpeg("b.jpg")];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(render);
    expect(photos).toHaveLength(8);
    expect(container.textContent).toContain("8 of 8");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "You can attach up to 8 photos. 1 photo was not added.",
    );
    expect(input.disabled).toBe(true);
  });
});

describe("removing a photo (SUB-10)", () => {
  it("each thumbnail has a real, labelled remove button", () => {
    let photos = [jpeg("a.jpg"), jpeg("b.jpg"), jpeg("c.jpg")];
    act(() =>
      root.render(<DisputeEvidencePicker photos={photos} onChange={(n) => (photos = n)} />),
    );
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove photo 2"]',
    );
    expect(button?.type).toBe("button");
    // A native button is in the tab order and activates on Enter; the old chip
    // was a span with a click handler.
    button!.focus();
    expect(document.activeElement).toBe(button);
    act(() => button!.click());
    expect(photos.map((p) => p.name)).toEqual(["a.jpg", "c.jpg"]);
    expect(container.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
  });
});

describe("the request fits the edge body limit (SUB-10)", () => {
  const fourFiveMb = () => Array.from({ length: 4 }, (_, i) => jpeg(`big${i}.jpg`, 5 * MB));

  it("four 5 MB photos, compressed, produce a body under 15 MB", async () => {
    // What compressImage does to a 12 MP photo at 1600px / q0.85: well under 1 MB.
    const compress = vi.fn(async () => new Blob([new Uint8Array(700 * 1024)]));
    const out = await prepareEvidence(fourFiveMb(), compress, fakeDataUrl);
    expect(compress).toHaveBeenCalledTimes(4);
    expect(out.overBudget).toBe(false);
    const body = JSON.stringify({ gradeReportId: "x", reason: "r", images: out.images });
    expect(body.length).toBeLessThan(EDGE_LIMIT);
  });

  it("if compression cannot shrink them, the page refuses before sending", async () => {
    // Raw 5 MB files are 6.7 MB each as base64: 26.7 MB, which the edge 413s.
    const out = await prepareEvidence(fourFiveMb(), async (f) => f, fakeDataUrl);
    expect(out.overBudget).toBe(true);
  });

  it("the dialog compresses before encoding and checks the budget", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/pages/submission-detail.tsx", "utf8");
    expect(src).toContain("await prepareEvidence(");
    expect(src).toContain("compressImage(file, EVIDENCE_MAX_WIDTH, EVIDENCE_QUALITY)");
    expect(src).toMatch(/if \(prepared\.overBudget\) \{\s*setEvidenceTooLarge\(true\);\s*return;/);
  });
});
