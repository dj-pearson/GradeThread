import { supabaseAdmin } from "./supabase.ts";

// Cloudflare zone-level cache purge helper.
//
// Called after publish/edit/archive so the Cloudflare edge cache for
// /blog/<slug>, /blog, /sitemap.xml, /rss.xml flushes immediately —
// otherwise readers would see stale HTML for up to an hour (the
// s-maxage we serve from the SSR worker).
//
// Best-effort: failures log but never throw. The publish flow must
// not depend on this for correctness.

const CF_PURGE_BASE = "https://api.cloudflare.com/client/v4/zones";

interface PurgeOptions {
  // If true, purge everything in the zone (use sparingly — rate-limited).
  purgeEverything?: boolean;
  // Specific URLs to purge. Each must be a full https:// URL.
  files?: string[];
}

async function loadPublicSiteUrl(): Promise<string> {
  // Pull from content_settings.public_site_url if present; fall back to env.
  const { data } = await supabaseAdmin
    .from("content_settings")
    .select("public_site_url")
    .eq("id", 1)
    .maybeSingle();
  const fromDb = (data?.public_site_url as string | undefined)?.trim();
  if (fromDb) return fromDb.replace(/\/$/, "");
  const envUrl = Deno.env.get("PUBLIC_SITE_URL")?.trim();
  return (envUrl ?? "https://gradethread.com").replace(/\/$/, "");
}

// Builds the canonical list of URLs to purge when a blog post changes.
export async function buildBlogPurgeFiles(slug: string): Promise<string[]> {
  const base = await loadPublicSiteUrl();
  return [
    `${base}/blog/${slug}`,
    `${base}/blog`,
    `${base}/sitemap.xml`,
    `${base}/rss.xml`,
  ];
}

export async function purgeCloudflareCache(opts: PurgeOptions): Promise<void> {
  const token = Deno.env.get("CLOUDFLARE_API_TOKEN");
  const zone = Deno.env.get("CLOUDFLARE_ZONE_ID");
  if (!token || !zone) {
    // Not a configuration error in dev — the SSR worker still works,
    // it just won't be force-purged. Log so the operator knows.
    console.log(
      "[cloudflare-purge] skipped: CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID not set",
    );
    return;
  }

  const body = opts.purgeEverything
    ? { purge_everything: true }
    : { files: opts.files ?? [] };
  if (!opts.purgeEverything && (opts.files?.length ?? 0) === 0) return;

  try {
    const res = await fetch(`${CF_PURGE_BASE}/${zone}/purge_cache`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(
        `[cloudflare-purge] failed (${res.status}): ${text.slice(0, 200)}`,
      );
      return;
    }
    console.log(
      `[cloudflare-purge] purged ${
        opts.purgeEverything ? "everything" : `${opts.files?.length ?? 0} files`
      }`,
    );
  } catch (e) {
    console.warn(
      `[cloudflare-purge] threw: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
