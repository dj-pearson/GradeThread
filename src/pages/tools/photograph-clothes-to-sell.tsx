import { useState } from "react";
import { Link } from "react-router";
import { MarketingLayout, MarketingCTA } from "@/components/marketing/marketing-layout";
import { CalculatorHandoff } from "@/components/marketing/calculator-funnel";
import { useCalculatorFunnel } from "@/lib/calculator-funnel";
import { BUNDLED_PHOTO_PROFILES, bundledPhotoProfile } from "@/lib/photo-profiles";
import {
  getCalculatorBySlug,
  calculatorContent,
  calculatorPath,
} from "@/lib/seo/calculators";
import {
  calculatorJsonLd,
  calculatorBreadcrumbLdItems,
} from "@/pages/marketing/marketing-jsonld";

// US-9023. 3,450/mo at low competition across 28 keywords, and the site had two
// narrow blog posts on sub-questions ranking around position 8 with no parent
// page above them. This is that parent.
//
// THE SHOT LIST IS THE PRODUCT'S OWN, imported from photo-profiles.ts rather
// than written for this page. A marketing page inventing a second opinion about
// photo order would put GradeThread on both sides of the question, and the copy
// is the half nobody keeps current. See BUNDLED_PHOTO_PROFILES for why the
// bundled list is the right one to render on a prerendered page.
//
// A workflow page rather than a tool, deliberately: there is no calculation in
// "how do I photograph a jacket", and pretending otherwise produces a worse
// page. The category switcher is the interactive part and it earns its place,
// because the answer genuinely differs between a shirt and a shoe.

const CALC = getCalculatorBySlug("photograph-clothes-to-sell");

export function PhotographClothesToSellPage() {
  const [category, setCategory] = useState("clothing");
  const profile = bundledPhotoProfile(category);

  useCalculatorFunnel(CALC?.slug ?? "", category === "clothing" ? "" : category);

  if (!CALC) throw new Error("[photograph-clothes-to-sell] not in the calculator registry");
  const { intro, faqs } = calculatorContent(CALC);

  return (
    <MarketingLayout
      title={CALC.title}
      description={CALC.description}
      canonicalPath={calculatorPath(CALC.slug)}
      breadcrumbs={calculatorBreadcrumbLdItems(CALC)}
      jsonLd={calculatorJsonLd(CALC)}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{CALC.h1}</h1>
          <p className="mt-6 text-lg text-foreground">{intro}</p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">The shot list</h2>
          <p className="mt-3 text-muted-foreground">
            In the order they go in the gallery. The two marked required are the ones a
            listing cannot go live without.
          </p>

          <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Category">
            {BUNDLED_PHOTO_PROFILES.map((p) => {
              const selected = profile.category === p.category;
              return (
                <button
                  key={p.category}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setCategory(p.category)}
                  className={
                    "rounded-md border px-3 py-1.5 text-sm transition-colors " +
                    (selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-background hover:bg-muted")
                  }
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          <ol className="mt-6 grid gap-3">
            {profile.roles.map((r, i) => (
              <li
                key={`${r.type}-${r.role ?? "base"}`}
                className="flex gap-4 rounded-xl border p-4"
              >
                <span className="mt-0.5 text-sm font-semibold tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <span>
                  <span className="font-semibold">{r.label}</span>
                  {r.required ? (
                    <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                      required
                    </span>
                  ) : null}
                  <span className="mt-1 block text-sm text-muted-foreground">{r.hint}</span>
                </span>
              </li>
            ))}
          </ol>

          <p className="mt-6 text-sm text-muted-foreground">
            This is the list GradeThread's own app uses, which is why it changes when you
            switch category. A shoe buyer looks at the sole first and a shirt buyer never
            does.
          </p>
        </div>
      </section>

      <section className="border-t px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Light and surface, without buying anything</h2>
          <p className="mt-3 text-muted-foreground">
            Four things do almost all of the work, and none of them is equipment.
          </p>
          <dl className="mt-6 grid gap-5">
            <div className="rounded-xl border p-5">
              <dt className="font-semibold">One light source, and it is a window</dt>
              <dd className="mt-2 text-sm text-muted-foreground">
                Daylight near the middle of the day, with the room lights off. Mixing a
                warm bulb with daylight is what turns a grey sweatshirt greenish in one
                photo and blue in the next, and colour that shifts across a gallery reads
                as an unreliable seller.
              </dd>
            </div>
            <div className="rounded-xl border p-5">
              <dt className="font-semibold">A plain mid-tone surface</dt>
              <dd className="mt-2 text-sm text-muted-foreground">
                Not white, which blows out and drags the garment darker, and not black,
                which does the reverse. A wooden floor, a grey blanket or a sheet of card
                is fine. Use the same one for every item and your listings start to look
                like a shop rather than a pile.
              </dd>
            </div>
            <div className="rounded-xl border p-5">
              <dt className="font-semibold">Shoot straight down, not at an angle</dt>
              <dd className="mt-2 text-sm text-muted-foreground">
                Stand over the garment with the phone parallel to the floor. Shooting from
                the chest at an angle makes the near end larger, which is exactly the
                distortion that gets a listing accused of misrepresenting the fit.
              </dd>
            </div>
            <div className="rounded-xl border p-5">
              <dt className="font-semibold">Do not stand between the window and the garment</dt>
              <dd className="mt-2 text-sm text-muted-foreground">
                The most common ruined photo in resale. Shoot with the light coming across
                the garment from the side rather than over your own shoulder, and check the
                frame for your shadow before you take twelve of them.
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Photographing a flaw</h2>
          <p className="mt-3 text-muted-foreground">
            The section no competing page has, and the one that changes what you earn. A
            disclosed flaw costs a percentage of the price. An undisclosed one costs the
            item, the postage both ways and a marketplace case.
          </p>
          <ul className="mt-6 grid gap-4">
            <li className="rounded-xl border p-5">
              <h3 className="font-semibold">Tight, once, with something for scale</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                One clear photo of each flaw, filling the frame, with a coin or a fingertip
                in shot so the size reads. Five angles of the same small stain makes it look
                like the worst thing about the garment.
              </p>
            </li>
            <li className="rounded-xl border p-5">
              <h3 className="font-semibold">Show it in the light it is visible in</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                A pull or a thin patch often disappears under flat light and appears when
                the light rakes across it. Photograph it in the condition a buyer would
                notice it, not the one that makes it vanish.
              </p>
            </li>
            <li className="rounded-xl border p-5">
              <h3 className="font-semibold">Say where it is, not just what it is</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                A close-up with no context leaves a buyer imagining it across the chest. Pair
                the tight shot with the front shot and name the location in the caption.
              </p>
            </li>
            <li className="rounded-xl border p-5">
              <h3 className="font-semibold">Then grade it, so the words match the photo</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Photos show the flaw and a grade says how much it matters. One seller's
                "good" is another's "like new", and that gap is where returns come from.{" "}
                <Link to="/condition-grading" className="font-medium text-primary hover:underline">
                  How condition grading works
                </Link>
                .
              </p>
            </li>
          </ul>
        </div>
      </section>

      <section className="border-t px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Common questions</h2>
          <dl className="mt-6 grid gap-5">
            {faqs.map((f) => (
              <div key={f.q} className="rounded-xl border p-5">
                <dt className="font-semibold">{f.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{f.a}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-8 text-sm text-muted-foreground">
            Two narrower questions have their own pages:{" "}
            <Link
              to="/blog/best-order-ebay-clothing-listing-photos"
              className="font-medium text-primary hover:underline"
            >
              the best order for eBay clothing photos
            </Link>{" "}
            and{" "}
            <Link
              to="/blog/why-ebay-listing-thumbnails-lose-clicks-photo-consistency"
              className="font-medium text-primary hover:underline"
            >
              why thumbnails lose clicks
            </Link>
            .
          </p>
        </div>
      </section>

      <CalculatorHandoff calc={CALC} />

      <MarketingCTA
        heading="Good photos earn the click. A grade earns the trust"
        sub="The photos get a buyer to stop scrolling. What stops them opening a not-as-described case is knowing what the condition actually is before they buy."
      />
    </MarketingLayout>
  );
}
