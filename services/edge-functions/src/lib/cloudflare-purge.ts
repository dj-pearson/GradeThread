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

// US-577: every public surface that re-renders a certificate's grade — the SSR
// HTML page plus the three image renderers (OG share card, embeddable badge,
// "slab" graphic), all of which encode the numeric score and so go stale on a
// score change (dispute resolution / review adjustment).
export async function buildCertPurgeFiles(certId: string): Promise<string[]> {
  const base = await loadPublicSiteUrl();
  const id = encodeURIComponent(certId);
  return [
    `${base}/cert/${id}`,
    `${base}/og/cert/${id}`,
    `${base}/badge/cert/${id}`,
    `${base}/slab/cert/${id}`,
  ];
}

// US-577: a verified seller's public profile SSR page + its OG share card. The
// profile aggregates the seller's certified grades, so it goes stale when the
// profile is edited/toggled (and, indirectly, when one of their grades changes).
export async function buildSellerPurgeFiles(handle: string): Promise<string[]> {
  const base = await loadPublicSiteUrl();
  const h = encodeURIComponent(handle);
  return [`${base}/verified/${h}`, `${base}/og/verified/${h}`];
}

/** True only when the Cloudflare purge API is configured (token + zone set). */
export function cloudflarePurgeConfigured(): boolean {
  return !!Deno.env.get("CLOUDFLARE_API_TOKEN") && !!Deno.env.get("CLOUDFLARE_ZONE_ID");
}

// US-577: best-effort convenience wrappers used by the publish/score-change
// write paths. They short-circuit (and skip the content_settings lookup) when
// Cloudflare isn't configured, and never throw — a purge failure must not fail
// the originating mutation. Fire-and-forget with `.catch()` at the call site.
export async function purgeCertificateCache(certId: string): Promise<void> {
  if (!certId || !cloudflarePurgeConfigured()) return;
  try {
    const files = await buildCertPurgeFiles(certId);
    await purgeCloudflareCache({ files });
  } catch (e) {
    console.warn(
      `[cloudflare-purge] cert ${certId} purge skipped: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export async function purgeSellerProfileCache(handle: string): Promise<void> {
  if (!handle || !cloudflarePurgeConfigured()) return;
  try {
    const files = await buildSellerPurgeFiles(handle);
    await purgeCloudflareCache({ files });
  } catch (e) {
    console.warn(
      `[cloudflare-purge] seller ${handle} purge skipped: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
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
