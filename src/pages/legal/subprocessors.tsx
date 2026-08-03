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
const SUBPROCESSORS: Subprocessor[] = [
  { name: "Supabase (self-hosted)", purpose: "Database, auth, storage", data: "Account data, grading photos, grades", location: "United States" },
  { name: "Cloudflare", purpose: "CDN, Pages hosting, R2 object storage, WAF", data: "Request metadata, served content, stored assets", location: "Global (US-config)" },
  { name: "Stripe", purpose: "Payments & subscription billing", data: "Billing details, payment tokens, email", location: "United States" },
  { name: "Anthropic", purpose: "AI condition grading & listing generation (Claude)", data: "Garment photos, listing text (no account PII)", location: "United States" },
  { name: "OpenAI", purpose: "Listing/marketing image generation", data: "Image prompts/inputs", location: "United States" },
  { name: "eBay", purpose: "Marketplace listing, orders, payouts (FlipDesk)", data: "Listing content, order/payout data", location: "United States" },
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
      effectiveDate="April 1, 2026"
    >
      <p>
        GradeThread (Pearson Media LLC) engages the third-party subprocessors
        below to provide the Service. Each processes personal data only as needed
        for its stated purpose and under contractual data-protection obligations.
        This list is referenced by our <Link to="/privacy">Privacy Policy</Link>{" "}
        and <Link to="/dpa">Data Processing Addendum</Link>.
      </p>

      <h2 id="list">1. Current subprocessors</h2>
      <p>Last updated: April 1, 2026.</p>
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
