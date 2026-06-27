import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import {
  EBAY_GUIDE_FAQS,
  sellOnEbayJsonLd,
} from "@/pages/marketing/marketing-jsonld";

// US-1401 (SEO): a non-commodity guide for the high-intent "how to sell used
// clothes on eBay" cluster, framed through the lever no generic listicle owns —
// CONDITION. Leads with first-party authority (the grading standard + condition
// index) and ties to FlipDesk, so it earns citations instead of reading like a
// 10-tips post. Fully server-rendered (prerendered) for AI crawlers; Article +
// FAQPage + BreadcrumbList JSON-LD.

// Answer-capsule + step structure (GEO research: Q&A pairs + short answer-first
// blocks are the most reliably-cited format).
const STEPS = [
  {
    n: "1",
    title: "Grade the condition before you list",
    body: "Condition is the single biggest driver of what used clothing sells for — and the hardest thing for a buyer to trust from a photo. A standardized 1.0–10.0 grade and a verifiable certificate turn “Excellent” from your opinion into a number a buyer can check.",
  },
  {
    n: "2",
    title: "Map the grade to eBay's condition field",
    body: "eBay's pre-owned condition options (New with tags, New without tags, Pre-owned) are coarse. Pair the eBay field with a precise grade in the listing — e.g. “Condition Grade 8.0 (Excellent)” as an item specific plus the certificate number — so buyers get the resolution eBay's dropdown can't give them.",
  },
  {
    n: "3",
    title: "Price to the grade with real sold comps",
    body: "Don't average all sold listings — average the ones in your item's condition. Condition-aware comps tell you what an Excellent (8) piece actually sold for, not a blur of mint and thrashed. That's how you avoid leaving money on the table or pricing yourself unsold.",
  },
  {
    n: "4",
    title: "Photograph and measure to the grade",
    body: "The same photos that earn the grade also answer the two questions that drive returns: “what condition is it really in?” and “will it fit?” Shoot the documented zones and post real measurements — fewer “not as described” returns, faster sales.",
  },
  {
    n: "5",
    title: "List, reprice, and reconcile in one place",
    body: "Draft the listing with the grade built in, let rules-based repricing keep stale inventory moving, then reconcile payouts and fees back to each item so you know real profit. That whole loop is what FlipDesk runs.",
  },
];

export function SellUsedClothesEbayPage() {
  return (
    <MarketingLayout
      title="How to Sell Used Clothes on eBay"
      description="A condition-first guide to selling used clothes on eBay: grade the condition, map it to eBay's fields, price to real sold comps, and cut returns — backed by a verifiable grade."
      canonicalPath="/sell-used-clothes-ebay"
      jsonLd={sellOnEbayJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            How to sell used clothes on eBay
          </h1>
          {/* Answer capsule: a 40-60 word direct answer, the format AI engines
              cite most reliably. */}
          <p className="mt-6 text-lg text-muted-foreground">
            The fastest way to sell used clothes on eBay for more is to compete on{" "}
            <strong>condition</strong>, not just price. Grade the item on a
            standardized scale, attach a verifiable certificate, map that grade to
            eBay&rsquo;s condition field, and price it against sold comps in the
            same condition. Trust sells — and reduces returns.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/signup">
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                Grade an item free
              </Button>
            </Link>
            <Link to="/flipdesk">
              <Button size="lg" variant="outline">
                See FlipDesk
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            Why condition is the lever most sellers miss
          </h2>
          <p className="mt-3 text-muted-foreground">
            On eBay, a buyer judges a used garment from a few photos and one of
            three condition labels. That ambiguity is exactly why used clothing
            sells below its worth and comes back as &ldquo;not as described.&rdquo;
            A standardized condition grade closes the gap on both sides: the buyer
            gets something objective to trust, and you get a defensible reason to
            price higher. It&rsquo;s the same move that made third-party grading
            the norm for trading cards — applied to clothing on{" "}
            <Link
              to="/grading-standard"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              a published standard
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The condition-first workflow</h2>
          <ol className="mt-8 space-y-6">
            {STEPS.map((s) => (
              <li key={s.n} className="flex gap-4">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-sm font-bold text-white">
                  {s.n}
                </span>
                <div>
                  <p className="font-semibold">{s.title}</p>
                  <p className="mt-1 text-muted-foreground">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-8 text-sm text-muted-foreground">
            See how value moves with each grade in the{" "}
            <Link
              to="/condition-index"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              Condition Index
            </Link>
            , or how the grade itself is built in the{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              condition grading guide
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">
            Selling used clothes on eBay — FAQ
          </h2>
          <dl className="mt-10 space-y-6">
            {EBAY_GUIDE_FAQS.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <MarketingCTA
        heading="Sell on condition, not guesswork"
        sub="Grade your items on a standard buyers can verify, price to condition-aware comps, and run the whole eBay workflow in FlipDesk."
      />
    </MarketingLayout>
  );
}
