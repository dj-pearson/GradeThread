import { Link } from "react-router";
import { ArrowRight, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import { RESELLING_PILLAR_PATH } from "@/lib/seo/reselling-guides";
import { alternativePath } from "@/lib/seo/competitor-alternative-slugs";
import {
  SWITCH_FROM_VERIFIED,
  getSwitchFromBySlug,
  switchFromPath,
  type SwitchFromPage,
} from "@/lib/seo/switch-from";
import { switchFromBreadcrumbItems, switchFromJsonLd } from "@/pages/marketing/marketing-jsonld";
import { NotFoundPage } from "@/pages/not-found";

// US-9209: what a switch actually moves. The slug arrives as a prop, like the
// alternative pages, because the router registers each path explicitly ahead
// of /reselling/:slug.

export function SwitchFromPageView({ slug }: { slug: string }) {
  const page = getSwitchFromBySlug(slug);
  if (!page) return <NotFoundPage />;
  return <SwitchFromBody page={page} />;
}

function SwitchFromBody({ page }: { page: SwitchFromPage }) {
  return (
    <MarketingLayout
      title={page.title}
      description={page.description}
      canonicalPath={switchFromPath(page.slug)}
      breadcrumbs={switchFromBreadcrumbItems(page)}
      jsonLd={switchFromJsonLd(page)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-muted-foreground">
            <Link to={RESELLING_PILLAR_PATH} className="hover:underline">
              Reselling
            </Link>
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">{page.h1}</h1>
          <p className="mt-6 rounded-xl bg-muted/40 p-5 text-lg font-medium text-foreground">
            {page.definition}
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Verified {SWITCH_FROM_VERIFIED}. Export formats change; step 2 of the import shows
            every column before anything is written.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto grid max-w-5xl gap-10 md:grid-cols-2">
          <div>
            <h2 className="text-2xl font-bold sm:text-3xl">What transfers</h2>
            <ul className="mt-6 space-y-3">
              {page.transfers.map((t) => (
                <li key={t} className="flex gap-3 text-muted-foreground">
                  <Check className="mt-1 h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-2xl font-bold sm:text-3xl">What does not</h2>
            <ul className="mt-6 space-y-3">
              {page.doesNotTransfer.map((t) => (
                <li key={t} className="flex gap-3 text-muted-foreground">
                  <X className="mt-1 h-4 w-4 flex-shrink-0 text-brand-red-text" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">The afternoon, in order</h2>
          <ol className="mt-6 list-decimal space-y-3 pl-6 text-muted-foreground">
            {page.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="mt-6 text-sm text-muted-foreground">
            Not sure you should move at all? Read{" "}
            <Link to={alternativePath(page.alternativeSlug)} className="underline underline-offset-2">
              when to stay with {page.competitor}
            </Link>{" "}
            first.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">Questions sellers ask before switching</h2>
          <dl className="mt-8 space-y-6">
            {page.faqs.map((f) => (
              <div key={f.q}>
                <dt className="font-semibold">{f.q}</dt>
                <dd className="mt-2 text-muted-foreground">{f.a}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-10">
            <Button asChild>
              <Link to="/dashboard/flipdesk/import">
                Start the import
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}
