import { Link } from "react-router";
import { LegalLayout } from "@/components/legal/legal-layout";

interface Subprocessor {
  name: string;
  purpose: string;
  data: string;
  location: string;
}

// Keep this list in sync with the third parties that actually process personal
// data (cross-checked against dependencies + env config). Update the effective
// date below on any change and notify customers per the policy in §3.
//
// US-2527: the April 2026 list named neither Google nor Apple while the product
// was writing a seller's inventory into their Google Drive, taking Play and App
// Store payments, and pushing notifications through FCM and APNs. It also
// stopped at eBay while four more marketplace integrations had shipped. The
// cross-check that found them is a grep for outbound hosts across
// services/edge-functions plus the env reference in vault/10-ops — a dependency
// list alone would have missed every one of these, because they are reached by
// URL and configured by env var.
//
// NOT listed, deliberately: IndexNow (submits public URLs, no personal data),
// and the social networks the share buttons link to (an outbound link the user
// clicks is not a processor acting for us).
const SUBPROCESSORS: Subprocessor[] = [
  { name: "Supabase (self-hosted)", purpose: "Database, auth, storage", data: "Account data, grading photos, grades", location: "United States" },
  { name: "Cloudflare", purpose: "CDN, Pages hosting, R2 object storage, WAF", data: "Request metadata, served content, stored assets", location: "Global (US-config)" },
  { name: "Stripe", purpose: "Payments & subscription billing", data: "Billing details, payment tokens, email", location: "United States" },
  { name: "Anthropic", purpose: "AI condition grading & listing generation (Claude)", data: "Garment photos, listing text (no account PII)", location: "United States" },
  { name: "OpenAI", purpose: "Listing/marketing image generation", data: "Image prompts/inputs", location: "United States" },
  { name: "eBay", purpose: "Marketplace listing, orders, payouts (FlipDesk)", data: "Listing content, order/payout data", location: "United States" },
  { name: "Etsy", purpose: "Marketplace listing & orders (FlipDesk)", data: "Listing content, order data", location: "United States" },
  { name: "Depop", purpose: "Marketplace listing & orders (FlipDesk)", data: "Listing content, order data", location: "United Kingdom / United States" },
  { name: "Whatnot", purpose: "Marketplace listing & orders (FlipDesk)", data: "Listing content, order data", location: "United States" },
  { name: "Shopify", purpose: "Storefront listing & orders (FlipDesk)", data: "Listing content, order data", location: "Canada / United States" },
  { name: "Google (Alphabet)", purpose: "Sign-in, Sheets sync into the seller's own Drive, Photos import, Android push (FCM), Google Play billing, Google Ads & Search Console reporting", data: "Email address, inventory rows the seller syncs, selected photos, device push tokens, purchase receipts", location: "United States" },
  { name: "Apple", purpose: "Sign in with Apple, iOS push (APNs), App Store in-app purchases", data: "Email address (or Apple's private relay address), device push tokens, purchase receipts", location: "United States" },
  // Optional, and it says so: the route 503s unless the operator has configured
  // REMOVE_BG_API_KEY. A list that omitted it would be wrong on any deployment
  // where it IS configured, and a photo is a photo.
  { name: "Intuit (QuickBooks Online) — only when connected", purpose: "Accounting sync: the seller's own sales, fees, expenses and payouts pushed into their QuickBooks company file", data: "Transaction amounts, dates, account names and receipt images the seller chooses to sync. No buyer PII and no garment photos.", location: "United States" },
  { name: "remove.bg (Kaleido AI) — only when enabled", purpose: "Optional background removal on a listing photo", data: "The single garment photo submitted for removal", location: "Austria / European Union" },
  { name: "Sentry", purpose: "Error monitoring", data: "Redacted error context, request metadata", location: "United States" },
  { name: "PostHog", purpose: "Product analytics (consent-gated)", data: "Usage events, pseudonymous identifiers", location: "United States" },
  { name: "Email/SMTP provider (e.g. Amazon SES)", purpose: "Transactional & lifecycle email", data: "Email address, message content", location: "United States" },
  { name: "Coolify host / VPS provider", purpose: "Edge service + self-hosted Supabase hosting", data: "All processed data in transit/at rest on the host", location: "United States" },
];

export function SubprocessorsPage() {
  return (
    <LegalLayout
      title="Subprocessors"
      description="The third-party subprocessors GradeThread (Pearson Media LLC) uses to process personal data."
      canonicalPath="/subprocessors"
      effectiveDate="August 14, 2026"
    >
      <p>
        GradeThread (Pearson Media LLC) engages the third-party subprocessors
        below to provide the Service. Each processes personal data only as needed
        for its stated purpose and under contractual data-protection obligations.
        This list is referenced by our <Link to="/privacy">Privacy Policy</Link>{" "}
        and <Link to="/dpa">Data Processing Addendum</Link>.
      </p>

      <h2 id="list">1. Current subprocessors</h2>
      <p>Last updated: August 14, 2026.</p>
      <table>
        <thead>
          <tr>
            <th>Subprocessor</th>
            <th>Purpose</th>
            <th>Data processed</th>
            <th>Primary location</th>
          </tr>
        </thead>
        <tbody>
          {SUBPROCESSORS.map((s) => (
            <tr key={s.name}>
              <td>{s.name}</td>
              <td>{s.purpose}</td>
              <td>{s.data}</td>
              <td>{s.location}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 id="changes">2. Changes &amp; notification</h2>
      <p>
        We update this page when we add or replace a subprocessor and revise the
        &ldquo;Last updated&rdquo; date above. Customers with an active DPA may
        subscribe to change notifications by emailing{" "}
        <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a>; we
        aim to provide reasonable advance notice of a new subprocessor so you can
        raise any objection.
      </p>

      <h2 id="contact">3. Contact</h2>
      <p>
        Questions about our subprocessors or data processing:{" "}
        <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a>.
      </p>
    </LegalLayout>
  );
}
