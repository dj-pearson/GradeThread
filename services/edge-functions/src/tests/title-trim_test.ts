// US-546: keyword-priority title trimming — never mid-word, never a dangling
// separator, leading (highest-priority) keywords preserved.

import { assertEquals } from "@std/assert";
import {
  EBAY_TITLE_MAX,
  normalizeTitleWhitespace,
  trimTitleToLimit,
  trimTitleWithReport,
} from "../lib/title-trim.ts";

Deno.test("short titles pass through unchanged (whitespace normalized)", () => {
  assertEquals(trimTitleToLimit("Nike  Air   Max 90"), "Nike Air Max 90");
});

Deno.test("trims on a word boundary, never mid-word", () => {
  // 81 chars: a blind slice(0,80) would cut the final word; we drop it whole.
  const title =
    "Vintage Patagonia Synchilla Fleece Jacket Mens Large Deep Pile Retro Outdoor Coatzz";
  const out = trimTitleToLimit(title, 80);
  assertEquals(out.length <= 80, true);
  // No partial word at the end — the result is a prefix ending on a whole word.
  assertEquals(title.startsWith(out), true);
  assertEquals(out.endsWith("Coatzz"), false);
});

Deno.test("never leaves a dangling separator at the end", () => {
  const title = "Levis 501 Original Fit Mens Jeans -" + " " + "x".repeat(80);
  const out = trimTitleToLimit(title, 40);
  assertEquals(/[\s\-/|,;:.&+]$/.test(out), false);
});

Deno.test("preserves the highest-priority leading keywords", () => {
  const title =
    "Supreme Box Logo Hoodie Black Large FW20 Authentic Streetwear Rare Deadstock Grail";
  const out = trimTitleToLimit(title, 80);
  // Brand + item type (the words that rank) survive; trailing terms drop first.
  assertEquals(out.startsWith("Supreme Box Logo Hoodie Black Large"), true);
});

Deno.test("hard-slices a single word longer than the limit", () => {
  const out = trimTitleToLimit("Supercalifragilisticexpialidocious", 10);
  assertEquals(out, "Supercalif");
});

Deno.test("report surfaces the dropped trailing words in order", () => {
  const title = "Brand Item Type Color Size Extra1 Extra2 Extra3";
  const { trimmed, droppedWords, title: out } = trimTitleWithReport(title, 30);
  assertEquals(trimmed, true);
  assertEquals(out.length <= 30, true);
  // Dropped words are the trailing (lowest-priority) ones.
  assertEquals(droppedWords[droppedWords.length - 1], "Extra3");
  // Reconstructing kept + dropped equals the original word sequence.
  assertEquals(
    [...out.split(" "), ...droppedWords].join(" "),
    normalizeTitleWhitespace(title),
  );
});

Deno.test("report flags untrimmed titles as not trimmed", () => {
  const { trimmed, droppedWords } = trimTitleWithReport("Short Title", 80);
  assertEquals(trimmed, false);
  assertEquals(droppedWords, []);
});

Deno.test("default limit is eBay's 80 chars", () => {
  assertEquals(EBAY_TITLE_MAX, 80);
  const out = trimTitleToLimit("word ".repeat(40));
  assertEquals(out.length <= 80, true);
});
