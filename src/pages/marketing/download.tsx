import { Link } from "react-router";
import { Smartphone, Chrome, Puzzle, Check, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { track } from "@/lib/analytics";
import { appLinks, type AppLinkId } from "@/lib/app-links";
import { DOWNLOAD_META, DOWNLOAD_PATH } from "@/lib/seo/downloads";
import { DOWNLOAD_FAQS, downloadsJsonLd } from "@/pages/marketing/marketing-jsonld";

// US-3111: the one URL to hand somebody who asks where to get GradeThread.
//
// US-3110 put the three store links in the footer and on the dashboard, which
// answers "where" for a visitor already reading the site. It does not answer
// "which one do I want", and it is not something that can be pasted into a bio
// or a support reply. This page is both.
//
// The links come from src/lib/app-links.ts like every other surface. Nothing
// here hard-codes a store URL, and src/test/app-links.test.ts checks that.

const ICONS: Record<AppLinkId, typeof Smartphone> = {
  ios: Smartphone,
  chrome: Chrome,
  firefox: Puzzle,
};

// What each one is FOR, in the moment it is for. The blurbs on AppLink are one
// line each because a footer has one line; this page has room to say why a
// reseller would want two of them.
const PITCH: Record<
  AppLinkId,
  { moment: string; body: string; bullets: string[] }
> = {
  ios: {
    moment: "In the aisle",
    body: "The decision that costs you money is buy or walk, and you make it standing in a thrift store with a garment in one hand. The app grades from your camera, checks what the item has actually sold for, and saves it to your inventory before you reach the register.",
    bullets: [
      "Grade straight from the camera",
      "Check sold comps before you pay",
      "Photos and measurements sync to your desk",
    ],
  },
  chrome: {
    moment: "At the desk",
    body: "Listings get written on a laptop, in a marketplace tab you are already signed in to. The extension fills that tab from the item you already catalogued, so one garment is not typed out five times for five sites.",
    bullets: [
      "Cross-list to Poshmark, Mercari, Grailed, Vinted and Facebook",
      "Lists from your own logged-in tab",
      "Your marketplace password never reaches our servers",
    ],
  },
  firefox: {
    moment: "At the desk, in Firefox",
    body: "The same add-on, built for Firefox. It does everything the Chrome version does and installs from Mozilla's own add-on site.",
    bullets: [
      "Same cross-listing, same marketplaces",
      "Reviewed and hosted by Mozilla",
      "Signs in to the same GradeThread account",
    ],
  },
};

// The comparison a reseller actually wants: not a feature matrix, but which of
// the two surfaces does the job. Every row is something that genuinely differs.
const COMPARISON: Array<{ capability: string; phone: boolean; browser: boolean }> = [
  { capability: "Grade a garment from photos", phone: true, browser: true },
  { capability: "Shoot the photos with a camera", phone: true, browser: false },
  { capability: "Check sold comps before buying", phone: true, browser: true },
  { capability: "Write and edit a full listing", phone: true, browser: true },
  {
    capability: "Cross-list to Poshmark, Mercari, Grailed, Vinted, Facebook",
    phone: false,
    browser: true,
  },
  { capability: "List to eBay and Depop", phone: true, browser: true },
];

export function DownloadPage() {
  const links = appLinks();
  return (
    <MarketingLayout
      title={DOWNLOAD_META.title}
      description={DOWNLOAD_META.description}
      canonicalPath={DOWNLOAD_PATH}
      jsonLd={downloadsJsonLd()}
    >
      <section className="px-6 py-16 lg:px-12">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {DOWNLOAD_META.h1}
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            {DOWNLOAD_META.intro}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            {links.map((link) => {
              const Icon = ICONS[link.id];
              return (
                <Button key={link.id} asChild size="lg">
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() =>
                      track("app_download_click", {
                        app: link.id,
                        surface: "download-page-hero",
                      })
                    }
                  >
                    <Icon className="mr-2 h-4 w-4" aria-hidden="true" />
                    {link.cta}
                  </a>
                </Button>
              );
            })}
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Free to install, on every plan.{" "}
            <Link
              to="/pricing"
              className="underline underline-offset-4 hover:text-foreground"
            >
              See what grading costs
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="border-t px-6 py-16 lg:px-12">
        <div className="mx-auto flex max-w-3xl flex-col gap-12">
          {links.map((link) => {
            const Icon = ICONS[link.id];
            const pitch = PITCH[link.id];
            return (
              <article key={link.id} className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Icon
                    className="h-5 w-5 text-brand-navy dark:text-foreground"
                    aria-hidden="true"
                  />
                  <h2 className="text-2xl font-bold">{link.label}</h2>
                  <span className="text-sm text-muted-foreground">
                    {pitch.moment}
                  </span>
                </div>
                <p className="leading-relaxed text-muted-foreground">
                  {pitch.body}
                </p>
                <ul className="flex flex-col gap-2">
                  {pitch.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-2 text-sm">
                      <Check
                        className="mt-0.5 h-4 w-4 shrink-0 text-brand-navy dark:text-foreground"
                        aria-hidden="true"
                      />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <Button asChild variant="outline" className="self-start">
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() =>
                      track("app_download_click", {
                        app: link.id,
                        surface: "download-page-detail",
                      })
                    }
                  >
                    {link.cta}
                  </a>
                </Button>
              </article>
            );
          })}
        </div>
      </section>

      <section className="border-t px-6 py-16 lg:px-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Which one does what</h2>
          <p className="mt-3 text-muted-foreground">
            Both sign in to the same account and read the same inventory. These
            are the jobs where it matters which one you have open.
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th scope="col" className="py-3 pr-4 font-medium">
                    Job
                  </th>
                  <th scope="col" className="w-28 py-3 font-medium">
                    iPhone app
                  </th>
                  <th scope="col" className="w-28 py-3 font-medium">
                    Extension
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row) => (
                  <tr key={row.capability} className="border-b">
                    <th scope="row" className="py-3 pr-4 text-left font-normal">
                      {row.capability}
                    </th>
                    <Cell
                      yes={row.phone}
                      what={row.capability}
                      where="the iPhone app"
                    />
                    <Cell
                      yes={row.browser}
                      what={row.capability}
                      where="the browser extension"
                    />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="border-t px-6 py-16 lg:px-12">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold">Questions</h2>
          <dl className="mt-6 flex flex-col gap-6">
            {DOWNLOAD_FAQS.map((faq) => (
              <div key={faq.q} className="flex flex-col gap-2">
                <dt className="font-medium">{faq.q}</dt>
                <dd className="leading-relaxed text-muted-foreground">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <MarketingCTA
        heading="Install it, then grade something"
        sub="The free plan includes three grades a month, so you can put a real garment through it before you decide anything."
      />
    </MarketingLayout>
  );
}

// The yes/no cell. A screen reader gets a full sentence rather than an icon
// with no name, which is the usual way a comparison table becomes unreadable.
function Cell({
  yes,
  what,
  where,
}: {
  yes: boolean;
  what: string;
  where: string;
}) {
  return (
    <td className="py-3">
      {yes ? (
        <Check
          className="h-4 w-4 text-brand-navy dark:text-foreground"
          aria-hidden="true"
        />
      ) : (
        <Minus className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="sr-only">
        {yes ? `${what}: yes, in ${where}.` : `${what}: not in ${where}.`}
      </span>
    </td>
  );
}
