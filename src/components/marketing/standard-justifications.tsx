import { Link } from "react-router-dom";
import { Scale, ScrollText, Repeat, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// US-1297: the four properties that make GradeThread *the* standard for
// pre-owned clothing condition grading — objective, published, reproducible,
// and independently verifiable. Rendered identically on the landing page,
// /about, and /grading-standard so the "we are the standard" positioning is
// unmistakable and citable, with each claim pointing at its proof: the
// published methodology (/grading-standard) and the accuracy report
// (/transparency). Only claims that are TRUE today — no guarantee/coverage
// promises (US-1298 owns that copy).
const JUSTIFICATIONS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Scale,
    title: "Objective",
    body: "Every garment is scored against one rubric — five weighted factors on a fixed 1.0–10.0 scale — not a subjective, seller-by-seller eyeball judgement.",
  },
  {
    icon: ScrollText,
    title: "Published",
    body: "The factors, their fixed weights, and the seven named tiers are disclosed up front — the rubric is open to inspect, not hidden in a black box.",
  },
  {
    icon: Repeat,
    title: "Reproducible",
    body: "Because the rubric and weights are fixed, two items in the same condition earn the same grade — regardless of who submits them or when.",
  },
  {
    icon: ShieldCheck,
    title: "Independently verifiable",
    body: "Every grade becomes a public certificate buyers can open and check, and we publish our measured accuracy against expert reviewers.",
  },
];

const LINK_CLASS =
  "font-medium text-brand-navy hover:underline dark:text-foreground";

/**
 * The "why GradeThread is the standard" band: the four justifications plus a
 * proof line linking to the methodology (/grading-standard) and the published
 * accuracy report (/transparency). Set `methodologyLink={false}` when rendered
 * ON the grading-standard page itself so it doesn't link back to where it sits.
 */
export function StandardJustifications({
  heading = "Why GradeThread is the standard",
  intro,
  methodologyLink = true,
  className,
}: {
  heading?: string;
  intro?: string;
  methodologyLink?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto max-w-3xl", className)}>
      <h2 className="text-3xl font-bold">{heading}</h2>
      {intro ? <p className="mt-3 text-muted-foreground">{intro}</p> : null}
      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        {JUSTIFICATIONS.map((j) => (
          <div key={j.title} className="rounded-lg border bg-card p-5">
            <div className="flex items-center gap-2 text-brand-navy dark:text-foreground">
              <j.icon className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
              <h3 className="font-semibold">{j.title}</h3>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{j.body}</p>
          </div>
        ))}
      </div>
      <p className="mt-6 text-sm text-muted-foreground">
        {methodologyLink ? (
          <>
            See the full{" "}
            <Link to="/grading-standard" className={LINK_CLASS}>
              grading standard
            </Link>{" "}
            and our{" "}
            <Link to="/transparency" className={LINK_CLASS}>
              published accuracy report
            </Link>
            .
          </>
        ) : (
          <>
            We hold the standard to account: our{" "}
            <Link to="/transparency" className={LINK_CLASS}>
              published accuracy report
            </Link>{" "}
            measures every grade against expert reviewers.
          </>
        )}
      </p>
    </div>
  );
}
