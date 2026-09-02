// The weekly auto-publish ceiling must count SOCIAL posts only.
//
// THE BUG. The tick gates social auto-publish on
//
//   if (await aiPublishedLast7Days() >= settings.max_auto_publishes_per_week)
//     autoPublish = false;   // generate, but leave it a draft
//
// and aiPublishedLast7Days() summed blog_posts AND social_posts. Blog is
// exempt from the ceiling by product decision (2026-06: articles publish on
// completion, uncapped) and runs at post_cadence_per_day_blog=2, so blog alone
// puts 14 rows into the 7-day window against a cap of 10. Every social tick
// therefore hit the ceiling before a single social post had published: the
// generator succeeded, the post was demoted to draft, and the run log said
// "success". Measured on prod 2026-09-02: 16 AI blog posts in the window,
// 0 social, cap 10, and every generated social post sitting in drafts.
//
// THE FIX. Only the surface the ceiling governs counts toward it.

import { assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

// supabase-js reads `count` from the content-range header of a HEAD-style
// count query. The admin client resolves globalThis.fetch ONCE, on first use,
// so the stub is installed before the first call and kept for the whole file;
// each test just changes the totals it serves. A different total per table lets
// the assertion tell which one the function believed.
const counts: Record<string, number> = {};
const hits: string[] = [];
globalThis.fetch = ((input: Request | URL | string) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.href
    : input.url;
  const table = new URL(url).pathname.split("/").pop() ?? "";
  hits.push(table);
  const n = counts[table] ?? 0;
  return Promise.resolve(
    new Response(null, {
      status: 200,
      headers: { "content-range": `0-${Math.max(n - 1, 0)}/${n}` },
    }),
  );
}) as typeof fetch;

const { aiPublishedLast7Days } = await import("../routes/content-scheduler.ts");

function serve(next: Record<string, number>) {
  for (const k of Object.keys(counts)) delete counts[k];
  Object.assign(counts, next);
  hits.length = 0;
}

Deno.test("blog publishes do not count toward the social weekly ceiling", async () => {
  serve({ blog_posts: 16, social_posts: 0 });
  assertEquals(await aiPublishedLast7Days(), 0);
  assertEquals(hits.includes("blog_posts"), false, "blog_posts was queried");
  assertEquals(
    hits.includes("social_posts"),
    true,
    "social_posts was not queried",
  );
});

Deno.test("social publishes still count", async () => {
  serve({ blog_posts: 16, social_posts: 3 });
  assertEquals(await aiPublishedLast7Days(), 3);
});
