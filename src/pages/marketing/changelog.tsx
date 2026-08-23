import { useQuery } from "@tanstack/react-query";
import {
  MarketingCTA,
  MarketingLayout,
} from "@/components/marketing/marketing-layout";
import { CHANGELOG_META, CHANGELOG_PATH } from "@/lib/seo/changelog";
import { edgeApiUrl } from "@/lib/edge-api";
import { cn } from "@/lib/utils";

// US-2809: the public product changelog. Reads the feed API that has existed
// since US-916 and had no reader.
//
// ── WHY THIS PASSES audience=all, WHICH LOOKS LIKE SKIPPING THE FILTER ──
//
// The story's AC2 says a surface must pass ?audience= because "the filter exists
// so a grading-only user is not shown FlipDesk news, and skipping it would ship
// the leak the API was designed to prevent". That reasoning is about the IN-APP
// panel, which knows who is looking. A public page has no viewer: there is no
// entitlement to respect and nothing to leak, because every row it can reach is
// already status='published' and public by definition.
//
// So the value passed is `all`, deliberately and explicitly rather than by
// omission. On the API side those are the same request — the handler narrows
// only when the audience is a real one AND is not "all" — but they are not the
// same STATEMENT, and a reader of this file should be able to tell that showing
// FlipDesk news here is a decision rather than an oversight.
//
// The in-app panel is still unbuilt. It is the surface that genuinely needs the
// viewer's audience, and it is the half of US-916 that stays open.

const CATEGORY_LABELS: Record<string, string> = {
  feature: "New",
  improvement: "Improved",
  fix: "Fixed",
  announcement: "Announcement",
};

interface PublicChangelogEntry {
  id: string;
  title: string;
  summary: string | null;
  body: string | null;
  category: string;
  audience: string;
  image_url: string | null;
  published_at: string | null;
}

async function fetchChangelog(): Promise<PublicChangelogEntry[]> {
  const res = await fetch(`${edgeApiUrl()}/api/changelog?audience=all&limit=50`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = (await res.json()) as { entries?: PublicChangelogEntry[] };
  return data.entries ?? [];
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export function ChangelogPage() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["changelog", "public"],
    queryFn: fetchChangelog,
    // The prerender renders this page server-side with no fetch, so the crawled
    // HTML is the shell below. Entries arrive on the client.
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const entries = data ?? [];

  return (
    <MarketingLayout
      title={CHANGELOG_META.title}
      description={CHANGELOG_META.description}
      canonicalPath={CHANGELOG_PATH}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {CHANGELOG_META.h1}
          </h1>
          <p className="mt-6 text-lg text-foreground">
            Everything we ship, newest first: grading accuracy, certificates, and
            the FlipDesk reseller tools. No release notes buried in a PDF.
          </p>

          <div className="mt-12">
            {isPending && (
              <p className="text-muted-foreground" role="status">
                Loading the latest updates…
              </p>
            )}

            {isError && (
              <p className="text-muted-foreground">
                We could not load the changelog just now. Please try again in a
                moment.
              </p>
            )}

            {!isPending && !isError && entries.length === 0 && (
              // Says what is true rather than nothing: an empty feed is a real
              // state, and a blank page reads as broken.
              <p className="text-muted-foreground">
                No updates have been published yet. This page fills up as we
                ship.
              </p>
            )}

            <ol className="space-y-12">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <article>
                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        className={cn(
                          "rounded-full px-3 py-1 text-xs font-medium",
                          "bg-primary/10 text-primary",
                        )}
                      >
                        {CATEGORY_LABELS[entry.category] ?? entry.category}
                      </span>
                      {entry.published_at && (
                        <time
                          dateTime={entry.published_at}
                          className="text-sm text-muted-foreground"
                        >
                          {formatDate(entry.published_at)}
                        </time>
                      )}
                    </div>

                    <h2 className="mt-4 text-2xl font-bold tracking-tight">
                      {entry.title}
                    </h2>

                    {entry.summary && (
                      <p className="mt-3 text-foreground">{entry.summary}</p>
                    )}

                    {entry.image_url && (
                      <img
                        src={entry.image_url}
                        alt=""
                        loading="lazy"
                        className="mt-6 w-full max-w-full rounded-xl border"
                      />
                    )}

                    {entry.body && (
                      <div className="mt-4 space-y-3 text-foreground">
                        {entry.body
                          .split(/\n{2,}/)
                          .map((para) => para.trim())
                          .filter(Boolean)
                          .map((para, i) => (
                            <p key={i}>{para}</p>
                          ))}
                      </div>
                    )}
                  </article>
                </li>
              ))}
            </ol>
          </div>

        </div>
      </section>

      <MarketingCTA
        heading="Grade your first item free"
        sub="Every change above is already live. Upload a few photos and get an objective 1.0-10.0 condition grade with a certificate buyers can check."
      />
    </MarketingLayout>
  );
}
