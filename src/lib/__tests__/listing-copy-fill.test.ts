// US-2442: the composer had no way to reach POST /api/flipdesk/ai/listing-copy,
// the one AI text route that writes a title and a description from nothing.
// /rewrite covers the neighbouring case (text that already exists) and refuses
// an empty title outright, so an item saved from capture arrived in the composer
// with no AI path at all.
//
// Two things are asserted here: the pure translation into the shape AiFillPanel
// reviews, and the wiring: that the entry point exists, that it is NOT gated on
// the title it exists to write, and that its result is confirmed rather than
// dropped into the seller's fields. The wiring half reads source text, which is
// this directory's convention for composer guards (see helpers/composer-source).
import { describe, it, expect } from "vitest";
import {
  LISTING_COPY_CONFIDENCE,
  LISTING_COPY_SOURCE,
  listingCopyToFill,
} from "@/lib/listing-copy-fill";
import { composerAll, composerSections } from "./helpers/composer-source";
import type { ListingCopyResponse } from "@/hooks/use-ai-extract";

function response(
  over: Partial<ListingCopyResponse> = {},
): ListingCopyResponse {
  return {
    title: "Patagonia Better Sweater Fleece Jacket Womens M Grey",
    description: "Full-zip fleece in excellent condition.\nChest 20in flat.",
    model: "claude-sonnet",
    log_id: "log-1",
    actions_remaining: 42,
    ...over,
  };
}

describe("listingCopyToFill", () => {
  it("offers both fields, because one action buys both", () => {
    const fill = listingCopyToFill(response());
    expect(Object.keys(fill.suggestions).sort()).toEqual([
      "description",
      "title",
    ]);
    expect(fill.suggestions.title?.value).toContain("Patagonia");
    expect(fill.suggestions.description?.value).toContain("Full-zip");
  });

  it("carries log_id through so acceptance is still measurable", () => {
    // AiFillPanel PATCHes /ai/log/:id with what the seller kept. Dropping the id
    // here would leave generated copy the one AI output with no acceptance rate.
    expect(listingCopyToFill(response()).log_id).toBe("log-1");
    expect(listingCopyToFill(response({ log_id: null })).log_id).toBeNull();
  });

  it("passes the model and the remaining allowance through unchanged", () => {
    const fill = listingCopyToFill(response({ actions_remaining: 0 }));
    expect(fill.model).toBe("claude-sonnet");
    expect(fill.actions_remaining).toBe(0);
  });

  it("does not claim a confidence the route never returned", () => {
    // write_listing_copy's tool schema requires only { title, description }, so
    // there is no model self-score to pass on. The panel badges every row, so a
    // number is unavoidable, but it must not be a High one.
    const fill = listingCopyToFill(response());
    expect(fill.suggestions.title?.confidence).toBe(LISTING_COPY_CONFIDENCE);
    expect(LISTING_COPY_CONFIDENCE).toBeLessThan(0.8);
    expect(fill.suggestions.description?.source).toBe(LISTING_COPY_SOURCE);
  });

  it("drops a blank field instead of offering a row that cannot be accepted", () => {
    const fill = listingCopyToFill(response({ description: "   " }));
    expect(Object.keys(fill.suggestions)).toEqual(["title"]);
  });

  it("trims, so leading whitespace never lands in an 80-char title", () => {
    const fill = listingCopyToFill(response({ title: "  Levis 501 W32  " }));
    expect(fill.suggestions.title?.value).toBe("Levis 501 W32");
  });

  it("returns the empty halves of the extract shape the panel reads", () => {
    // The panel renders conflicts and the condition summary; this route
    // produces neither, and a missing key would read as undefined at runtime.
    const fill = listingCopyToFill(response());
    expect(fill.conflicts).toEqual([]);
    expect(fill.condition_summary).toBeNull();
    expect(fill.measurements).toBeNull();
    expect(fill.ebay).toBeNull();
  });
});

describe("composer wiring (US-2442)", () => {
  const titleCard = composerSections["title-card.tsx"] ?? "";

  it("calls the listing-copy hook that had no call site", () => {
    expect(composerAll).toContain("useListingCopy");
    expect(composerAll).toContain("listingCopyToFill");
    expect(composerAll).toContain("listingCopy.mutateAsync({ item_id: item.id })");
  });

  it("puts the entry point where an EMPTY title can reach it", () => {
    // The bug this closes is a cold start, so a control gated on the title
    // would reproduce it. The AI-rewrite trigger beside it carries exactly that
    // gate; this one must not.
    expect(titleCard).toContain("runListingCopy");
    const button = titleCard.slice(
      titleCard.indexOf("onClick={runListingCopy}") - 700,
      titleCard.indexOf("onClick={runListingCopy}"),
    );
    expect(button).not.toContain("title.trim()");
    expect(button).toContain("disabled={isEbayOrigin || listingCopy.isPending");
  });

  it("says it writes the description too, before the action is spent", () => {
    // It lives in the Title card and writes two fields; the label is what makes
    // that a decision rather than a surprise.
    expect(titleCard).toContain("Write title &amp; description");
    expect(titleCard).toMatch(/title AND buyer description/);
  });

  it("confirms the result through the same panel every other suggestion uses", () => {
    // Filling the seller's title and description without review is the thing to
    // avoid, so the result goes into AiFillPanel's state, not into setTitle.
    expect(composerAll).toContain("setAiCopyResult(listingCopyToFill(res))");
    expect(composerAll).toContain("setAiCopyPanelOpen(true)");
    expect(composerAll).toMatch(/result=\{aiCopyResult\}/);
  });

  it("stops the two producers from racing for that one panel", () => {
    // Both write title/description into the same review state. Concurrent runs
    // would let the slower answer replace the one being read, after paying for
    // both.
    expect(composerAll).toContain(
      "if (aiRewrite.isPending || listingCopy.isPending) return;",
    );
    expect(composerAll).toContain("if (listingCopy.isPending) return;");
  });

  it("keeps the eBay-origin lock (eBay owns both fields on a mirror)", () => {
    expect(titleCard).toContain("disabled={isEbayOrigin || listingCopy.isPending");
  });
});
