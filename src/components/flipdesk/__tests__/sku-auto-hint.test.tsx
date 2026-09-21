// US-3418: the line under the SKU box, and the inventory banner.
//
// renderToStaticMarkup is this repo's convention (@testing-library is not a
// dependency), so these assert exactly what a seller would see rendered.
//
// The case that matters most is the LOADING one, and it is the one that would
// never be noticed if it broke. The other two states are visible the moment
// anyone opens the page; a hint that renders a placeholder while the setting
// loads pushes the form down and then moves it again half a second later, under
// somebody who is already typing. Nobody files that bug, and everybody feels it.
//
// The carry rule and the SKU strings are not exercised here. They do not live
// in TypeScript -- scripts/check-sku-sequences.mjs proves them against a real
// Postgres, and src/test/sku-odometer-single-home.test.ts fails the build if a
// copy shows up in this directory.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { SKU_NUMBERING_HREF } from "@/lib/sku-presets";

const state = {
  sequence: null as unknown,
  nextSku: null as string | null,
  isEnabled: false,
  isExhausted: false,
  isLoading: false,
};

vi.mock("@/hooks/use-sku-sequence", () => ({
  SKU_SEQUENCE_KEY: "sku_sequence",
  SKU_PREVIEW_KEY: "sku_preview",
  useSkuSequence: () => state,
}));

const { SkuAutoHint, SkuExhaustedBanner } = await import(
  "@/components/flipdesk/sku-auto-hint"
);

function render(
  Component: typeof SkuAutoHint,
  over: Partial<typeof state> = {},
): string {
  Object.assign(state, {
    sequence: null,
    nextSku: null,
    isEnabled: false,
    isExhausted: false,
    isLoading: false,
  }, over);
  return renderToStaticMarkup(
    <MemoryRouter>
      <Component />
    </MemoryRouter>,
  );
}

describe("SkuAutoHint", () => {
  it("names the exact number this item will get", () => {
    const html = render(SkuAutoHint, { isEnabled: true, nextSku: "J1035" });
    expect(html).toContain("J1035");
    expect(html).toMatch(/Leave blank/);
  });

  it("offers to switch numbering on when it is off", () => {
    const html = render(SkuAutoHint);
    expect(html).toMatch(/Number these automatically/);
    expect(html).toContain(`href="${SKU_NUMBERING_HREF}"`);
  });

  it("renders nothing at all while the setting is loading", () => {
    // Not "renders a placeholder". Anything here shifts the form under the
    // seller a moment after they start typing in it.
    expect(render(SkuAutoHint, { isLoading: true })).toBe("");
  });

  it("stays silent when numbering is on but the number has not arrived", () => {
    // "We will number this" without being able to say WHICH number is worse
    // than waiting a beat: the number is the whole reassurance.
    expect(render(SkuAutoHint, { isEnabled: true, nextSku: null })).toBe("");
  });

  it("says the numbers ran out rather than promising one", () => {
    const html = render(SkuAutoHint, { isExhausted: true });
    expect(html).toMatch(/run out/);
    expect(html).toMatch(/without one/);
    expect(html).not.toMatch(/Leave blank/);
  });

  it("points every state that links anywhere at the settings screen", () => {
    for (const over of [
      {},
      { isEnabled: true, nextSku: "0042" },
      { isExhausted: true },
    ]) {
      expect(render(SkuAutoHint, over)).toContain(`href="${SKU_NUMBERING_HREF}"`);
    }
  });
});

describe("SkuExhaustedBanner", () => {
  it("warns only when the sequence is actually used up", () => {
    expect(render(SkuExhaustedBanner)).toBe("");
    expect(render(SkuExhaustedBanner, { isEnabled: true, nextSku: "0042" })).toBe("");
    expect(render(SkuExhaustedBanner, { isLoading: true })).toBe("");
  });

  it("explains what is happening to items saved right now", () => {
    const html = render(SkuExhaustedBanner, { isExhausted: true });
    expect(html).toMatch(/Every number in this pattern has been used/);
    expect(html).toMatch(/saving without a SKU/);
    expect(html).toContain(`href="${SKU_NUMBERING_HREF}"`);
  });

  it("offers a way out, and honours it on the next render", () => {
    // The banner is not an error the seller can fix in one click -- widening the
    // pattern is a trip to another screen -- so it has to be dismissible, or it
    // sits across every inventory view until they get to it.
    expect(render(SkuExhaustedBanner, { isExhausted: true })).toContain(
      'aria-label="Dismiss"',
    );

    // Session-scoped on purpose: gone for today, back tomorrow while the
    // pattern is still full, because items are still saving without a SKU.
    try {
      sessionStorage.setItem("sku-exhausted-dismissed", "1");
      expect(render(SkuExhaustedBanner, { isExhausted: true })).toBe("");
    } finally {
      sessionStorage.removeItem("sku-exhausted-dismissed");
    }
    expect(render(SkuExhaustedBanner, { isExhausted: true })).not.toBe("");
  });

  it("uses the settings screen's wording word for word", () => {
    // A seller who sees both should not have to work out whether they are being
    // told about one problem or two. If the settings copy changes, this fails
    // and the two are brought back together deliberately.
    const banner = render(SkuExhaustedBanner, { isExhausted: true });
    const settingsCopy = "Every number in this pattern has been used.";
    expect(banner).toContain(settingsCopy);

    // Resolved from the repo root, not from import.meta.url: under vitest that
    // is not a file: URL and readFileSync rejects it outright.
    const page = readFileSync(
      resolve(process.cwd(), "src/pages/flipdesk/sku-numbering.tsx"),
      "utf8",
    );
    expect(page).toContain(settingsCopy);
  });
});
