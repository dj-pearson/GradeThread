import { Link, useParams } from "react-router";
import { MarketingLayout } from "@/components/marketing/marketing-layout";
import { NotFoundPage } from "@/pages/not-found";
import {
  getBuyingGuideBySlug,
  buyingGuidePath,
} from "@/lib/seo/buying-guides";
import { verifiedLabel } from "@/lib/seo/freshness";
import { extensionCtaFor } from "@/lib/seo/extension-cta-copy";
import { chromeWebStoreUrl } from "@/lib/app-links";
import {
  buyingGuideJsonLd,
  buyingGuideBreadcrumbItems,
} from "@/pages/marketing/marketing-jsonld";

// US-3093: the buyer-trust cluster.
//
// ⚠ NO MarketingCTA ON THIS PAGE, AND THAT IS THE WHOLE CONTAINMENT.
//
// Every other marketing page ends with <MarketingCTA />, which points at the
// seller signup. The reader here is a BUYER, one click from paying a stranger
// on a marketplace, and answering "am I about to be scammed" with a reseller
// subscription is answering a question nobody asked. The only product surface
// this page offers is the extension install, which is the thing that actually
// does the check they came for.
//
// buying-containment.test.ts asserts the absence, because a CTA added back
// would look like every other page in this directory and read as consistent.

export function BuyingGuidePage({ slug: slugProp }: { slug?: string }) {
  const params = useParams<{ slug: string }>();
  const slug = slugProp ?? params.slug ?? "";
  const guide = getBuyingGuideBySlug(slug);

  if (!guide) return <NotFoundPage />;

  const cta = extensionCtaFor(buyingGuidePath(guide.slug));

  return (
    <MarketingLayout
      title={guide.title}
      description={guide.description}
      canonicalPath={buyingGuidePath(guide.slug)}
      breadcrumbs={buyingGuideBreadcrumbItems(guide)}
      // US-3093 AC6: the header nav AND the footer grid both link /pricing,
      // /flipdesk and /for-resellers on every marketing page, which is where
      // this cluster's containment leaked. Both are dropped here; the logo, the
      // account buttons and the legal bar stay.
      contained
      jsonLd={buyingGuideJsonLd(guide)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {guide.h1}
          </h1>
          {/* THE ANSWER FIRST (AC4). */}
          <p className="mt-6 text-lg text-foreground">{guide.answer}</p>
          <p className="mt-4 text-sm text-muted-foreground">
            Fees, windows and policies verified{" "}
            {verifiedLabel(guide.freshnessGroup)}
          </p>
        </div>
      </section>

      {guide.sections.map((s, i) => (
        <section
          key={s.heading}
          className={
            i % 2 === 0 ? "border-t bg-card px-6 py-16" : "border-t px-6 py-16"
          }
        >
          <div className="mx-auto max-w-3xl">
            <h2 className="text-2xl font-bold sm:text-3xl">{s.heading}</h2>
            <p className="mt-4 text-muted-foreground">{s.body}</p>
          </div>
        </section>
      ))}

      {cta && (
        <section className="border-t px-6 py-16">
          <div className="mx-auto max-w-3xl rounded-xl border bg-muted/30 p-6">
            <h2 className="text-2xl font-bold">Check the listing first</h2>
            <p className="mt-3 text-muted-foreground">{cta.does}</p>
            <a
              className="mt-5 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              href={chromeWebStoreUrl()}
              rel="noopener"
              target="_blank"
              data-cta="extension-install"
            >
              Get the free extension
            </a>
          </div>
        </section>
      )}

      {guide.faqs.length > 0 && (
        <section className="border-t bg-card px-6 py-16">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-center text-3xl font-bold">Frequently asked</h2>
            <dl className="mt-10 space-y-6">
              {guide.faqs.map((faq) => (
                <div key={faq.q} className="border-b pb-6 last:border-b-0">
                  <dt className="font-medium">{faq.q}</dt>
                  <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      )}

      {/* The one internal link, and it is to the grading scale rather than to
          anything that sells. A buyer who wants to know what "very good" means
          is asking the question this company exists to answer. */}
      <section className="border-t px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <Link
            to="/grading/scale"
            className="text-brand-navy hover:underline dark:text-foreground"
          >
            What the condition grades actually mean
          </Link>
        </div>
      </section>
    </MarketingLayout>
  );
}
