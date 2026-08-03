import { Link, useParams } from "react-router-dom";
import { ArrowRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { NotFoundPage } from "@/pages/not-found";
import {
  PLATFORM_STANDARDS,
  PLATFORM_STANDARDS_HUB_PATH,
  PLATFORM_STANDARDS_VERIFIED,
  SCALE_BANDS,
  getPlatformStandardBySlug,
  platformScaleRows,
  platformStandardPath,
  type PlatformStandard,
} from "@/lib/seo/platform-standards";
import { RETURNS_SPINE_PATH } from "@/lib/seo/returns-spine";
import {
  platformStandardsHubJsonLd,
  platformStandardsHubBreadcrumbItems,
  platformStandardJsonLd,
  platformStandardBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-1672: per-marketplace condition-standard pages. Hub at
// /grading/platform-standards + spoke per platform. Vocab↔scale rows are derived
// from the live listing engine (marketplace-specs) for platforms we push to.

export function PlatformStandardsHubPage() {
  return (
    <MarketingLayout
      title="Marketplace Condition Standards"
      description="How each marketplace's condition vocabulary maps to the 1.0–10.0 scale — eBay, Poshmark, Mercari, Depop, Grailed, Vinted, Whatnot, ThredUp, and more."
      canonicalPath={PLATFORM_STANDARDS_HUB_PATH}
      breadcrumbs={platformStandardsHubBreadcrumbItems()}
      jsonLd={platformStandardsHubJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-muted-foreground">
            <Link to="/grading/scale" className="hover:underline">
              Grading scale
            </Link>
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            Marketplace condition standards, mapped to one scale
          </h1>
          <p className="mt-6 text-lg text-foreground">
            Every marketplace describes condition differently — "VGUC" here,
            "Used – excellent" there, a five-step selector somewhere else. Each
            page below maps one platform's condition vocabulary onto the
            GradeThread 1.0–10.0 scale, shows what triggers a return there, and
            gives listing copy per grade.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Verified {PLATFORM_STANDARDS_VERIFIED} · re-checked quarterly against
            each platform's published policy.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Pick your marketplace</h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2">
            {PLATFORM_STANDARDS.map((s) => (
              <li key={s.slug} className="rounded-xl border p-4">
                <Link
                  to={platformStandardPath(s.slug)}
                  className="text-lg font-medium text-brand-navy hover:underline dark:text-foreground"
                >
                  {s.name}
                </Link>
                <p className="mt-1 text-sm text-muted-foreground">
                  {s.name} condition ↔ the 1.0–10.0 scale
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}

export function PlatformStandardPage({ slug: slugProp }: { slug?: string }) {
  const params = useParams<{ platform: string }>();
  const slug = slugProp ?? params.platform ?? "";
  const std = getPlatformStandardBySlug(slug);
  if (!std) return <NotFoundPage />;
  return <PlatformStandardView std={std} />;
}

function PlatformStandardView({ std }: { std: PlatformStandard }) {
  const rows = platformScaleRows(std);
  return (
    <MarketingLayout
      title={std.title}
      description={std.description}
      canonicalPath={platformStandardPath(std.slug)}
      breadcrumbs={platformStandardBreadcrumbItems(std)}
      jsonLd={platformStandardJsonLd(std)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-muted-foreground">
            <Link to={PLATFORM_STANDARDS_HUB_PATH} className="hover:underline">
              Condition standards
            </Link>
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            {std.h1}
          </h1>
          {/* Quotable answer block (AI-citable). */}
          <p className="mt-6 rounded-xl bg-muted/40 p-5 text-lg font-medium text-foreground">
            {std.definition}
          </p>
          <p className="mt-6 text-muted-foreground">{std.intro}</p>
          <p className="mt-4 text-sm text-muted-foreground">
            Verified {PLATFORM_STANDARDS_VERIFIED} · source:{" "}
            <a
              href={std.policyUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex items-center gap-1 font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              {std.policyName}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </p>
        </div>
      </section>

      {/* Vocab ↔ scale mapping table */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            How does {std.name} condition map to the 1.0–10.0 scale?
          </h2>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[480px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-3 pr-4 font-semibold">GradeThread grade</th>
                  <th className="py-3 pr-4 font-semibold">Tier</th>
                  <th className="py-3 font-semibold">{std.name} condition</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.tier} className="border-b align-top">
                    <td className="py-3 pr-4 font-medium">{r.range}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{r.tier}</td>
                    <td className="py-3 text-muted-foreground">{r.platformTerm}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* SNAD / returns */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            What triggers a return on {std.name}?
          </h2>
          <p className="mt-4 text-muted-foreground">{std.snad}</p>
        </div>
      </section>

      {/* Listing copy per grade */}
      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Listing copy for each grade
          </h2>
          <p className="mt-4 text-muted-foreground">{std.listingTips}</p>
          <div className="mt-6 space-y-3">
            {SCALE_BANDS.slice(0, 5).map((b) => (
              <div key={b.tier} className="rounded-lg border bg-background p-4">
                <p className="text-sm font-medium text-foreground">
                  {b.range} · {b.tier}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Condition: {b.tier} — graded {b.range} on the GradeThread
                  1–10 scale ({b.blurb}). See the certificate for the full
                  condition report.
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Link up to scale + spine */}
      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl rounded-xl border bg-muted/30 p-6">
          <h2 className="text-2xl font-bold">One grade, every marketplace</h2>
          <p className="mt-3 text-muted-foreground">
            Grade an item once on the 1.0–10.0 scale and you have the right
            condition wording for {std.name} and every other platform — plus a
            certificate that heads off the condition disputes that drive returns.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link to="/grading/scale">
              <Button variant="outline" size="sm">
                The 1.0–10.0 grading scale
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
            <Link to={RETURNS_SPINE_PATH}>
              <Button variant="outline" size="sm">
                Reduce condition returns
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {std.faqs.length > 0 && (
        <section className="border-t bg-card px-6 py-16">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-center text-3xl font-bold">Frequently asked</h2>
            <dl className="mt-10 space-y-6">
              {std.faqs.map((faq) => (
                <div key={faq.q} className="border-b pb-6 last:border-b-0">
                  <dt className="font-medium">{faq.q}</dt>
                  <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      )}

      <MarketingCTA />
    </MarketingLayout>
  );
}
