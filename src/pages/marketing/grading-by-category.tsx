import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { CornerstoneLinks } from "@/components/marketing/cornerstone-links";
import {
  GRADING_BY_CATEGORY_FAQS,
  gradingByCategoryJsonLd,
} from "@/pages/marketing/marketing-jsonld";

const CATEGORIES = [
  {
    name: "Denim",
    leadFactor: "Structural integrity",
    watch:
      "Blown inseams, frayed belt loops, and stress at the crotch and knees; fading the design didn't intend. Distressing the maker built in isn't a flaw.",
    shoot: "Inseam, hem, waistband, and any factory rips up close.",
  },
  {
    name: "Knits & sweaters",
    leadFactor: "Fabric condition",
    watch:
      "Pilling, felting, thinning at the elbows, and snags. Knits can look fine on a hanger and grade lower up close.",
    shoot: "A close surface shot, the cuffs, and the elbows.",
  },
  {
    name: "Leather & outerwear",
    leadFactor: "Cosmetic + functional",
    watch:
      "Scuffs, dryness or cracking, lining tears, and a smooth-running main zipper. Hardware that sticks pulls the functional score down.",
    shoot: "Corners and creases, the lining, and the zipper mid-travel.",
  },
  {
    name: "Shoes & sneakers",
    leadFactor: "Cosmetic + structural",
    watch:
      "Sole and tread wear, toe-box creasing, heel drag, and any sole separation. Box and extras help but don't change the grade.",
    shoot: "Soles, toe box, heel, and both shoes together.",
  },
  {
    name: "Vintage",
    leadFactor: "Design vs. damage",
    watch:
      "Age-appropriate character — soft hand, gentle fading, a single-stitch patina — is expected, not penalized, and quality period-appropriate repairs (professional reweaving, sympathetic darning) preserve value rather than cost points. What counts against the grade is damage layered on top: moth holes, stains, brittleness, and crude or unstable repairs.",
    shoot: "Tags and construction details, plus any flaw and any patina.",
  },
];

export function GradingByCategoryPage() {
  return (
    <MarketingLayout
      title="Condition Grading by Category"
      description="The 1.0–10.0 scale is universal, but wear isn't. How grading plays out for denim, knits, leather, shoes, and vintage — and what to photograph for each."
      canonicalPath="/grading-by-category"
      jsonLd={gradingByCategoryJsonLd()}
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Condition grading by category
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            The 1.0–10.0 scale and the five weighted factors stay the same for
            every garment. What changes is <em>where</em> a category fails:
            pilling sinks a sweater, a blown inseam sinks jeans, sole wear sinks
            sneakers. Knowing each category's weak points tells you what to clean
            up before listing and what to photograph for an accurate grade.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">
            Same standard, different failure modes
          </h2>
          <p className="mt-3 text-muted-foreground">
            Each category leans on a different{" "}
            <Link
              to="/condition-grading"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              grading factor
            </Link>
            . Here's where to look — and what to shoot — by type:
          </p>
          <div className="mt-8 space-y-4">
            {CATEGORIES.map((c) => (
              <div key={c.name} className="rounded-lg border bg-background p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-lg font-semibold">{c.name}</h3>
                  <span className="rounded-full bg-brand-navy/10 px-3 py-1 text-xs font-medium text-brand-navy dark:bg-foreground/10 dark:text-foreground">
                    Leads on: {c.leadFactor}
                  </span>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">
                    What lowers the grade:
                  </span>{" "}
                  {c.watch}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">
                    Photograph:
                  </span>{" "}
                  {c.shoot}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold">Why one scale still works</h2>
          <p className="mt-3 text-muted-foreground">
            A category-specific scale would make grades incomparable — a "9 for
            denim" wouldn't mean the same as a "9 for knits," which defeats the
            point of a standard. Instead, one published rubric scores every item,
            and the category just changes which factors carry the wear. That's
            how an{" "}
            <Link
              to="/grading/excellent"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              Excellent
            </Link>{" "}
            sweater and an Excellent pair of jeans land at the same grade for the
            same reason: low wear against their intended condition.
          </p>
          <p className="mt-4 text-sm text-muted-foreground">
            Vintage is where this gets subtle — see{" "}
            <Link
              to="/design-vs-damage"
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              intentional design vs. damage
            </Link>{" "}
            for how character is told apart from wear.
          </p>
        </div>
      </section>

      <CornerstoneLinks />

      <section className="border-t px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-3xl font-bold">
            Grading by category FAQ
          </h2>
          <dl className="mt-10 space-y-6">
            {GRADING_BY_CATEGORY_FAQS.map((faq) => (
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
        heading="Grade any category to one standard"
        sub="Denim, knits, leather, shoes, or vintage — get an objective grade and a certificate buyers trust."
      />
    </MarketingLayout>
  );
}
