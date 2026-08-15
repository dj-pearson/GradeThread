// POST /help/feedback — the no-JavaScript path for "was this helpful?" (US-2591).
//
// WHY THIS EXISTS AT ALL. The obvious implementation is a fetch() from the
// article page. That works for most people and silently excludes everybody with
// scripts off, which on a public help page is a real share of the audience and
// exactly the audience least able to get an answer another way.
//
// So the widget is an ordinary HTML form posting SAME-ORIGIN to this Function,
// which forwards to the edge and 303s the reader back to the article with a
// thank-you. No JavaScript, no CORS, no cross-site form post.
//
// A more specific route beats the [[path]] catch-all next door, and the catch-all
// only exports onRequestGet in any case. "feedback" is in RESERVED_HELP_SLUGS on
// both sides so no article or category can ever claim this path.

import { edgeApi, siteUrl, type PagesEnv } from "../_shared/blog-render";

type Ctx = EventContext<PagesEnv, string, Record<string, unknown>>;

export const onRequestPost: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { request, env } = context;
  const base = siteUrl(env);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.redirect(`${base}/help`, 303);
  }

  const slug = String(form.get("slug") ?? "").trim().toLowerCase();
  const categorySlug = String(form.get("category") ?? "").trim().toLowerCase();
  const helpful = String(form.get("helpful") ?? "");
  const comment = String(form.get("comment") ?? "");

  // Where to send them back to. Built from the form's own fields and validated,
  // never from a redirect parameter — an open redirect on a public page is a
  // phishing primitive, and this form is on every article.
  const safeSlug = /^[a-z0-9-]{1,80}$/.test(slug) ? slug : null;
  const safeCategory = /^[a-z0-9-]{1,80}$/.test(categorySlug) ? categorySlug : null;
  const back = safeSlug && safeCategory
    ? `${base}/help/${safeCategory}/${safeSlug}?thanks=1`
    : `${base}/help`;

  if (!safeSlug || (helpful !== "yes" && helpful !== "no")) {
    return Response.redirect(back, 303);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // US-781: identify the Pages origin so the public rate limiter does not treat
  // every visitor's vote as coming from one address.
  const originSecret = env.CF_PAGES_ORIGIN_SECRET?.trim();
  if (originSecret) headers["x-pages-origin"] = originSecret;

  try {
    await fetch(
      `${edgeApi(env)}/api/content/public/help/${encodeURIComponent(safeSlug)}/feedback`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ helpful, comment: comment.slice(0, 1000) }),
        signal: AbortSignal.timeout(5_000),
      } as RequestInit,
    );
  } catch (e) {
    // Best-effort. A lost vote under-reports; a visible error on a page somebody
    // was only trying to be helpful on is worse than the missing datum.
    console.warn("[help/feedback] forward failed:", e);
  }

  return Response.redirect(back, 303);
};
