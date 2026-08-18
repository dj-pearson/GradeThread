// Apply the US-9017 CTR rewrites to the blog posts that live in the database.
//
// WHY A SCRIPT. Eleven of the nineteen URLs in docs/seo/ctr-rewrite-worklist.csv
// are registry routes, so their titles are code and ship with the build. The
// other eight are /blog/ posts, whose SERP copy is `blog_posts.seo_title` and
// `blog_posts.seo_description` — rows an admin can also edit in the UI. A
// migration cannot own those columns without fighting the editor for them, so
// the CSV is the drafting surface and this is the one-way import.
//
// IT ONLY TOUCHES SERP COPY. `title` (the on-page H1 and every internal link
// label) is left exactly as it is. functions/blog/[[path]].ts:300 reads
// `post.seo_title || post.title`, so writing seo_title changes what Google
// shows and nothing a reader sees on the page. That split is the whole point:
// the rewrite is a SERP experiment, reversible by nulling one column.
//
// IT NEVER CLOBBERS SILENTLY. A post whose seo_title already differs from both
// the CSV's `current_title` and its `proposed_title` has been edited by someone
// since the worklist was captured; that row is reported and skipped unless
// --force is passed. Re-running after a successful pass is a no-op.
//
// Usage:
//   node scripts/apply-blog-ctr-rewrites.mjs                  # dry run (default)
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/apply-blog-ctr-rewrites.mjs --apply
//   … --apply --force    overwrite rows that were edited after the worklist

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKLIST = resolve(process.cwd(), "docs/seo/ctr-rewrite-worklist.csv");
const BLOG_PREFIX = "/blog/";

// Blog titles get no " | GradeThread" suffix (functions/blog/[[path]].ts builds
// the <title> from seo_title verbatim), so the whole 60-char SERP cap is
// available — unlike the 46 the registry routes have to fit into.
const TITLE_MAX = 60;
const DESC_MIN = 70;
const DESC_MAX = 160;

/** RFC4180-enough CSV reader: quoted fields, doubled quotes, embedded commas. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** The blog rows of the worklist, as {slug, currentTitle, title, description}. */
export function blogRewrites(csvText) {
  return parseCsv(csvText)
    .filter((r) => r.url.startsWith(BLOG_PREFIX))
    .map((r) => ({
      slug: r.url.slice(BLOG_PREFIX.length),
      currentTitle: r.current_title,
      title: r.proposed_title,
      description: r.proposed_meta_description,
      impressions: Number(r.impressions_6mo),
      ctr: Number(r.ctr_actual_pct),
    }));
}

/** Reasons a rewrite must not ship. Empty array means it is good to write. */
export function validate(rewrite) {
  const problems = [];
  if (!rewrite.slug) problems.push("empty slug");
  if (!rewrite.title.trim()) problems.push("empty proposed_title");
  if (rewrite.title.length > TITLE_MAX)
    problems.push(`title ${rewrite.title.length} chars (max ${TITLE_MAX})`);
  if (rewrite.description.length < DESC_MIN || rewrite.description.length > DESC_MAX)
    problems.push(
      `description ${rewrite.description.length} chars (want ${DESC_MIN}-${DESC_MAX})`,
    );
  return problems;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const rewrites = blogRewrites(readFileSync(WORKLIST, "utf8"));
  console.log(`[ctr] ${rewrites.length} blog rewrite(s) in the worklist`);

  let invalid = 0;
  for (const r of rewrites) {
    const problems = validate(r);
    if (problems.length) {
      console.error(`  INVALID ${r.slug}: ${problems.join("; ")}`);
      invalid++;
    }
  }
  if (invalid) {
    console.error(`[ctr] ${invalid} row(s) fail the SERP budget — fix the CSV first`);
    process.exit(1);
  }

  if (!apply) {
    for (const r of rewrites) {
      console.log(`  ${r.slug}`);
      console.log(`     was  ${r.currentTitle}`);
      console.log(`     now  ${r.title}`);
      console.log(`     ${r.impressions} impressions at ${r.ctr}% CTR`);
    }
    console.log("[ctr] dry run — nothing written. Pass --apply to write.");
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("[ctr] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(1);
  }
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  const slugs = rewrites.map((r) => r.slug);
  const query = `slug=in.(${slugs.map((s) => `"${s}"`).join(",")})`;
  const res = await fetch(
    `${url}/rest/v1/blog_posts?select=slug,title,seo_title,seo_description&${query}`,
    { headers },
  );
  if (!res.ok) {
    console.error(`[ctr] could not read blog_posts: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const live = new Map((await res.json()).map((p) => [p.slug, p]));

  let written = 0;
  let skipped = 0;
  let missing = 0;
  for (const r of rewrites) {
    const post = live.get(r.slug);
    if (!post) {
      console.error(`  missing ${r.slug} — no blog_posts row with that slug`);
      missing++;
      continue;
    }
    if (post.seo_title === r.title && post.seo_description === r.description) {
      console.log(`  same   ${r.slug} (already carries this rewrite)`);
      skipped++;
      continue;
    }
    // The worklist's current_title is what the SERP showed when it was
    // captured; the DB shows either that (via seo_title) or nothing (falling
    // back to title). Anything else means a human edited the row since.
    const untouched =
      post.seo_title === null ||
      post.seo_title === r.currentTitle ||
      post.title === r.currentTitle;
    if (!untouched && !force) {
      console.log(
        `  edited ${r.slug} — seo_title is "${post.seo_title}", not the "${r.currentTitle}" the worklist captured. Skipped; pass --force to overwrite.`,
      );
      skipped++;
      continue;
    }
    const patch = await fetch(
      `${url}/rest/v1/blog_posts?slug=eq.${encodeURIComponent(r.slug)}`,
      {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify({ seo_title: r.title, seo_description: r.description }),
      },
    );
    if (!patch.ok) {
      console.error(`  FAIL   ${r.slug}: ${patch.status} ${await patch.text()}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`  wrote  ${r.slug}`);
    written++;
  }
  console.log(
    `[ctr] ${written} written, ${skipped} skipped, ${missing} missing of ${rewrites.length}`,
  );
  if (missing) process.exitCode = 1;
}

// Importable for the test; only runs the import when invoked directly.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).endsWith("apply-blog-ctr-rewrites.mjs");
if (invokedDirectly) await main();
