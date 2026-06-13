import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { CornerstoneLinks } from "@/components/marketing/cornerstone-links";
import {
  DESIGN_VS_DAMAGE_FAQS,
  designVsDamageJsonLd,
} from "@/pages/marketing/marketing-jsonld";

const ROWS = [
  {
    effect: "Rips & holes",
    design: "Evenly placed, finished or reinforced edges, symmetric across a pair of jeans.",
    damage: "A single tear at a stress point, frayed and growing, with no matching counterpart.",
  },
  {
    effect: "Fading",
    design: "Acid wash, ombré, or whiskering that follows a deliberate, repeating pattern.",
    damage: "Uneven sun-fading on one panel, or a faded ring where something rubbed.",
  },
  {
    effect: "Raw / unfinished edges",
    design: "Raw hems and exposed seams that are clean and consistent — a design choice.",
    damage: "Fraying that started at a worn cuff or hem the maker had finished.",
  },
  {
    effect: "Distressed texture",
    design: "All-over sanding, pre-pilled or slubby fabric the garment was made with.",
    damage: "Localized pilling at friction points, thinning elbows, or a snagged pull.",
  },
];

export function DesignVsDamagePage() {
  return (
    <MarketingLayout
      title="Intentional Design vs. Damage"
      description="Factory distressing, raw hems, and acid washes are design, not flaws. How to tell intentional design from real damage so you don't underprice or earn a return."
      canonicalPath="/design-vs-damage"
      jsonLd={designVsDamageJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Intentional design vs. damage
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Distressed denim with factory rips. A raw-hem tee. An acid-washed
            jacket. None of these are damaged — they were made that way. Call one
            of them "flawed" and you underprice a perfectly good piece; call real
            damage "intentional styling" and you earn a not-as-described return.
            Grading a garment well starts with telling the two apart.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">The core distinction</h2>
          <p className="mt-3 text-muted-foreground">
            A garment is graded against its <em>intended, as-made</em> condition.
            Intentional design is consistent, deliberate, and part of how the
            item was manufactured. Damage is incidental, uneven, and a deviation
            from that made state. Design is a feature; damage is a defect.
          </p>
          <p className="mt-4 text-muted-foreground">
            That's why factory-distressed jeans aren't penalized for the rips
            they were designed with — they lose points only for wear or damage
            layered on top, like a blown-out pocket, a stain, or fading the maker
            never intended.
          </p>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Design or damage? A field guide</h2>
          <div className="mt-8 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">Effect</th>
                  <th className="px-4 py-3 text-left font-semibold">
                    Usually design
                  </th>
                  <th className="px-4 py-3 text-left font-semibold">
                    Usually damage
                  </th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r.effect} className="border-t align-top">
                    <td className="px-4 py-3 font-medium">{r.effect}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.design}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.damage}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            The quick test: is the effect <em>symmetric and repeating</em>
            (design) or <em>localized and growing</em> (damage)? When in doubt,
            check the matching part of the garment — a real design choice is
            mirrored; wear is not.
          </p>
        </div>
      </section>

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">How GradeThread handles it</h2>
          <p className="mt-3 text-muted-foreground">
            The grade is assessed against the garment's intended construction, so
            intentional distressing doesn't drag down{" "}
            <Link
              to="/grading/structural-integrity"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              structural integrity
            </Link>{" "}
            or{" "}
            <Link
              to="/grading/fabric-condition"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              fabric condition
            </Link>{" "}
            on its own. Intentional-design misreads are one of the error rates we
            measure and publish on the{" "}
            <Link
              to="/transparency"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              transparency report
            </Link>
            , and when the model isn't confident an effect is design rather than
            damage, the grade is routed for human review before it's finalized.
          </p>
          <p className="mt-4 text-sm text-muted-foreground">
            The distinction matters most on vintage, where age-appropriate
            character is expected — see{" "}
            <Link
              to="/grading-by-category"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              condition grading by category
            </Link>
            .
          </p>
        </div>
      </section>

      <CornerstoneLinks />

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">
            Design vs. damage FAQ
          </h2>
          <dl className="mt-10 space-y-6">
            {DESIGN_VS_DAMAGE_FAQS.map((faq) => (
              <div key={faq.q} className="border-b pb-6 last:border-b-0">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="mt-2 text-sm text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-10 text-center">
            <Link to="/signup">
              <Button
                size="lg"
                className="bg-brand-navy text-white hover:bg-brand-navy/90"
              >
                Grade an item free
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <MarketingCTA
        heading="Grade distressed pieces with confidence"
        sub="Let an objective grade separate the design from the damage — and price the piece for what it really is."
      />
    </MarketingLayout>
  );
}
