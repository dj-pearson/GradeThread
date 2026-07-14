import { Link } from "react-router-dom";
import { MarketingLayout } from "@/components/marketing/marketing-layout";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";

// US-291 (indexability): a human-readable HTML sitemap. The XML sitemap is for
// crawlers; this page gives BOTH people and crawlers a single in-site hop to
// every public page — especially the long programmatic tail (glossary spokes,
// comparisons, platform standards, flaws, guides) that the global footer can't
// list. It derives its link set from the SAME PUBLIC_ROUTES registry the
// sitemap/prerender use, so a new public page appears here automatically; a
// fallback "More pages" bucket guarantees nothing is ever silently dropped.

interface LinkItem {
  path: string;
  title: string;
}

// Dynamic hubs that are edge-SSR'd (not in the static PUBLIC_ROUTES registry)
// but are important crawl entry points, so we link them by hand.
const DYNAMIC_HUBS: Record<string, LinkItem[]> = {
  "Data & indexes": [
    { path: "/condition-index", title: "The Condition Index" },
    { path: "/value", title: "Resale Value Index" },
    { path: "/durability", title: "Brand Durability Rankings" },
  ],
  Content: [
    { path: "/blog", title: "Blog" },
    { path: "/authors", title: "Authors" },
  ],
};

// Explicit paths that belong in the data/indexes group even though they're
// registered marketing routes (they'd otherwise fall into the catch-all).
const DATA_PATHS = new Set([
  "/transparency",
  "/resale-condition-report",
  "/state-of-durability",
  "/verified",
  "/leaderboard",
]);

const LEGAL_PATHS = new Set([
  "/about",
  "/privacy",
  "/terms",
  "/cookies",
  "/acceptable-use",
  "/refund",
  "/imprint",
  "/dpa",
  "/subprocessors",
  "/dmca",
  "/accessibility",
  "/status",
]);

// Ordered sections. The FIRST matching predicate wins; anything unmatched lands
// in the trailing catch-all so the page can never omit a registered route.
const SECTIONS: Array<{ title: string; match: (path: string) => boolean }> = [
  {
    title: "Marketplace comparisons",
    match: (p) => p === "/compare" || p.startsWith("/compare/"),
  },
  {
    title: "Reselling guides",
    match: (p) => p === "/reselling" || p.startsWith("/reselling/"),
  },
  { title: "Free tools", match: (p) => p.startsWith("/tools/") },
  {
    title: "Condition glossary",
    match: (p) => p === "/grading/glossary" || p.startsWith("/grading/glossary/"),
  },
  {
    title: "Flaw library",
    match: (p) => p === "/grading/flaws" || p.startsWith("/grading/flaws/"),
  },
  {
    title: "Garment grading guides",
    match: (p) => p === "/grading/guides" || p.startsWith("/grading/guides/"),
  },
  {
    title: "Marketplace condition standards",
    match: (p) =>
      p === "/grading/platform-standards" ||
      p.startsWith("/grading/platform-standards/"),
  },
  {
    title: "The grading standard",
    match: (p) =>
      p === "/condition-grading" || p === "/grading-standard" || p.startsWith("/grading"),
  },
  { title: "Data & indexes", match: (p) => DATA_PATHS.has(p) },
  { title: "Company & legal", match: (p) => LEGAL_PATHS.has(p) },
];

const CATCH_ALL = "Product & guides";

function buildSections(): Array<{ title: string; links: LinkItem[] }> {
  const buckets = new Map<string, LinkItem[]>();
  const push = (title: string, item: LinkItem) => {
    const list = buckets.get(title) ?? [];
    list.push(item);
    buckets.set(title, list);
  };

  for (const route of PUBLIC_ROUTES) {
    if (route.path === "/" || route.path === "/sitemap") continue; // skip home + self
    const section = SECTIONS.find((s) => s.match(route.path))?.title ?? CATCH_ALL;
    push(section, { path: route.path, title: route.title });
  }
  // Hand-linked dynamic hubs.
  for (const [title, items] of Object.entries(DYNAMIC_HUBS)) {
    for (const item of items) push(title, item);
  }

  // Emit in a stable, readable order: catch-all first, then declared sections,
  // then the Content group, alphabetized within each.
  const order = [CATCH_ALL, ...SECTIONS.map((s) => s.title), "Content"];
  const seen = new Set<string>();
  const result: Array<{ title: string; links: LinkItem[] }> = [];
  for (const title of order) {
    if (seen.has(title)) continue;
    seen.add(title);
    const links = buckets.get(title);
    if (links && links.length) {
      result.push({
        title,
        links: [...links].sort((a, b) => a.title.localeCompare(b.title)),
      });
    }
  }
  return result;
}

export function HtmlSitemapPage() {
  const sections = buildSections();
  return (
    <MarketingLayout
      title="Sitemap"
      description="Every public GradeThread page in one place — the grading standard and glossary, marketplace comparisons, reselling guides, free tools, and data reports."
      canonicalPath="/sitemap"
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-5xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Sitemap</h1>
          <p className="mt-6 max-w-3xl text-lg text-muted-foreground">
            Every public page on GradeThread, grouped by topic. Looking for the
            machine-readable version? See{" "}
            <a
              href="/sitemap.xml"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              sitemap.xml
            </a>
            .
          </p>

          <div className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
            {sections.map((section) => (
              <div key={section.title}>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground/70">
                  {section.title}
                </h2>
                <ul className="mt-4 space-y-2 text-sm">
                  {section.links.map((link) => (
                    <li key={link.path}>
                      <Link
                        to={link.path}
                        className="text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {link.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
