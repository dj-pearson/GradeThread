// Import the drafted help articles in content/help/ into help_articles.
//
// WHY A SCRIPT AND NOT A MIGRATION. Migrations are immutable. Seeding thirteen
// articles through one would mean the first typo could never be corrected in
// place, and re-running the directory would either clobber whatever an admin
// had since edited in the UI or need an ON CONFLICT DO NOTHING that quietly
// diverges from the file. So the markdown files are the DRAFTING surface, the
// database is the LIVE surface, and this is a deliberate one-way import.
//
// IT NEVER OVERWRITES. An existing slug is skipped and reported. Once an
// article is live, the admin editor owns it; the file is then only history.
// `--force` exists for the case where you genuinely mean to re-import, and it
// says so loudly before it does.
//
// Usage:
//   node scripts/seed-help-articles.mjs --dry-run
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/seed-help-articles.mjs
//   … --force        re-import over existing rows (destructive to UI edits)

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const CONTENT_DIR = resolve(process.cwd(), "content/help");
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

// ── frontmatter ───────────────────────────────────────────
// A deliberately small parser: key: value, plus `faq:` as a list of
// `- q: …` / `  a: …` pairs. Anything richer belongs in the editor, not here.

export function parseArticle(raw, filename) {
  const text = raw.replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${filename}: no frontmatter block`);
  const [, head, body] = m;

  const meta = {};
  const faq = [];
  let inFaq = false;
  let pending = null;

  for (const line of head.split("\n")) {
    if (/^faq:\s*$/.test(line)) {
      inFaq = true;
      continue;
    }
    if (inFaq) {
      const q = line.match(/^\s*-\s*q:\s*(.+)$/);
      const a = line.match(/^\s{2,}a:\s*(.+)$/);
      if (q) {
        if (pending) faq.push(pending);
        pending = { question: unquote(q[1]), answer: "" };
        continue;
      }
      if (a && pending) {
        pending.answer = unquote(a[1]);
        continue;
      }
      if (/^\w+:/.test(line)) inFaq = false;
      else continue;
    }
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = unquote(kv[2]);
  }
  if (pending) faq.push(pending);

  const required = ["slug", "title", "category", "summary", "visibility"];
  for (const k of required) {
    if (!meta[k]) throw new Error(`${filename}: missing "${k}"`);
  }
  const cleanBody = body.trim();
  if (!cleanBody) throw new Error(`${filename}: empty body`);

  return {
    slug: meta.slug,
    title: meta.title,
    category_key: meta.category,
    summary: meta.summary,
    visibility: meta.visibility,
    status: meta.status || "published",
    audience: meta.audience || "all",
    sort_order: Number(meta.sort_order ?? 0),
    pillar_path: meta.pillar_path || null,
    faq: faq.filter((f) => f.question && f.answer),
    body_markdown: cleanBody,
    body_html: markdownToHtml(cleanBody),
    // Never null: the freshness clock (US-2591) reads this, and an article that
    // has just been written HAS just been reviewed.
    reviewed_at: new Date().toISOString(),
    published_at: new Date().toISOString(),
  };
}

function unquote(s) {
  const t = (s ?? "").trim();
  return t.replace(/^["'](.*)["']$/, "$1");
}

/**
 * The narrow slice of Markdown these articles use: h2/h3, paragraphs, ordered
 * and unordered lists, links, inline code, bold. Not a general converter — a
 * general converter is a dependency, and the editor is where richer formatting
 * happens after import.
 */
export function markdownToHtml(md) {
  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  const out = [];
  let list = null; // "ul" | "ol"
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const rawLine of md.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    // Comments (the SCREENSHOT markers) pass through untouched so the admin
    // sees exactly what to capture, in place.
    if (/^<!--/.test(line.trim())) {
      closeList();
      out.push(line.trim());
      continue;
    }
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      closeList();
      out.push(`<h3>${inline(h3[1])}</h3>`);
      continue;
    }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      closeList();
      out.push(`<h2>${inline(h2[1])}</h2>`);
      continue;
    }
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line.trim())}</p>`);
  }
  closeList();
  return out.join("\n");
}

export function loadArticles(dir = CONTENT_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseArticle(readFileSync(join(dir, f), "utf8"), f));
}

// ── the import itself ─────────────────────────────────────

async function main() {
  const articles = loadArticles();
  console.log(`[seed-help] parsed ${articles.length} article(s) from content/help/`);

  if (dryRun) {
    for (const a of articles) {
      console.log(
        `  ${a.slug.padEnd(34)} ${a.category_key.padEnd(16)} ${a.visibility.padEnd(8)} ` +
          `${a.body_markdown.split(/\s+/).length} words, ${a.faq.length} faq`,
      );
    }
    console.log("[seed-help] dry run — nothing written");
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("[seed-help] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(1);
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  // Which slugs already exist. Read first so the report can say "skipped"
  // rather than relying on a conflict the caller never sees.
  const existingRes = await fetch(`${url}/rest/v1/help_articles?select=slug`, { headers });
  if (!existingRes.ok) {
    console.error(`[seed-help] could not read help_articles: ${existingRes.status}`);
    process.exit(1);
  }
  const existing = new Set((await existingRes.json()).map((r) => r.slug));

  let inserted = 0;
  let skipped = 0;
  for (const a of articles) {
    if (existing.has(a.slug) && !force) {
      console.log(`  skip   ${a.slug} (already live — the editor owns it now)`);
      skipped++;
      continue;
    }
    const res = await fetch(`${url}/rest/v1/help_articles`, {
      method: "POST",
      headers: {
        ...headers,
        Prefer: force ? "resolution=merge-duplicates" : "return=minimal",
      },
      body: JSON.stringify(a),
    });
    if (!res.ok) {
      console.error(`  FAIL   ${a.slug}: ${res.status} ${await res.text()}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`  ${force ? "upsert" : "insert"} ${a.slug}`);
    inserted++;
  }
  console.log(`[seed-help] ${inserted} written, ${skipped} skipped`);
  if (force) {
    console.log(
      "[seed-help] --force was used: any admin edits to those articles have been overwritten.",
    );
  }
}

// Importable for tests; only runs the import when invoked directly.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
    process.argv[1]?.endsWith("seed-help-articles.mjs")) {
  await main();
}
