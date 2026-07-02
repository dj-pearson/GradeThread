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
        Service so we can improve it. These are <strong>not</strong> set until
        you enable the &ldquo;Analytics&rdquo; category (see Section 4).
      </p>
      <ul>
        <li>
          <strong>Google Analytics 4</strong> &mdash; aggregate traffic and
          usage measurement. Loaded with Google Consent Mode defaulting to
          denied, so no analytics storage is used until you opt in.
        </li>
        <li>
          <strong>PostHog</strong> &mdash; product analytics (pageviews,
          feature usage, funnels). Not loaded at all until you opt in; its
          cookies and IDs typically expire within 12 months.
        </li>
      </ul>

      <h3>2.3 Diagnostics and error monitoring</h3>
      <ul>
        <li>
          <strong>Sentry</strong> &mdash; captures crashes and stack traces so
          we can debug issues. We run Sentry under our legitimate interest in
          the security and reliability of the Service, with personally
          identifying data minimized: it is configured <em>not</em> to collect
          your IP address or attach default personal data. It does not place
          advertising cookies.
        </li>
      </ul>

      <h3>2.4 Payment processing</h3>
      <ul>
        <li>
          <strong>Stripe</strong> &mdash; required for checkout, subscription
          management, fraud prevention, and PCI compliance on billing pages.
        </li>
      </ul>

      <h3>2.5 Marketing and advertising</h3>
      <p>
        If you enable the &ldquo;Marketing&rdquo; category, we may use
        advertising and remarketing technologies (such as Google Ads) to
        measure and personalize advertising. These are{" "}
        <strong>off by default</strong> and are never set unless you opt in
        (opt-in regions) or unless you have not opted out (opt-out regions). We
        do not otherwise sell your personal information. See Section 4 for how
        consent is requested where you are.
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
      <p>
        How we ask for consent depends on where you are, based on a coarse
        country signal from your IP address (we do not store it for this
        purpose):
      </p>
      <ul>
        <li>
          <strong>EU, EEA, UK, Switzerland, and elsewhere.</strong> We show a
          consent banner and set <em>no</em> analytics or marketing cookies
          until you make a choice. You can accept all, reject all (just as
          easily), or choose categories individually.
        </li>
        <li>
          <strong>United States.</strong> Analytics and marketing may run
          subject to your right to opt out. Use the &ldquo;Your Privacy
          Choices&rdquo; control in the banner or the &ldquo;Cookie
          settings&rdquo; link in the footer to opt out.
        </li>
      </ul>
      <ul>
        <li>
          <strong>Change your mind anytime.</strong> Select{" "}
          <strong>&ldquo;Cookie settings&rdquo;</strong> in the site footer to
          reopen the preferences manager and change or withdraw your consent.
        </li>
        <li>
          <strong>Global Privacy Control.</strong> In the United States we
          automatically honor the GPC browser signal as a valid opt-out; where
          it is present we treat it as a request to opt out without asking
          again.
        </li>
        <li>
          <strong>Do Not Track.</strong> Because no common industry standard
          exists for honoring DNT signals, we do not respond to them.
        </li>
        <li>
          <strong>Browser controls.</strong> Most browsers let you block or
          delete cookies through their settings. Blocking strictly necessary
          cookies will break sign-in and other core features.
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
