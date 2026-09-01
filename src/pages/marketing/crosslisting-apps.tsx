import { CROSSLIST_PAIRS, crosslistPairPath } from "@/lib/seo/crosslist-pairs";
import { Link } from "react-router";
import { ArrowRight, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { track } from "@/lib/analytics";
import { RESELLING_PILLAR_PATH } from "@/lib/seo/reselling-guides";
import {
  CROSSLIST_APPS,
  CROSSLIST_APPS_PAGE,
  CROSSLIST_APPS_PATH,
  CROSSLIST_APPS_VERIFIED,
} from "@/lib/seo/crosslisting-apps";
import {
  crosslistAppsJsonLd,
  crosslistAppsBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-1686: honest "best crosslisting apps 2026" listicle. Includes competitors
// fairly; FlipDesk positioned on the grading/returns differentiator.

export function CrosslistingAppsPage() {
  return (
    <MarketingLayout
      title={CROSSLIST_APPS_PAGE.title}
      description="The best crosslisting apps for resellers in 2026 compared — List Perfectly, Vendoo, Crosslist, Flyp, and FlipDesk — on marketplaces, pricing, and returns."
      canonicalPath={CROSSLIST_APPS_PATH}
      breadcrumbs={crosslistAppsBreadcrumbItems()}
      jsonLd={crosslistAppsJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-muted-foreground">
            <Link to={RESELLING_PILLAR_PATH} className="hover:underline">
              Reselling
            </Link>
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            {CROSSLIST_APPS_PAGE.h1}
          </h1>
          {/* Quotable answer block (AI-citable). */}
          <p className="mt-6 rounded-xl bg-muted/40 p-5 text-lg font-medium text-foreground">
            {CROSSLIST_APPS_PAGE.definition}
          </p>
          <p className="mt-6 text-muted-foreground">{CROSSLIST_APPS_PAGE.intro}</p>
          <p className="mt-4 rounded-xl border px-4 py-3 text-sm text-foreground">
            <strong>Who wrote this.</strong> {CROSSLIST_APPS_PAGE.disclosure}
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Verified {CROSSLIST_APPS_VERIFIED} · features and pricing change —
            verify on each tool's site.
          </p>
        </div>
      </section>

      {/* Criteria */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            How we compared them
          </h2>
          <dl className="mt-8 space-y-6">
            {CROSSLIST_APPS_PAGE.criteria.map((c) => (
              <div key={c.name}>
                <dt className="font-medium text-foreground">{c.name}</dt>
                <dd className="mt-1 text-muted-foreground">{c.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Comparison table */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">At a glance</h2>
          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-3 pr-4 font-semibold">App</th>
                  <th className="py-3 font-semibold">Best for</th>
                </tr>
              </thead>
              <tbody>
                {CROSSLIST_APPS.map((app) => (
                  <tr key={app.name} className="border-b align-top">
                    <th className="py-3 pr-4 font-medium">
                      {app.name}
                      {app.isOurs && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          ours
                        </span>
                      )}
                    </th>
                    <td className="py-3 text-muted-foreground">{app.bestFor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* US-9009: commercial intent has somewhere to go that is allowed to
          argue for one product. The diagnosis found this listicle at position
          51.5 and /flipdesk/crosslisting at 10.8 — a vendor may not credibly
          rank itself in a neutral list, but it may credibly describe its own
          tool. */}
      <section className="border-t px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Looking for what ours actually does?
          </h2>
          <p className="mt-3 text-muted-foreground">
            This page is a comparison and it is not the place to sell you
            anything. If you want the version where we do argue for FlipDesk,
            including where it loses to Vendoo and List Perfectly on marketplace
            coverage, that page exists and says so.
          </p>
          <div className="mt-5">
            <Link
              to="/flipdesk/crosslisting"
              onClick={() =>
                track("crosslist_listicle_vendor_handoff", {
                  source: "best-crosslisting-apps",
                  destination: "flipdesk-crosslisting",
                })
              }
            >
              <span className="inline-flex items-center text-sm font-medium text-brand-red-text hover:underline">
                What FlipDesk crosslisting does
                <ArrowRight className="ml-1 h-4 w-4" />
              </span>
            </Link>
          </div>
        </div>
      </section>

      {/* Per-app pros/cons */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl space-y-6">
          {CROSSLIST_APPS.map((app) => (
            <div
              key={app.name}
              className={
                app.isOurs
                  ? "rounded-xl border-2 border-brand-navy bg-background p-6 dark:border-foreground"
                  : "rounded-xl border bg-background p-6"
              }
            >
              <h3 className="text-xl font-bold">{app.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Best for {app.bestFor}.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <ul className="space-y-2">
                  {app.pros.map((p) => (
                    <li key={p} className="flex gap-2 text-sm text-muted-foreground">
                      <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
                      {p}
                    </li>
                  ))}
                </ul>
                <ul className="space-y-2">
                  {app.cons.map((c) => (
                    <li key={c} className="flex gap-2 text-sm text-muted-foreground">
                      <X className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand-red-text" />
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* US-9214: the reader who already knows which two marketplaces they mean
          is served by the pair page, not by a list of vendors. The diagnosis
          (docs/seo/crosslisting-cluster-diagnosis.md) measured every
          task-intent page on this site ranking 7 to 11 while this listicle
          sits at 51, so the task links leave here deliberately. */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Moving a listing between two marketplaces
          </h2>
          <p className="mt-3 text-muted-foreground">
            If you already know the pair, skip the vendor comparison. Each page
            below says what carries over, what the destination needs, and which
            of the three mechanisms (an API, the browser extension, or your own
            hands) actually puts the listing there.
          </p>
          <ul className="mt-6 grid gap-2 sm:grid-cols-2">
            {CROSSLIST_PAIRS.map((p) => (
              <li key={p.slug}>
                <Link
                  to={crosslistPairPath(p.slug)}
                  className="text-sm font-medium text-brand-navy hover:underline dark:text-foreground"
                >
                  {p.fromLabel} to {p.toLabel}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-muted-foreground">
            Or see{" "}
            <Link to="/flipdesk/crosslisting" className="font-medium underline underline-offset-2">
              how FlipDesk cross-lists
            </Link>{" "}
            across all of them from one catalog.
          </p>
        </div>
      </section>

      {/* FlipDesk differentiator */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl rounded-xl border bg-muted/30 p-6">
          <h2 className="text-2xl font-bold">
            The differentiator: condition and returns
          </h2>
          <p className="mt-3 text-muted-foreground">
            Crosslisting saves time, but it doesn't fix the biggest silent margin
            leak: condition-driven returns. FlipDesk builds a standardized
            condition grade and a verifiable certificate into the reselling
            lifecycle, so listings set accurate expectations and{" "}
            <Link
              to="/reselling/reduce-ebay-returns"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              cut "not as described" returns
            </Link>{" "}
            — the piece other crosslisters leave to you.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            {/* US-9214: task intent leaves this page for the pair pages. The
                diagnosis (docs/seo/crosslisting-cluster-diagnosis.md) found
                every task-intent page ranking 7 to 11 while this listicle sits
                at 51, so the reader who knows which two marketplaces they mean
                is better served there than here. */}
            <Link to="/flipdesk">
              <Button variant="outline" size="sm">
                See FlipDesk
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
            <Link to="/grading/scale">
              <Button variant="outline" size="sm">
                The 1.0–10.0 grading scale
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">Frequently asked</h2>
          <dl className="mt-10 space-y-6">
            {CROSSLIST_APPS_PAGE.faqs.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}
