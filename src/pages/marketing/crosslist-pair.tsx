import { Link } from "react-router";
import { ArrowRight, Check, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import { RESELLING_PILLAR_PATH } from "@/lib/seo/reselling-guides";
import { getMarketplaceSpec } from "@/lib/marketplace-specs";
import {
  CROSSLIST_PAIRS,
  canReadCloset,
  crosslistPairPath,
  destinationMechanism,
  destinationSentence,
  getCrosslistPairBySlug,
  pairAnswer,
  sourceSentence,
  type CrosslistPair,
} from "@/lib/seo/crosslist-pairs";
import {
  crosslistPairBreadcrumbItems,
  crosslistPairJsonLd,
} from "@/pages/marketing/marketing-jsonld";
import { NotFoundPage } from "@/pages/not-found";

// US-9214: one page per marketplace pair that actually earned impressions.
// The mechanism sentences come from src/lib/seo/crosslist-pairs.ts, which
// derives them from the constants — this file renders, it never claims.

export function CrosslistPairPage({ slug }: { slug: string }) {
  const pair = getCrosslistPairBySlug(slug);
  if (!pair) return <NotFoundPage />;
  return <PairBody pair={pair} />;
}

function specOf(platform: string) {
  return getMarketplaceSpec(platform) ?? null;
}

function PairBody({ pair }: { pair: CrosslistPair }) {
  const toSpec = specOf(pair.to);
  const fromSpec = specOf(pair.from);
  const mechanism = destinationMechanism(pair.to);
  const reverse = CROSSLIST_PAIRS.find((p) => p.from === pair.to && p.to === pair.from);
  const requirements: string[] = [];
  if (toSpec) {
    requirements.push(
      `Photos: ${pair.toLabel} takes up to ${toSpec.maxPhotos}. If the item has more, the first ${toSpec.maxPhotos} go, cover photo first.`,
    );
    if (toSpec.titleMaxLength) {
      requirements.push(
        `Title: ${toSpec.titleMaxLength} characters${
          fromSpec?.titleMaxLength && fromSpec.titleMaxLength !== toSpec.titleMaxLength
            ? ` (${pair.fromLabel} allows ${fromSpec.titleMaxLength}, so a long title is trimmed rather than cut mid-word)`
            : ""
        }.`,
      );
    }
    if (toSpec.conditions.length > 0) {
      requirements.push(
        `Condition: ${pair.toLabel} has its own list (${toSpec.conditions.slice(0, 3).map((c) => c.label).join(", ")}…), so the condition is mapped rather than copied.`,
      );
    }
    if (toSpec.priceStep && toSpec.priceStep >= 1) {
      requirements.push(
        `Price: ${pair.toLabel} takes whole dollars only, so a price with cents is rounded to the nearest dollar before it is sent.`,
      );
    }
  }
  requirements.push(
    `Size: every destination asks for its own size field. FlipDesk keeps the measurements with the item, so the size is filled from what you measured once rather than retyped.`,
  );

  return (
    <MarketingLayout
      title={`${pair.fromLabel} to ${pair.toLabel}: cross-list a listing`}
      description={
        `How to cross-list from ${pair.fromLabel} to ${pair.toLabel}: what carries over, what ${pair.toLabel} needs, ` +
        `and the tool that fills the form. ${pair.toLabel} photo and size rules included.`
      }
      canonicalPath={crosslistPairPath(pair.slug)}
      breadcrumbs={crosslistPairBreadcrumbItems(pair)}
      jsonLd={crosslistPairJsonLd(pair)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-muted-foreground">
            <Link to={RESELLING_PILLAR_PATH} className="hover:underline">
              Reselling
            </Link>
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            Cross-list from {pair.fromLabel} to {pair.toLabel}
          </h1>
          <p className="mt-6 rounded-xl bg-muted/40 p-5 text-lg font-medium text-foreground">
            {pairAnswer(pair)}
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Getting the item out of {pair.fromLabel}
          </h2>
          <p className="mt-4 text-muted-foreground">{sourceSentence(pair)}</p>
          {!canReadCloset(pair.from) && (
            <p className="mt-3 flex gap-3 text-sm text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
              Nothing here scrapes a marketplace you are not signed in to, and nothing reads another
              seller&rsquo;s listings. The import runs in your own browser, on your own account.
            </p>
          )}
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            What {pair.toLabel} needs
          </h2>
          <ul className="mt-6 space-y-3">
            {requirements.map((r) => (
              <li key={r} className="flex gap-3 text-muted-foreground">
                <Check className="mt-1 h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
                {r}
              </li>
            ))}
          </ul>
          <p className="mt-6 text-muted-foreground">{destinationSentence(pair)}</p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">The grade travels with the item</h2>
          <p className="mt-4 text-muted-foreground">
            The listing that moves is not just words and photos. GradeThread grades the garment once
            on a published 1.0&ndash;10.0 scale and mints a certificate the buyer can check, and that
            grade rides into every channel the item is listed on &mdash; {pair.toLabel} included. It
            is the part a crosslisting tool cannot copy across for you, because it has nothing to
            copy: condition is the seller&rsquo;s own word everywhere else.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/flipdesk/crosslisting">
                See how FlipDesk cross-lists
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/condition-grading">What the grade means</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">Questions sellers ask</h2>
          <dl className="mt-8 space-y-6">
            <div>
              <dt className="font-semibold">
                Does the listing get removed from {pair.fromLabel} automatically?
              </dt>
              <dd className="mt-2 text-muted-foreground">
                Not unless you ask for it. Cross-listing puts the item on {pair.toLabel} while it is
                still up on {pair.fromLabel}. When it sells on either one, FlipDesk ends the other
                listing so the same garment is not sold twice
                {mechanism === "extension"
                  ? " — on the channels with no API, that end runs in your own browser too."
                  : "."}
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Do my photos come across?</dt>
              <dd className="mt-2 text-muted-foreground">
                {canReadCloset(pair.from)
                  ? `Yes. The closet import brings ${pair.fromLabel}'s own copies of your photos over with the listing, and ${pair.toLabel} gets them in order, cover first.`
                  : `They come from FlipDesk rather than from ${pair.fromLabel}: upload them once and every channel is filled from that one set.`}
              </dd>
            </div>
            <div>
              <dt className="font-semibold">
                What about going the other way, {pair.toLabel} to {pair.fromLabel}?
              </dt>
              <dd className="mt-2 text-muted-foreground">
                {reverse ? (
                  <>
                    Same tool, different direction &mdash;{" "}
                    <Link to={crosslistPairPath(reverse.slug)} className="underline underline-offset-2">
                      cross-list from {pair.toLabel} to {pair.fromLabel}
                    </Link>
                    .
                  </>
                ) : (
                  <>
                    The same way. FlipDesk holds one catalog, so a channel is a destination and a
                    source at the same time; nothing about the direction changes the steps.
                  </>
                )}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <MarketingCTA />
    </MarketingLayout>
  );
}
