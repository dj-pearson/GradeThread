#!/usr/bin/env node
// US-2594 — move every support_kb_articles row into help_articles.
//
// WHY A SCRIPT AND NOT A MIGRATION. help_articles.body_html is NOT NULL, and the
// public reader renders from it. Markdown-to-HTML in SQL is not something to
// invent for a one-off, and the repo already has a tested renderer
// (scripts/seed-help-articles.mjs → markdownToHtml) that the seeded help content
// went through. Using it means the migrated articles render exactly like the
// hand-written ones instead of nearly like them.
//
// DRY RUN BY DEFAULT. It prints what it would write, per category, and changes
// nothing until --apply. Read the counts first: two entries in the category map
// are judgement calls (see vault/20-domain/help-corpus-convergence.md), and the
// counts are how you check them BEFORE the rows move rather than after.
//
// A SLUG COLLISION IS A STOP, NOT A MERGE. help_articles.slug is unique
// case-insensitively across the whole corpus, and a collision means a
// hand-written help article already owns that URL. Overwriting it would destroy
// content nobody asked to replace; skipping silently would leave the assistant
// quoting the old wording forever. So collisions are reported by name and the
// run refuses to apply until they are resolved by hand.
//
// ORDER MATTERS AND IT IS NOT SYMMETRIC: this runs BEFORE retrieval is
// repointed at help_articles. The other order leaves the assistant reading an
// empty corpus, where its designed behaviour is to say it does not know — a
// failure that is quiet, polite and total.
//
//   node scripts/migrate-support-kb-to-help.mjs            # dry run
//   node scripts/migrate-support-kb-to-help.mjs --apply
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service role: both tables
// are service-role-only for writes).

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { markdownToHtml } from "./seed-help-articles.mjs";

/**
 * Nine support-KB categories onto the fourteen help categories.
 *
 * The first five are exact. `pricing` and `plans` both land on `billing`,
 * because the help taxonomy does not split them and inventing two categories
 * for a handful of rows would leave the sidebar lopsided.
 *
 * `photos` and `disputes` are JUDGEMENT, and the vault note says so in the same
 * words: photos → grading assumes submission photos rather than listing
 * photography, and disputes → troubleshooting assumes a something-went-wrong
 * path rather than grade appeals. The per-category counts this script prints
 * are how you check that assumption before applying.
 */
export const CATEGORY_MAP = Object.freeze({
  grading: "grading",
  flipdesk: "flipdesk",
  billing: "billing",
  account: "account",
  getting_started: "getting-started",
  pricing: "billing",
  plans: "billing",
  photos: "grading",
  disputes: "troubleshooting",
});

/** Every category_key the map can emit must exist in help_categories (00602). */
export const HELP_CATEGORY_KEYS = Object.freeze([
  "getting-started",
  "grading",
  "certificates",
  "flipdesk",
  "marketplaces",
  "autolister",
  "extension",
  "mobile",
  "buyers",
  "billing",
  "team",
  "integrations",
  "troubleshooting",
  "account",
]);

export function mapCategory(category) {
  const key = CATEGORY_MAP[category];
  // An unmapped category is a STOP. The source CHECK constraint allows exactly
  // nine values, so a tenth means the constraint was widened without this map
  // being updated — and guessing a destination would file a customer-facing
  // answer under a heading nobody chose.
  if (!key) throw new Error(`unmapped support_kb category: ${JSON.stringify(category)}`);
  return key;
}

/**
 * audience → visibility. `subscriber` becomes `members`, NOT `internal`.
 *
 * The old model had two values and the new one has three, so the migration has
 * to pick, and picking wrong in the `internal` direction would hide a
 * customer-facing answer from customers. Picking wrong the other way would
 * publish an operator runbook — but `support_kb_articles` never held those; it
 * has no internal tier at all, which is what makes this safe rather than lucky.
 */
export function mapVisibility(audience) {
  if (audience === "public") return "public";
  if (audience === "subscriber") return "members";
  throw new Error(`unmapped support_kb audience: ${JSON.stringify(audience)}`);
}

export function mapStatus(isPublished) {
  return isPublished ? "published" : "draft";
}

/**
 * Demote a top-level `# Heading` to `##`.
 *
 * FOUND BY THE TEST, not by reading: `markdownToHtml` handles `##` and `###`
 * and NOT `#`, so a `# Heading` renders as the literal paragraph
 * `<p># Heading</p>`. That is correct for the seeded help corpus — the article
 * title is the page's h1, so bodies start at h2, and all 83 seeded files do —
 * but nothing ever held the support KB to that convention, and a body written
 * with `#` would migrate into visible hash marks on a customer-facing page.
 *
 * Demoting in the MARKDOWN rather than patching the renderer keeps the two
 * columns telling the same story: `body_markdown` is the `/.md` mirror, so
 * fixing only the HTML would leave the mirror showing a heading the page does
 * not have. And the shared renderer's behaviour is right for the corpus it was
 * written for; changing it to accommodate an import would be the wrong end.
 */
export function demoteTopHeadings(md) {
  return String(md ?? "").replace(/^# (?!#)/gm, "## ");
}

/**
 * A summary for a row that has none.
 *
 * `support_kb_articles` has no summary column and `help_articles.summary` is
 * NOT NULL, so the first version of this script wrote `""`. That degrades
 * correctly rather than breaking — the SSR uses `article.summary ||
 * HELP_HUB_DESCRIPTION` and the article list omits the paragraph on a falsy
 * value, so there is no empty description tag and no stray empty `<p>`. What it
 * does produce is EIGHT public pages sharing one generic meta description,
 * which is a duplicate-description signal to a crawler and a blank row in the
 * category listing next to hand-written neighbours that have one.
 *
 * So it derives one from the first real paragraph. Sized against the corpus
 * rather than guessed: the 83 hand-written summaries run 93–200 characters,
 * averaging 133, so the cap is 200 and the target is a whole sentence.
 *
 * It is deliberately CONSERVATIVE about what counts as prose — headings, code
 * fences, list items and blockquotes are skipped, because a summary reading
 * "```bash" or "- Step one" is worse than the empty string it replaces.
 */
export function deriveSummary(md, max = 200) {
  const lines = String(md ?? "").split(/\r?\n/);
  const paragraph = [];
  let inFence = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!t) { if (paragraph.length) break; continue; }
    // Not prose: headings, list items, blockquotes, tables, images.
    if (/^(#{1,6}\s|[-*+]\s|\d+\.\s|>|\||!\[)/.test(t)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(t);
  }
  // Strip the markup a summary should never carry through.
  const text = paragraph
    .join(" ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images → their text
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= max) return text;

  // Prefer a whole sentence, fall back to a word boundary. Never mid-word.
  const window = text.slice(0, max + 1);
  const lastSentence = Math.max(
    window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "),
  );
  if (lastSentence >= 60) return text.slice(0, lastSentence + 1);
  const lastSpace = window.lastIndexOf(" ");
  return text.slice(0, lastSpace > 0 ? lastSpace : max).trimEnd() + "…";
}

/** One source row → the help_articles insert payload. Pure. */
export function toHelpArticle(row, renderer = markdownToHtml) {
  const bodyMd = demoteTopHeadings(row.body_md ?? "");
  return {
    slug: String(row.slug ?? "").trim(),
    title: String(row.title ?? "").trim(),
    summary: deriveSummary(bodyMd),
    body_markdown: bodyMd,
    body_html: renderer(bodyMd),
    category_key: mapCategory(row.category),
    visibility: mapVisibility(row.audience),
    status: mapStatus(Boolean(row.is_published)),
    // published_at is what the freshness clock and the sitemap read. Carrying
    // the source's updated_at rather than now() keeps an article that has been
    // stable for a year from looking brand new the day it moves.
    published_at: row.is_published ? (row.updated_at ?? null) : null,
    reviewed_at: row.updated_at ?? null,
  };
}

/** Case-insensitive, because that is how the unique index compares slugs. */
export function findCollisions(sourceRows, existingSlugs) {
  const existing = new Set(existingSlugs.map((s) => String(s).toLowerCase()));
  return sourceRows
    .map((r) => String(r.slug ?? "").trim())
    .filter((s) => existing.has(s.toLowerCase()))
    .sort();
}

export function summarise(payloads) {
  const byCategory = {};
  const byVisibility = {};
  const byStatus = {};
  for (const p of payloads) {
    byCategory[p.category_key] = (byCategory[p.category_key] ?? 0) + 1;
    byVisibility[p.visibility] = (byVisibility[p.visibility] ?? 0) + 1;
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  }
  return { total: payloads.length, byCategory, byVisibility, byStatus };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(2);
  }
  const base = url.replace(/\/+$/, "");
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  const get = async (path) => {
    const res = await fetch(`${base}/rest/v1/${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
    return res.json();
  };

  const source = await get(
    "support_kb_articles?select=slug,title,body_md,category,audience,is_published,updated_at",
  );
  const existing = await get("help_articles?select=slug");
  console.log(`source rows: ${source.length}   existing help articles: ${existing.length}`);

  const collisions = findCollisions(source, existing.map((r) => r.slug));
  if (collisions.length > 0) {
    console.error(
      `\nREFUSING: ${collisions.length} slug(s) already exist in help_articles:\n  ` +
        `${collisions.join("\n  ")}\n\n` +
        "A hand-written help article already owns that URL. Decide per slug " +
        "which wording survives, then re-run. Nothing was written.",
    );
    process.exit(1);
  }

  const payloads = source.map((r) => toHelpArticle(r));
  const s = summarise(payloads);
  console.log(`\nwould write ${s.total} article(s)`);
  console.log("  by category:  ", JSON.stringify(s.byCategory));
  console.log("  by visibility:", JSON.stringify(s.byVisibility));
  console.log("  by status:    ", JSON.stringify(s.byStatus));

  if (!apply) {
    console.log(
      "\nDRY RUN — nothing written. Check the category counts against " +
        "vault/20-domain/help-corpus-convergence.md (photos and disputes are " +
        "judgement calls), then re-run with --apply.",
    );
    return;
  }

  const res = await fetch(`${base}/rest/v1/help_articles`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(payloads),
  });
  if (!res.ok) throw new Error(`insert failed → ${res.status} ${await res.text()}`);
  console.log(`\nwrote ${payloads.length} article(s).`);
  console.log(
    "NEXT, in this order: ship the retrieval repoint (support-tools.ts, " +
      "agent-tools.ts), then retire /admin/support/kb.",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
