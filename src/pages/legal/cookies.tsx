import { Link } from "react-router-dom";
import { LegalLayout } from "@/components/legal/legal-layout";

export function CookiesPage() {
  return (
    <LegalLayout
      title="Cookie Policy"
      description="How GradeThread uses cookies and similar technologies."
      canonicalPath="/cookies"
      effectiveDate="April 1, 2026"
    >
      <p>
        This Cookie Policy explains how Pearson Media LLC
        (&ldquo;GradeThread,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or
        &ldquo;our&rdquo;) uses cookies and similar technologies on{" "}
        <a href="https://gradethread.com">gradethread.com</a> and within the
        FlipDesk workspace. It supplements our{" "}
        <Link to="/privacy">Privacy Policy</Link>.
      </p>

      <h2 id="what-are-cookies">1. What are cookies?</h2>
      <p>
        Cookies are small text files stored on your device by your browser
        when you visit a website. They let the site remember information
        about your visit. We also use similar technologies such as local
        storage, session storage, pixels, and SDKs, which we refer to
        collectively as &ldquo;cookies&rdquo; in this policy.
      </p>

      <h2 id="categories">2. Cookies we use</h2>

      <h3>2.1 Strictly necessary</h3>
      <p>
        Required to operate the Service, sign you in, keep you signed in,
        maintain session state, and protect against fraud and abuse. The
        Service will not function correctly without these.
      </p>
      <ul>
        <li>
          <strong>Supabase auth tokens</strong> &mdash; authentication and
          session continuity (stored in local storage with PKCE).
        </li>
        <li>
          <strong>Cloudflare</strong> &mdash; bot mitigation, DDoS protection,
          and edge routing.
        </li>
        <li>
          <strong>CSRF and security tokens</strong> &mdash; protect against
          cross-site request forgery on form submissions.
        </li>
        <li>
          <strong>UI preferences</strong> &mdash; theme, sidebar state, and
          onboarding progress.
        </li>
      </ul>

      <h3>2.2 Analytics and performance</h3>
      <p>
        Help us understand how visitors and signed-in users interact with the
        Service so we can improve it.
      </p>
      <ul>
        <li>
          <strong>PostHog</strong> &mdash; product analytics (pageviews,
          feature usage, funnels). PostHog cookies and IDs typically expire
          within 12 months.
        </li>
      </ul>

      <h3>2.3 Diagnostics and error monitoring</h3>
      <ul>
        <li>
          <strong>Sentry</strong> &mdash; captures crashes, stack traces, and
          performance traces so we can debug issues. Sentry uses session
          identifiers but does not place advertising cookies.
        </li>
      </ul>

      <h3>2.4 Payment processing</h3>
      <ul>
        <li>
          <strong>Stripe</strong> &mdash; required for checkout, subscription
          management, fraud prevention, and PCI compliance on billing pages.
        </li>
      </ul>

      <h3>2.5 Advertising</h3>
      <p>
        We do not currently use third-party advertising cookies or sell
        personal information for advertising purposes. If that changes, we
        will update this policy and provide an opt-out where required.
      </p>

      <h2 id="duration">3. How long do cookies stay?</h2>
      <p>
        <strong>Session cookies</strong> expire when you close your browser.{" "}
        <strong>Persistent cookies</strong> remain until they expire or you
        delete them. The retention of each cookie depends on its purpose; for
        example, auth tokens are refreshed regularly, while UI preferences may
        persist for up to a year.
      </p>

      <h2 id="choices">4. Your choices</h2>
      <ul>
        <li>
          <strong>Browser controls.</strong> Most browsers let you block or
          delete cookies through their settings. Blocking strictly necessary
          cookies will break sign-in and other core features.
        </li>
        <li>
          <strong>Do Not Track.</strong> Because no common industry standard
          exists for honoring DNT signals, we do not respond to them. We do,
          however, honor Global Privacy Control (GPC) signals where required
          by law.
        </li>
        <li>
          <strong>Analytics opt-out.</strong> You can disable product
          analytics from your account preferences in{" "}
          <Link to="/dashboard/settings">Settings</Link> where available.
        </li>
        <li>
          <strong>Mobile devices.</strong> You can reset advertising
          identifiers and limit ad tracking in your device settings.
        </li>
      </ul>

      <h2 id="changes">5. Changes to this policy</h2>
      <p>
        We may update this Cookie Policy from time to time. When we do, we
        will revise the &ldquo;Effective date&rdquo; above and, where
        required, provide additional notice.
      </p>

      <h2 id="contact">6. Contact</h2>
      <p>
        Questions about cookies? Email{" "}
        <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a>.
      </p>
    </LegalLayout>
  );
}
