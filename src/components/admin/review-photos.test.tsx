import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ReviewPhotos } from "./review-photos";

let root: Root;
let container: HTMLDivElement;
const photos = [
  { id: "front", image_type: "front", signed_url: "https://example.test/front.jpg" },
  { id: "back", image_type: "back", signed_url: "https://example.test/back.jpg" },
  { id: "label", image_type: "label", signed_url: null },
];

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === label || element.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

async function loadPhoto() {
  const img = document.querySelector<HTMLImageElement>('img[alt$=" inspection"]');
  if (!img) throw new Error("Missing inspection photo");
  Object.defineProperties(img, { naturalWidth: { value: 2400 }, naturalHeight: { value: 1800 } });
  await act(async () => img.dispatchEvent(new Event("load")));
  return img;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe() { this.callback(); }
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(
    <Dialog defaultOpen>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Garment review</DialogTitle>
        <textarea aria-label="Review notes" defaultValue="Small tear at cuff" />
        <ReviewPhotos images={photos} />
      </DialogContent>
    </Dialog>,
  ));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("review photo inspection", () => {
  it("uses the original photo, bounds zoom, and resets on navigation", async () => {
    await click("Enlarge front photo 1");
    const img = await loadPhoto();
    expect(img.src).toBe(photos[0]?.signed_url);
    expect(img.style.width).toBe("800px");
    await click("Zoom in");
    expect(img.style.width).toBe("1200px");
    for (let i = 0; i < 20; i++) await click("Zoom in");
    expect(button("Zoom in").disabled).toBe(true);
    expect(document.querySelector("output")?.textContent).toBe("8x");
    await click("Fit photo");
    expect(img.style.width).toBe("800px");
    expect(button("Zoom out").disabled).toBe(true);
    await click("Zoom in");
    await click("Next photo");
    expect(document.querySelector("output")?.textContent).toBe("1x");
    expect(document.querySelector('img[alt="back inspection"]')?.getAttribute("src")).toBe(photos[1]?.signed_url);
  });

  it("Escape closes only the photo viewer and preserves review notes", async () => {
    const trigger = button("Enlarge front photo 1");
    trigger.focus();
    await click("Enlarge front photo 1");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('img[alt="front inspection"]')).toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Small tear at cuff");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Garment review");
    expect(document.activeElement).toBe(trigger);
  });

  it("reports failed or unavailable photos and prevents zooming them", async () => {
    expect(document.querySelector('[aria-label="Enlarge label photo 3"]')).toBeNull();
    await click("Enlarge back photo 2");
    const img = document.querySelector('img[alt="back inspection"]');
    await act(async () => img?.dispatchEvent(new Event("error")));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Photo unavailable");
    expect(button("Zoom in").disabled).toBe(true);
    await click("Next photo");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Photo unavailable");
    expect(button("Next photo").disabled).toBe(true);
  });
});
