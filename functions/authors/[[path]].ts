// Catch-all Pages Function for the public author (E-E-A-T) pages (US-874).
// Handles:
//   /authors            → index (every author with a bio)
//   /authors/<slug>     → one author: bio, credentials, sameAs, and their posts
//
// Like the blog SSR, this Function only fires for /authors paths; the SPA's
// `/* /index.html 200` redirect only matches paths NOT served by Functions.

import {
  breadcrumbListLd,
  escape,
  fetchJson,
  formatDate,
  ga4MeasurementId,
  notFoundResponse,
  renderBreadcrumbs,
  renderSsrResponse,
  renderAuthorBio,
  renderAuthorCredentials,
  profilePageLd,
  siteUrl,
  SSR_CACHE_CONTROL,
  twitterSiteHandle,
  socialProfileUrls,
  withEdgeCache,
  type PagesEnv,
  type PublicAuthor,
  type PublicPostListItem,
} from "../_shared/blog-render";

interface AuthorResponse {
  author: PublicAuthor;
  posts: PublicPostListItem[];
}

interface AuthorsIndexResponse {
  authors: Array<PublicAuthor & { post_count?: number }>;
}

type Ctx = EventContext<PagesEnv, "path", Record<string, unknown>>;

export const onRequestGet: PagesFunction<PagesEnv> = (context: Ctx) =>
  withEdgeCache(context, () => routeAuthors(context));

async function routeAuthors(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, ""); // strip trailing slash

  const segments =
    path === "/authors" ? [] : path.replace(/^\/authors\//, "").split("/");

  if (segments.length === 0) {
    return renderIndex(env);
  }
  if (segments.length === 1) {
    return renderAuthor(env, segments[0] ?? "");
  }
  return notFoundResponse(env);
}

async function renderIndex(env: PagesEnv): Promise<Response> {
  const data = await fetchJson<AuthorsIndexResponse>(
    env,
    "/api/content/public/authors.json",
  );
  if (!data) {
    return new Response("Authors temporarily unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain", "Retry-After": "30" },
    });
  }

  const canonical = `${siteUrl(env)}/authors`;
  const authors = data.authors ?? [];
  const cards = authors
    .map(
      (a) => `<a class="author-card" href="/authors/${escape(a.slug)}">
  <h3>${escape(a.name)}</h3>
  ${a.title ? `<p>${escape(a.title)}</p>` : ""}
</a>`,
    )
    .join("");

  const breadcrumbItems = [
    { name: "GradeThread", url: `${siteUrl(env)}/` },
    { name: "Authors", url: canonical },
  ];

  const bodyHtml = `${renderBreadcrumbs(breadcrumbItems, siteUrl(env), { wide: true })}
  <main class="container container--wide">
  <h1>GradeThread Authors</h1>
  <p style="color:var(--muted);margin-bottom:32px">The people behind the GradeThread condition-grading standard and the blog.</p>
  ${authors.length === 0 ? "<p>No authors yet.</p>" : cards}
</main>`;

  return renderSsrResponse(
    {
      title: "Authors — GradeThread",
      description:
        "The people behind the GradeThread condition-grading standard, blog, and Condition Index.",
      canonicalUrl: canonical,
      ogType: "website",
      ogImage: `${siteUrl(env)}/logo_icon_512.png`,
      gaMeasurementId: ga4MeasurementId(env),
      twitterSite: twitterSiteHandle(env),
      jsonLd: [breadcrumbListLd(breadcrumbItems)],
      bodyHtml,
    },
    { cacheControl: SSR_CACHE_CONTROL },
  );
}

async function renderAuthor(env: PagesEnv, slug: string): Promise<Response> {
  if (!slug) return notFoundResponse(env);
  const data = await fetchJson<AuthorResponse>(
    env,
    `/api/content/public/authors/${encodeURIComponent(slug)}`,
  );
  if (!data?.author) return notFoundResponse(env);
  const author = data.author;
  const posts = data.posts ?? [];
  const canonical = `${siteUrl(env)}/authors/${author.slug}`;
  const description = author.title
    ? `${author.name} — ${author.title} at GradeThread.`
    : `${author.name} writes for GradeThread on clothing condition grading and reselling.`;

  const avatarHtml = author.avatar_url
    ? `<img class="author-avatar" src="${escape(author.avatar_url)}" alt="${escape(
        author.name,
      )}" width="96" height="96">`
    : "";

  // External profiles (sameAs) as visible links — mirrors the Person.sameAs.
  const sameAs = (author.same_as ?? [])
    .map((u) => (u ?? "").trim())
    .filter((u) => /^https?:\/\//.test(u));
  const sameAsHtml =
    sameAs.length > 0
      ? `<div class="author-sameas">${sameAs
          .map(
            (u) =>
              `<a href="${escape(u)}" rel="me noopener" target="_blank">${escape(
                hostLabel(u),
              )}</a>`,
          )
          .join("")}</div>`
      : "";

  const postsHtml =
    posts.length > 0
      ? `<section class="author-posts"><h2>Articles by ${escape(author.name)}</h2>${posts
          .map(
            (p) => `<a class="author-card" href="/blog/${escape(p.slug)}">
  <h3>${escape(p.title)}</h3>
  <p>${escape(p.excerpt ?? "")}${
              p.published_at ? ` · ${escape(formatDate(p.published_at))}` : ""
            }</p>
</a>`,
          )
          .join("")}</section>`
      : "";

  const breadcrumbItems = [
    { name: "GradeThread", url: `${siteUrl(env)}/` },
    { name: "Authors", url: `${siteUrl(env)}/authors` },
    { name: author.name, url: canonical },
  ];

  const bodyHtml = `${renderBreadcrumbs(breadcrumbItems, siteUrl(env))}
  <main class="container">
  <div class="author-header">
    ${avatarHtml}
    <div>
      <h1>${escape(author.name)}</h1>
      ${author.title ? `<p class="author-title">${escape(author.title)}</p>` : ""}
    </div>
  </div>
  ${renderAuthorBio(author.bio_md)}
  ${sameAsHtml}
  ${renderAuthorCredentials(author.credentials)}
  ${postsHtml}
</main>`;

  return renderSsrResponse(
    {
      title: `${author.name} — GradeThread`,
      description,
      canonicalUrl: canonical,
      ogType: "profile",
      ogImage: author.avatar_url ?? `${siteUrl(env)}/logo_icon_512.png`,
      gaMeasurementId: ga4MeasurementId(env),
      twitterSite: twitterSiteHandle(env),
      jsonLd: [
        profilePageLd(author, siteUrl(env)),
        breadcrumbListLd(breadcrumbItems),
        organizationLd(env),
      ],
      bodyHtml,
    },
    { cacheControl: SSR_CACHE_CONTROL },
  );
}

/** A short, human label for an external profile URL (its hostname sans www). */
function hostLabel(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

function organizationLd(env: PagesEnv) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "GradeThread",
    url: siteUrl(env),
    logo: `${siteUrl(env)}/logo_icon_512.png`,
    sameAs: socialProfileUrls(env),
  };
}
