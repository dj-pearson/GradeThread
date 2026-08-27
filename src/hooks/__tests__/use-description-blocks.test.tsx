// US-2960 AC6: convert-on-open must not change what a buyer sees.
//
// GET /:listingId/blocks hands back BOTH the parsed blocks and the string they
// render to. The temptation is to take the blocks and ask /preview for the
// string, which reads as the same thing and is not: a second render is a second
// chance to normalise whitespace, and the live descriptions in the wild carry a
// single newline before the credential block and three before the measurements
// one. So the guarantee here is negative as much as positive — the preview shown
// is the byte string the server sent, and no preview request is made until the
// seller changes something.
//
// Rendered through createRoot + act, the repo's convention where a hook's
// EFFECTS are the thing under test (see query-boundary.test.tsx). There is no
// @testing-library here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDescriptionBlocks } from "@/hooks/use-description-blocks";
import { DEFAULT_DESCRIPTION_BLOCKS } from "@/lib/description-blocks";
import { PREVIEW_DEBOUNCE_MS } from "@/lib/description-preview";
import type { DescriptionBlock } from "@/types/database";

const edgeFetch = vi.fn();
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: (...args: unknown[]) => edgeFetch(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The real 2026-08 shape: a single newline before the credential block and three
// before the measurements one. Normalising either is the failure this guards.
const STORED = [
  "Veronica Beard jogger-style pants, new with tags.",
  "",
  "",
  "<!--gradethread-measurements-->",
  "- Waist (flat): 30 in",
  "<!--/gradethread-measurements-->",
  "<!--gradethread-seller-credentials--><div>23 items</div>",
].join("\n");

const PARSED: DescriptionBlock[] = [
  { key: "text", on: true, src: "user", text: "Veronica Beard jogger-style pants, new with tags." },
  { key: "measurements", on: true, src: "item", sep: "\n\n\n" },
  { key: "credentials", on: true, src: "seller", sep: "\n" },
];

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let seen: ReturnType<typeof useDescriptionBlocks> | null = null;

function Probe({ listingId }: { listingId: string | null }) {
  seen = useDescriptionBlocks({
    listingId,
    unit: "in",
    seed: DEFAULT_DESCRIPTION_BLOCKS as DescriptionBlock[],
  });
  return null;
}

async function render(listingId: string | null) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(h(Probe, { listingId }));
  });
}

beforeEach(() => {
  edgeFetch.mockReset();
  seen = null;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe("useDescriptionBlocks convert-on-open (US-2960 AC6)", () => {
  it("shows the legacy parse and its preview byte for byte, with no second render", async () => {
    edgeFetch.mockResolvedValueOnce(
      ok({ blocks: PARSED, preview: STORED, converted: true }),
    );

    await render("listing-1");

    expect(seen!.blocks).toEqual(PARSED);
    expect(seen!.converted).toBe(true);
    // The bytes, exactly. Not "starts with", not trimmed.
    expect(seen!.preview).toBe(STORED);

    // GET only. A /preview call here would be a second render of the same
    // blocks, which is where the whitespace would quietly change.
    expect(edgeFetch).toHaveBeenCalledTimes(1);
    expect(edgeFetch.mock.calls[0]![0]).toBe(
      "/api/flipdesk/description/listing-1/blocks?unit=in",
    );
  });

  it("asks for a render once the seller actually edits a block", async () => {
    edgeFetch.mockResolvedValueOnce(
      ok({ blocks: PARSED, preview: STORED, converted: true }),
    );
    await render("listing-1");
    edgeFetch.mockResolvedValue(ok({ preview: "edited render" }));

    vi.useFakeTimers();
    await act(async () => {
      seen!.setBlocks([{ ...PARSED[0]!, text: "New opening line." }, ...PARSED.slice(1)]);
    });
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    vi.useRealTimers();
    await act(async () => {});

    expect(edgeFetch).toHaveBeenCalledTimes(2);
    expect(edgeFetch.mock.calls[1]![0]).toBe("/api/flipdesk/description/preview");
    expect(seen!.preview).toBe("edited render");
  });

  it("refuses to save a listing whose blocks never arrived", async () => {
    // Migration 00678 is not applied everywhere yet, and where it is missing the
    // GET 404s. Saving from the placeholder rows would render a description out
    // of empty prose and overwrite a real one.
    edgeFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    await render("listing-1");

    expect(seen!.ready).toBe(false);
    const result = await act(async () => seen!.save("listing-1"));
    expect(result).toBeNull();
    expect(edgeFetch).toHaveBeenCalledTimes(1); // the failed GET, and nothing else
  });

  it("saves a listing that has no row yet from the local seed", async () => {
    await render(null);
    expect(seen!.ready).toBe(true);
    expect(edgeFetch).not.toHaveBeenCalled();

    edgeFetch.mockResolvedValueOnce(
      ok({ blocks: PARSED, description: "rendered after save" }),
    );
    let saved: string | null = null;
    await act(async () => {
      saved = await seen!.save("listing-new");
    });
    expect(saved).toBe("rendered after save");
    expect(edgeFetch.mock.calls[0]![0]).toBe(
      "/api/flipdesk/description/listing-new/save",
    );
    expect(seen!.preview).toBe("rendered after save");
  });
});
