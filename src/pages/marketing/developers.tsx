// US-596: public developer docs for the Grade-as-a-Service API. Documents auth,
// endpoints, the SDK, the free sandbox, rate limits, quotas, and the pricing
// tier — the "beyond internal plumbing" product surface. Prerendered + indexable
// (registered in PUBLIC_ROUTES + entry-server).
import { Link } from "react-router";
import { Bot, Code, FlaskConical, Gauge, KeyRound, Package, Layout, LineChart, Layers, ShieldCheck, Webhook, FileJson, ListChecks } from "lucide-react";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";
import { HelpCategoryLink } from "@/components/marketing/help-category-link";
import { FLIPDESK_PLANS } from "@/lib/constants";

// US-9126: the Claude connector.
//
// Written for a seller deciding whether to let an AI touch their store, not for
// an integrator reading a reference. So every row says what the tool WILL do and
// what it WILL NOT, and the confirm step is stated rather than implied — the
// question a reader actually has is "can it publish something without asking me".
const CONNECTOR_TOOLS: Array<{
  name: string;
  prompt: string;
  does: string;
  wont: string;
}> = [
  {
    name: "gradethread_list_items",
    prompt: "\u201cWhat is still unlisted from last week?\u201d",
    does: "Lists inventory with filters for brand, category, status and date.",
    wont: "Change anything. Read-only.",
  },
  {
    name: "gradethread_grading_readiness",
    prompt: "\u201cWhy can I not grade the Carhartt jacket yet?\u201d",
    does: "Names the missing photos and fields per item, the cost, and whether your credits cover the batch.",
    wont: "Submit anything or spend a credit.",
  },
  {
    name: "gradethread_grade_item / _batch",
    prompt: "\u201cSend these six for grading.\u201d",
    does: "Previews the exact items and cost, then submits once you confirm. Uses your grading credits.",
    wont: "Grade anything on the first call. Preview always comes first, and the token it returns expires in ten minutes.",
  },
  {
    name: "gradethread_create_draft",
    prompt: "\u201cWrite listings for everything I graded today.\u201d",
    does: "Generates title, description, category, item specifics and a suggested price from the item's photos.",
    wont: "Publish. It writes a draft and tells you when the batch is done.",
  },
  {
    name: "gradethread_update_draft",
    prompt: "\u201cShorten that title and set it to $48.\u201d",
    does: "Edits title, description, price, quantity, condition and item specifics on an unpublished draft.",
    wont: "Touch a listing that is already live. It refuses those and points at the reprice tool.",
  },
  {
    name: "gradethread_publish_listing",
    prompt: "\u201cPut the denim jacket live.\u201d",
    does: "Shows exactly what buyers will see, what eBay takes, and anything blocking it \u2014 then publishes on a second, confirmed call.",
    wont: "Publish in one call, publish at a price that changed after you agreed, or tell you it worked when eBay did not confirm it.",
  },
  {
    name: "gradethread_reprice_preview / _apply",
    prompt: "\u201cWhat should the Levi\u2019s be priced at?\u201d",
    does: "Prices from live sold comparables and shows before-and-after per listing before changing anything.",
    wont: "Move a price more than 25%, or below an item's cost floor \u2014 even if you confirm it. Do those in FlipDesk, looking at the listing.",
  },
  {
    name: "gradethread_end_listing / _listings",
    prompt: "\u201cPull everything from that thrift haul.\u201d",
    does: "Lists every affected item BY NAME, then ends them once confirmed, and reports which actually came down.",
    wont: "Act on a count alone, or claim a listing ended when the marketplace has not taken it down yet.",
  },
  {
    // US-3065. The honest sentence is the whole entry: it queues, it does not
    // list. A reader who takes "list these on Poshmark" to mean the listing
    // goes live has been misled by us, not by their assistant.
    name: "gradethread_queue_extension_work",
    prompt: "“List these twelve on Poshmark and Mercari.”",
    does:
      "Queues the work for your own browser, naming every item and channel first. " +
      "It runs the next time you open your browser with the GradeThread extension " +
      "installed — Poshmark, Mercari, Grailed, Vinted and Facebook have no " +
      "listing API, so nothing else can do it for you.",
    wont:
      "Put anything live by itself. The work waits for your desktop, and the " +
      "confirmation says so rather than reporting a listing that does not exist yet.",
  },
  {
    name: "gradethread_extension_queue",
    prompt: "“What is my browser still waiting to do?”",
    does:
      "Shows what is queued, running and needing attention, including work that " +
      "expired before a browser ever picked it up.",
    wont: "Change anything. Read-only.",
  },
  {
    name: "gradethread_comps / _price_guide",
    prompt: "\u201cWhat do these usually sell for?\u201d",
    does: "Returns sold comparables and the published Resale Condition Index bands.",
    wont: "Change anything. Read-only.",
  },
];

const CONNECTOR_SCOPES: Array<{ scope: string; grants: string }> = [
  { scope: "read", grants: "See inventory, grades, listings and sales. Cannot change anything." },
  {
    scope: "submit",
    grants:
      "Grade items, write and edit drafts, publish, reprice and end listings. This is the one that spends money.",
  },
  { scope: "webhook_manage", grants: "Create and remove webhook subscriptions." },
];

const ENDPOINTS = [
  { method: "POST", path: "/api/v1/grades", scope: "submit", desc: "Submit a garment (photos) for grading." },
  { method: "POST", path: "/api/v1/grades/batch", scope: "submit", desc: "Submit up to 50 garments as one durable async batch." },
  { method: "GET", path: "/api/v1/grades/batch/:id", scope: "read", desc: "Poll a batch's status + per-garment results." },
  { method: "GET", path: "/api/v1/grades/:id", scope: "read", desc: "Fetch a submission and its grade report." },
  { method: "GET", path: "/api/v1/grades", scope: "read", desc: "List grades, paginated." },
  { method: "GET", path: "/api/v1/usage", scope: "read", desc: "This key's monthly call usage vs quota + reset date." },
  { method: "GET", path: "/api/v1/items", scope: "read", desc: "List inventory items, paginated and filterable by status." },
  { method: "GET", path: "/api/v1/items/:id", scope: "read", desc: "Fetch one inventory item and its attributes." },
  { method: "GET", path: "/api/v1/listings", scope: "read", desc: "List marketplace listings, paginated." },
  { method: "GET", path: "/api/v1/sales", scope: "read", desc: "List completed sales, paginated." },
  { method: "PATCH", path: "/api/v1/webhook", scope: "webhook_manage", desc: "Set the URL we POST to when a grade completes." },
  { method: "POST", path: "/api/v1/sandbox/grades", scope: "submit", desc: "Free mock submit — returns a sample grade, no credits." },
  { method: "GET", path: "/api/v1/sandbox/grades/:id", scope: "read", desc: "Free mock fetch — returns a sample grade." },
  { method: "GET", path: "/api/v1/price-guide", scope: "read", desc: "List published Resale Condition Index items (the catalog)." },
  { method: "GET", path: "/api/v1/price-guide/:slug", scope: "read", desc: "Resale value range + sell-through by grade band for an item." },
  { method: "GET", path: "/api/v1/sandbox/price-guide", scope: "read", desc: "Free mock catalog — the sandbox mirror of the list endpoint." },
  { method: "GET", path: "/api/v1/sandbox/price-guide/:slug", scope: "read", desc: "Free mock price guide — deterministic sample, no live data." },
];

// Public, no key required — the machine-readable spec for Postman / codegen.
const OPENAPI_URL = "https://functions.gradethread.com/api/v1/openapi.json";

// US-2515: these mirror the server's API_RATE_TIERS
// (services/edge-functions/src/middleware/api-v1-rate.ts:30-33) exactly. There
// used to be a fifth row — "Enterprise, 600/120" — for a plan that does not
// exist: `enterprise` is a LEGACY user_plan value the shim maps onto business
// (constants.ts:675), not something anyone can buy. A public page was quoting
// API capacity nobody could ever be granted.
const RATE_TIERS = [
  { plan: "Free / downgraded", read: 30, write: 5 },
  { plan: "Starter", read: 60, write: 10 },
  { plan: "Pro", read: 120, write: 20 },
  { plan: "Business (API access)", read: 240, write: 40 },
];

const BATCH_EXAMPLE = `curl https://functions.gradethread.com/api/v1/grades/batch \\
  -X POST \\
  -H "X-API-Key: gt_sk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"garments":[
        {"title":"Denim jacket","garment_type":"outerwear","garment_category":"jacket",
         "images":[{"image_type":"front","url":"https://.../f.jpg"},
                   {"image_type":"back","url":"https://.../b.jpg"},
                   {"image_type":"label","url":"https://.../l.jpg"},
                   {"image_type":"detail","url":"https://.../d.jpg"}]}
      ]}'

# → 202 { "data": { "id": "<batch_id>", "status": "running", "item_count": 1 } }
# Poll GET /api/v1/grades/batch/<batch_id> for per-garment results.`;

const WEBHOOK_EXAMPLE = `POST <your webhook_url>
X-GradeThread-Signature: <hex HMAC-SHA256 of the raw body>

{
  "event": "grade.completed",
  "data": {
    "submission_id": "…",
    "grade_report": { "id": "…", "overall_score": 8.5,
                      "grade_tier": "Excellent", "certificate_id": "…",
                      "finalized_at": "2026-07-09T…Z" }
  },
  "timestamp": "2026-07-09T…Z"
}`;

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

const CONNECTOR_ADD_COMMAND =
  "claude mcp add --transport http gradethread https://functions.gradethread.com/mcp";

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
  // US-9126: read from the plan matrix rather than typed into the copy. A price
  // or an allowance that lives in two places is one that disagrees with itself
  // the first time either moves, and this is the page a prospect decides on.
  const proPrice = (FLIPDESK_PLANS.pro.priceMonthlyCents / 100).toFixed(0);
  const proConnectorActions = FLIPDESK_PLANS.pro.connectorActionsPerMonth;
  const businessConnectorActions = FLIPDESK_PLANS.business.connectorActionsPerMonth;

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

      <Section icon={ListChecks} title="Quickstart">
        <ol className="list-decimal space-y-3 pl-5">
          <li>
            <strong className="text-foreground">Create an API key.</strong> In your
            dashboard under Account → API keys (Business plan), create a key and
            grant only the scopes you need (<code className="rounded bg-muted px-1 py-0.5">submit</code>,{" "}
            <code className="rounded bg-muted px-1 py-0.5">read</code>,{" "}
            <code className="rounded bg-muted px-1 py-0.5">webhook_manage</code>). The
            secret is shown once — store it safely. Rotate or revoke it anytime.
          </li>
          <li>
            <strong className="text-foreground">Try it free in the sandbox.</strong>{" "}
            Call <code className="rounded bg-muted px-1 py-0.5">/api/v1/sandbox/grades</code>{" "}
            (below) — deterministic sample grades, zero credits, same shapes as
            production.
          </li>
          <li>
            <strong className="text-foreground">Go live.</strong> Drop the{" "}
            <code className="rounded bg-muted px-1 py-0.5">/sandbox</code> path, attach
            real photos (front, back and label are required; a detail close-up is
            recommended), and submit to{" "}
            <code className="rounded bg-muted px-1 py-0.5">/api/v1/grades</code>. Poll{" "}
            <code className="rounded bg-muted px-1 py-0.5">/api/v1/grades/:id</code> or
            receive a webhook.
          </li>
          <li>
            <strong className="text-foreground">Scale up.</strong> Grade up to 50
            garments per call with{" "}
            <code className="rounded bg-muted px-1 py-0.5">/api/v1/grades/batch</code>{" "}
            and let webhooks push each result as it finishes.
          </li>
        </ol>
      </Section>

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
        <p className="flex items-center gap-2">
          <FileJson className="h-4 w-4 flex-shrink-0 text-brand-navy dark:text-foreground" />
          <span>
            Full machine-readable reference (OpenAPI 3.1) —{" "}
            <a
              href={OPENAPI_URL}
              className="font-medium text-brand-navy hover:underline dark:text-foreground"
              target="_blank"
              rel="noreferrer"
            >
              openapi.json
            </a>
            . No key required; import it into Postman, Insomnia, or your codegen of choice.
          </span>
        </p>
      </Section>

      <Section icon={Layers} title="Batch grading">
        <p>
          Grade up to 50 garments in one call. The batch is durable and async:
          you get a batch id back immediately, each garment is graded and charged
          independently (partial success is fine), and a{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">grade.completed</code>{" "}
          webhook fires per garment. Poll the batch-status endpoint for
          per-garment results. Every garment is validated the same way as a single
          grade — an invalid garment rejects the whole request up front. Prefer
          image URLs over base64 in a batch.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
          <code>{BATCH_EXAMPLE}</code>
        </pre>
      </Section>

      <Section icon={Webhook} title="Webhooks">
        <p>
          Set a webhook URL with{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">PATCH /api/v1/webhook</code>{" "}
          (or in your dashboard). When a grade finalizes we POST a{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">grade.completed</code>{" "}
          event. Each delivery carries an{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">X-GradeThread-Signature</code>{" "}
          header — an HMAC-SHA256 (hex) of the raw request body, signed with your
          API key's secret hash — so you can verify authenticity. Failed
          deliveries retry with backoff (5s / 30s / 120s).
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
          <code>{WEBHOOK_EXAMPLE}</code>
        </pre>
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

      <Section icon={Bot} title="Claude connector">
        <p>
          Connect GradeThread to Claude and run your pipeline from a conversation:
          ask what is unlisted, get drafts written, publish, reprice, end listings.
          It is a{" "}
          <a
            href="https://modelcontextprotocol.io"
            className="font-medium text-brand-navy hover:underline dark:text-foreground"
            rel="noopener noreferrer"
            target="_blank"
          >
            Model Context Protocol
          </a>{" "}
          server, so it works in Claude Code, the Claude desktop and web apps, and
          anything else that speaks MCP.
        </p>
        <p>
          Included on <strong>Pro</strong> (${proPrice}/mo) and{" "}
          <strong>Business</strong> (${businessPrice}/mo). Pro includes{" "}
          {proConnectorActions.toLocaleString()} connector actions a month and
          Business {businessConnectorActions.toLocaleString()}; reading costs
          nothing and is not counted. The sandbox tools work on every plan,
          including Free, so you can see what it does before paying for it.
        </p>

        <h3 className="pt-2 font-semibold text-foreground">Adding it</h3>
        <p>In Claude Code:</p>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
          <code>{CONNECTOR_ADD_COMMAND}</code>
        </pre>
        <p>
          In the Claude web or desktop app: <strong>Settings → Connectors → Add
          custom connector</strong>, then paste{" "}
          <code className="rounded bg-muted px-1.5 py-0.5">
            https://functions.gradethread.com/mcp
          </code>
          . Either way you will be sent to GradeThread to sign in and choose what
          to allow.
        </p>

        <h3 className="pt-2 font-semibold text-foreground">What you are asked to allow</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-4 font-semibold text-foreground">Scope</th>
                <th className="py-2 font-semibold text-foreground">What it lets Claude do</th>
              </tr>
            </thead>
            <tbody>
              {CONNECTOR_SCOPES.map((s) => (
                <tr key={s.scope} className="border-b last:border-0">
                  <td className="py-2 pr-4 align-top">
                    <code className="rounded bg-muted px-1.5 py-0.5">{s.scope}</code>
                  </td>
                  <td className="py-2 align-top">{s.grants}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          You can turn any of these off on the consent screen and still connect.
          A read-only connection is a normal thing to want.
        </p>

        <h3 className="pt-2 font-semibold text-foreground">The tools</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-4 font-semibold text-foreground">Tool</th>
                <th className="py-2 pr-4 font-semibold text-foreground">Ask for it like this</th>
                <th className="py-2 pr-4 font-semibold text-foreground">What it does</th>
                <th className="py-2 font-semibold text-foreground">What it will not do</th>
              </tr>
            </thead>
            <tbody>
              {CONNECTOR_TOOLS.map((t) => (
                <tr key={t.name} className="border-b last:border-0">
                  <td className="py-2 pr-4 align-top">
                    <code className="rounded bg-muted px-1.5 py-0.5">{t.name}</code>
                  </td>
                  <td className="py-2 pr-4 align-top italic">{t.prompt}</td>
                  <td className="py-2 pr-4 align-top">{t.does}</td>
                  <td className="py-2 align-top">{t.wont}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section icon={ShieldCheck} title="Connector safety">
        <p>
          <strong>Nothing that costs money or reaches a marketplace happens on
          one call.</strong> Grading, publishing, repricing, ending and relisting
          all preview first and then need a confirmation that is tied to the exact
          items and prices you were shown. If the price moves between the preview
          and the confirmation, the confirmation stops being valid and Claude has
          to show you the new one.
        </p>
        <p>
          On Claude clients that support it, you are also asked directly \u2014 a
          prompt with a yes-or-no, not a message from Claude saying it asked you.
        </p>
        <p>
          <strong>What it can spend.</strong> Grading uses your grading credits.
          Writing drafts uses one AI action per item. Publishing and repricing cost
          nothing themselves, but they change what buyers pay. Everything else is
          free to run.
        </p>
        <p>
          <strong>The caps, which apply even when you confirm.</strong> Per hour:
          20 publishes, 50 price changes, 20 listings ended. Per day: 200 grades.
          Per month: your plan's connector actions. And a price move over 25%, or
          below an item's cost basis, is refused outright \u2014 a confirmation is
          not a safety net for an arithmetic error.
        </p>
        <p>
          <strong>Turning it off.</strong>{" "}
          <Link
            to="/dashboard/api-keys"
            className="font-medium text-brand-navy hover:underline dark:text-foreground"
          >
            Settings → API keys
          </Link>{" "}
          lists every connected application. Disconnecting one stops it
          immediately \u2014 not at the end of an hour, and not at the end of a
          session.
        </p>
        <p>
          <strong>Every call is recorded.</strong> Each tool call is written to an
          audit log with the tool, the items it touched, whether it succeeded and
          why it was refused if it was \u2014 kept for 400 days. Ask support for
          your account's log if you ever need to reconstruct what happened.
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
      <div className="px-6 pb-12 lg:px-12">
        <div className="mx-auto max-w-5xl">
          <HelpCategoryLink category="integrations" label="API keys, the sandbox, rate limits and webhooks:" />
        </div>
      </div>

    </MarketingLayout>
  );
}
