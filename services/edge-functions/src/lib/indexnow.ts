// IndexNow instant-indexing client (US-296).
//
// IndexNow lets us notify Bing, Yandex, Naver, and Seznam the moment a URL is
// published or changed, instead of waiting for a crawl. One POST to
// api.indexnow.org is shared with every participating engine. (Google does not
// participate; it relies on the sitemap + Search Console — and its old
// sitemap-ping endpoint is deprecated.)
//
// Best-effort by contract: this NEVER throws into the request path. A failed
// submission just means slightly slower indexing, never a failed publish.
//
// Setup: generate a key (32–128 hex chars), set INDEXNOW_KEY, and host the key
// file at https://<host>/<INDEXNOW_KEY>.txt containing exactly the key
// (functions/[key].txt resolves this dynamically — see functions/indexnow-key).

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

function publicSiteUrl(): string {
  const envUrl = Deno.env.get("PUBLIC_SITE_URL")?.trim();
  return (envUrl ?? "https://gradethread.com").replace(/\/$/, "");
}

/** The configured IndexNow key, or null when unset (submission no-ops). */
export function indexNowKey(): string | null {
  return Deno.env.get("INDEXNOW_KEY")?.trim() || null;
}

/**
 * Submit one or more absolute URLs to IndexNow. No-ops (logs) when INDEXNOW_KEY
 * is unset. Returns the HTTP status (or null when skipped/failed) for logging
 * and tests; never throws.
 */
export async function submitUrls(urls: string[]): Promise<number | null> {
  const key = indexNowKey();
  if (!key) {
    console.log("[indexnow] skipped: INDEXNOW_KEY not set");
    return null;
  }
  const list = Array.from(new Set(urls.filter((u) => u && u.startsWith("http"))));
  if (list.length === 0) return null;

  const base = publicSiteUrl();
  const host = new URL(base).host;
  const payload = {
    host,
    key,
    keyLocation: `${base}/${key}.txt`,
    urlList: list,
  };

  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[indexnow] submit failed (${res.status}) for ${list.length} url(s): ${text.slice(0, 200)}`,
      );
    } else {
      console.log(`[indexnow] submitted ${list.length} url(s) → ${res.status}`);
    }
    return res.status;
  } catch (e) {
    console.warn(
      `[indexnow] threw: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/** Convenience: submit a single path (joined to PUBLIC_SITE_URL) or absolute URL. */
export function certificateUrl(certificateId: string): string {
  return `${publicSiteUrl()}/cert/${certificateId}`;
}
