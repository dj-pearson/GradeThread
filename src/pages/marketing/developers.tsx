// US-596: public developer docs for the Grade-as-a-Service API. Documents auth,
// endpoints, the SDK, the free sandbox, rate limits, quotas, and the pricing
// tier — the "beyond internal plumbing" product surface. Prerendered + indexable
// (registered in PUBLIC_ROUTES + entry-server).
import { Link } from "react-router-dom";
import { Code, FlaskConical, Gauge, KeyRound, Package, Layout, LineChart } from "lucide-react";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { FLIPDESK_PLANS } from "@/lib/constants";

const ENDPOINTS = [
  { method: "POST", path: "/api/v1/grades", scope: "submit", desc: "Submit a garment (photos) for grading." },
  { method: "GET", path: "/api/v1/grades/:id", scope: "read", desc: "Fetch a submission and its grade report." },
  { method: "GET", path: "/api/v1/grades", scope: "read", desc: "List grades, paginated." },
  { method: "PATCH", path: "/api/v1/webhook", scope: "webhook_manage", desc: "Set the URL we POST to when a grade completes." },
  { method: "POST", path: "/api/v1/sandbox/grades", scope: "submit", desc: "Free mock submit — returns a sample grade, no credits." },
  { method: "GET", path: "/api/v1/sandbox/grades/:id", scope: "read", desc: "Free mock fetch — returns a sample grade." },
  { method: "GET", path: "/api/v1/price-guide", scope: "read", desc: "List published Resale Condition Index items (the catalog)." },
  { method: "GET", path: "/api/v1/price-guide/:slug", scope: "read", desc: "Resale value range + sell-through by grade band for an item." },
  { method: "GET", path: "/api/v1/sandbox/price-guide/:slug", scope: "read", desc: "Free mock price guide — deterministic sample, no live data." },
];

const RATE_TIERS = [
  { plan: "Free / downgraded", read: 30, write: 5 },
  { plan: "Starter", read: 60, write: 10 },
  { plan: "Pro", read: 120, write: 20 },
  { plan: "Business (API access)", read: 240, write: 40 },
];

const CURL_EXAMPLE = `curl https://functions.gradethread.com/api/v1/sandbox/grades \\
  -X POST \\
  -H "X-API-Key: gt_sk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Vintage denim jacket","brand":"Levi'\\''s"}'`;

const PRICE_GUIDE_EXAMPLE = `curl https://functions.gradethread.com/api/v1/price-guide/patagonia-better-sweater \\
  -H "X-API-Key: gt_sk_..."

# → { "data": { "slug": "patagonia-better-sweater", "brand": "Patagonia",
#       "bands": [ { "band": "high", "gradeRange": "8.5 – 10.0",
#                    "valueLowCents": 6500, "valueMedianCents": 8200,
#                    "valueHighCents": 9800, "sellThrough": 0.78 }, ... ] } }`;

const SDK_EXAMPLE = `import { GradeThread } from "@gradethread/sdk";

const gt = new GradeThread({ apiKey: process.env.GRADETHREAD_API_KEY });

// Try it free in the sandbox (no credits spent):
const sample = await gt.sandbox.grades.create({ title: "Vintage denim jacket" });
console.log(sample.grade_report.overall_score); // e.g. 8.5

// Live grading:
const job = await gt.grades.create({
  title: "Vintage denim jacket",
  garment_type: "outerwear",
  garment_category: "jacket",
  images: [
    { image_type: "front", url: "https://.../front.jpg" },
    { image_type: "back", url: "https://.../back.jpg" },
    { image_type: "label", url: "https://.../label.jpg" },
    { image_type: "detail", url: "https://.../detail.jpg" },
  ],
});
const result = await gt.grades.get(job.id);`;

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Code;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t px-6 py-12">
      <div className="mx-auto max-w-4xl">
        <h2 className="flex items-center gap-2 text-2xl font-bold">
          <Icon className="h-6 w-6 text-brand-navy dark:text-foreground" />
          {title}
        </h2>
        <div className="mt-6 space-y-4 text-sm text-muted-foreground">{children}</div>
      </div>
    </section>
  );
}

export function DevelopersPage() {
  const businessPrice = (FLIPDESK_PLANS.business.priceMonthlyCents / 100).toFixed(0);

  return (
    <MarketingLayout
      title="Grading API for Developers"
      description="Embed GradeThread AI clothing condition grading via a REST API and JavaScript SDK — free sandbox, white-label embeds, documented rate limits and pricing."
      canonicalPath="/developers"
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Grade-as-a-Service API
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Embed standardized, AI-powered clothing condition grading into your
            marketplace, resale app, or internal tooling. Send photos, get a
            1.0–10.0 condition grade, a factor-by-factor report, and a verifiable
            certificate — all through a simple REST API with a JavaScript SDK, a
            free sandbox, and white-label embeds.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              to="/signup"
              className="inline-flex items-center justify-center rounded-md bg-brand-navy px-6 py-3 text-sm font-medium text-white hover:bg-brand-navy/90"
            >
              Get an API key
            </Link>
            <Link
              to="/pricing"
              className="inline-flex items-center justify-center rounded-md border px-6 py-3 text-sm font-medium hover:bg-accent"
            >
              See pricing
            </Link>
          </div>
        </div>
      </section>

      <Section icon={KeyRound} title="Authentication">
        <p>
          Every request authenticates with an API key in the{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">X-API-Key</code> header.
          Keys are created in your dashboard under Account → API keys (Business
          plan), are shown once, and can be scoped to{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">read</code>,{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">submit</code>, and{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">webhook_manage</code>.
          Rotate or revoke a key at any time. Base URL:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">https://functions.gradethread.com</code>.
        </p>
      </Section>

      <Section icon={Code} title="Endpoints">
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-2 font-medium">Method</th>
                <th className="px-4 py-2 font-medium">Path</th>
                <th className="px-4 py-2 font-medium">Scope</th>
                <th className="px-4 py-2 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {ENDPOINTS.map((e) => (
                <tr key={`${e.method} ${e.path}`} className="border-t">
                  <td className="px-4 py-2 font-mono text-xs">{e.method}</td>
                  <td className="px-4 py-2 font-mono text-xs">{e.path}</td>
                  <td className="px-4 py-2 text-xs">{e.scope}</td>
                  <td className="px-4 py-2 text-xs">{e.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          All responses share one envelope:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">{`{ data, error, meta }`}</code>.
        </p>
      </Section>

      <Section icon={FlaskConical} title="Free sandbox">
        <p>
          Build and test your integration with zero credits. The sandbox
          endpoints return deterministic sample grades — same auth, scopes, and
          response shape as production, so the only thing you change to go live is
          the URL path.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
          <code>{CURL_EXAMPLE}</code>
        </pre>
      </Section>

      <Section icon={LineChart} title="Resale Condition Index price guide">
        <p>
          Beyond grading, the API exposes GradeThread's proprietary{" "}
          <Link to="/resale-condition-report" className="font-medium text-brand-navy hover:underline dark:text-foreground">
            Resale Condition Index
          </Link>{" "}
          as a queryable price guide: for a published brand-and-category item, the
          resale <strong>value range</strong> and <strong>sell-through</strong> at
          each condition-grade band. It's read-scoped and rate-limited like every
          other endpoint, with a free sandbox. Every figure is aggregate-only and
          sample-gated — items and bands without enough recent data are not
          returned rather than guessed.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
          <code>{PRICE_GUIDE_EXAMPLE}</code>
        </pre>
      </Section>

      <Section icon={Package} title="JavaScript SDK">
        <p>
          A zero-dependency, typed client for Node and the browser.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
          <code>npm install @gradethread/sdk</code>
        </pre>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
          <code>{SDK_EXAMPLE}</code>
        </pre>
      </Section>

      <Section icon={Gauge} title="Rate limits & quotas">
        <p>
          Limits are enforced per API key in a 60-second sliding window, with
          separate budgets for reads (GET) and writes (POST/PATCH). Exceeding a
          budget returns <code className="rounded bg-muted px-1.5 py-0.5">429</code>{" "}
          with a <code className="rounded bg-muted px-1.5 py-0.5">retry_after_seconds</code>{" "}
          hint. Live usage is shown on your dashboard.
        </p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-2 font-medium">Plan</th>
                <th className="px-4 py-2 font-medium">Reads / min</th>
                <th className="px-4 py-2 font-medium">Writes / min</th>
              </tr>
            </thead>
            <tbody>
              {RATE_TIERS.map((t) => (
                <tr key={t.plan} className="border-t">
                  <td className="px-4 py-2 text-xs">{t.plan}</td>
                  <td className="px-4 py-2 font-mono text-xs">{t.read}</td>
                  <td className="px-4 py-2 font-mono text-xs">{t.write}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Grading volume (quota) is metered by credits: each live grade spends 1
          credit (Standard), 3 (Premium), or 5 (Express). Sandbox calls are free
          and never spend credits.
        </p>
      </Section>

      <Section icon={Layout} title="White-label embeds">
        <p>
          Render any grade certificate inside your own platform, under your brand.
          Set your company name, color, and logo in the dashboard and copy the
          generated <code className="rounded bg-muted px-1.5 py-0.5">&lt;iframe&gt;</code>{" "}
          snippet — buyers see the grade in your brand with a small
          &quot;Verified by GradeThread&quot; trust mark.
        </p>
      </Section>

      <Section icon={KeyRound} title="Pricing">
        <p>
          API access, white-label embeds, and the developer dashboard are included
          in the <strong>Business plan</strong> (${businessPrice}/mo). Grading is
          billed per grade via credits on top — see the{" "}
          <Link to="/pricing" className="font-medium text-brand-navy hover:underline dark:text-foreground">
            pricing page
          </Link>{" "}
          for credit packs and per-grade tiers.
        </p>
      </Section>

      <MarketingCTA
        heading="Build with the grading standard"
        sub="Get an API key, try the free sandbox, and ship standardized condition grading into your product."
      />
    </MarketingLayout>
  );
}
