import { Link } from "react-router-dom";
import { LegalLayout } from "@/components/legal/legal-layout";

export function PrivacyPage() {
  return (
    <LegalLayout
      title="Privacy Policy"
      description="How GradeThread collects, uses, and protects your information."
      canonicalPath="/privacy"
      effectiveDate="June 12, 2026"
    >
      <p>
        This Privacy Policy explains how Pearson Media LLC (&ldquo;Pearson
        Media,&rdquo; &ldquo;GradeThread,&rdquo; &ldquo;we,&rdquo;
        &ldquo;us,&rdquo; or &ldquo;our&rdquo;) collects, uses, and shares
        information when you use the GradeThread website at{" "}
        <a href="https://gradethread.com">gradethread.com</a>, the FlipDesk
        reseller workspace, our APIs, and related services (collectively, the
        &ldquo;Service&rdquo;).
      </p>
      <p>
        By using the Service, you agree to the practices described in this
        policy. If you do not agree, please do not use the Service. This policy
        works together with our{" "}
        <Link to="/terms">Terms of Service</Link>,{" "}
        <Link to="/cookies">Cookie Policy</Link>, and{" "}
        <Link to="/acceptable-use">Acceptable Use Policy</Link>.
      </p>

      <h2 id="who-we-are">1. Who we are</h2>
      <p>
        Pearson Media LLC is the controller of personal information processed
        through the Service. You can reach our privacy team at{" "}
        <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a>.
      </p>

      <h2 id="what-we-collect">2. Information we collect</h2>

      <h3>2.1 Information you provide</h3>
      <ul>
        <li>
          <strong>Account information.</strong> Name, email address, password
          (hashed), and profile details when you create an account.
        </li>
        <li>
          <strong>Garment photos and item data.</strong> Images you upload for
          grading, plus garment metadata such as category, brand, size, color,
          measurements, defect notes, and cost basis.
        </li>
        <li>
          <strong>Photo (EXIF) metadata.</strong> When you upload a garment
          photo, we may read technical metadata embedded in the original file —
          camera make and model, the date and time the photo was taken, and, if
          your device recorded it, GPS location. We use this only to support
          grade authenticity and provenance features. This metadata is stored
          privately against your submission, is access-controlled, and is{" "}
          <strong>never shown publicly, on certificates, or to buyers</strong>.
          Its absence is normal and never lowers a grade. We may optionally
          retain the unmodified original file for forensic verification where
          enabled for your plan; you can request deletion of this metadata and
          any retained original at any time (see “Your rights” below), and it is
          removed when the underlying submission is deleted.
        </li>
        <li>
          <strong>Verified Capture (opt-in provenance).</strong> If you choose
          the optional Verified Capture path for a submission, we check the
          provenance metadata described above — the device make/model and the
          capture timestamp of each photo — to confirm the photos were taken
          recently, on a single consistent device, were not edited, and are not
          reused from another account. When those checks pass, we award a{" "}
          <strong>Verified Capture</strong> badge on the public certificate and
          modestly raise the grade’s confidence. Only the pass/fail result and
          the badge are ever shown publicly — the underlying device and
          timestamp details stay private and access-controlled. Verified Capture
          is entirely optional, you control it per submission, and choosing not
          to use it (or not qualifying) never lowers your grade.
        </li>
        <li>
          <strong>Reseller workflow data (FlipDesk).</strong> Sources, intake
          batches, drafts, listings, sales, payouts, expenses, and notes you
          enter into FlipDesk.
        </li>
        <li>
          <strong>Payment information.</strong> When you subscribe to a paid
          plan, our payment processor (Stripe) collects card or bank details on
          our behalf. We receive limited information such as the last four
          digits of your card, brand, expiration, billing ZIP, and subscription
          status; we do not store full card numbers.
        </li>
        <li>
          <strong>Communications.</strong> Messages you send to our support,
          billing, or privacy addresses, and feedback you submit through the
          Service.
        </li>
        <li>
          <strong>Dispute submissions.</strong> Photos, text, and other
          information you submit when challenging a grade.
        </li>
      </ul>

      <h3>2.2 Information collected automatically</h3>
      <ul>
        <li>
          <strong>Usage data.</strong> Pages viewed, features used, clicks,
          referring URLs, session duration, and similar interaction events.
        </li>
        <li>
          <strong>Device and log data.</strong> IP address, browser type and
          version, operating system, device identifiers, language preference,
          and timestamps.
        </li>
        <li>
          <strong>Cookies and similar technologies.</strong> See our{" "}
          <Link to="/cookies">Cookie Policy</Link>.
        </li>
        <li>
          <strong>Diagnostic data.</strong> Crash reports and stack traces
          collected through our error-monitoring provider (Sentry), which we
          configure to minimize personal data &mdash; it does not collect your
          IP address or attach default personal data.
        </li>
        <li>
          <strong>Approximate location.</strong> We derive a coarse country
          (and, in the US, state) from your IP address at our CDN edge solely to
          show you the correct cookie-consent experience for your region. We do
          not store this signal for that purpose.
        </li>
      </ul>

      <h3>2.3 Information from third parties</h3>
      <ul>
        <li>
          <strong>Single sign-on.</strong> If you sign in with Google, we
          receive your name, email address, and profile image from Google.
        </li>
        <li>
          <strong>Marketplaces.</strong> If you connect an eBay, Poshmark,
          Mercari, or other marketplace account, we receive listing, order, and
          payout information you authorize that platform to share.
        </li>
        <li>
          <strong>Payment processor.</strong> Stripe shares subscription,
          invoice, and refund status with us.
        </li>
      </ul>

      <h2 id="how-we-use">3. How we use information</h2>
      <p>We use information to:</p>
      <ul>
        <li>Provide, operate, secure, and improve the Service;</li>
        <li>
          Generate AI-assisted condition grades, written summaries, and
          listing drafts;
        </li>
        <li>
          Issue and host shareable grade certificates that you choose to
          publish;
        </li>
        <li>
          Process payments, manage subscriptions, send invoices, and prevent
          fraud;
        </li>
        <li>
          Communicate with you about account, billing, security, and product
          updates;
        </li>
        <li>
          Send marketing emails (only where permitted; you can opt out at any
          time);
        </li>
        <li>
          Monitor performance, debug errors, and analyze aggregate usage to
          improve features;
        </li>
        <li>
          Train and refine internal grading prompts, evaluation sets, and
          quality metrics using de-identified or aggregated data;
        </li>
        <li>
          Comply with legal obligations, enforce our{" "}
          <Link to="/terms">Terms of Service</Link>, and protect the rights,
          safety, and property of Pearson Media, our users, and the public.
        </li>
      </ul>

      <h2 id="ai-and-photos">4. AI grading and your photos</h2>
      <p>
        When you submit a garment for grading, we send the photos and
        accompanying metadata to our AI vision provider, Anthropic (Claude
        Vision API), which analyzes the images to produce a grade and report.
      </p>
      <ul>
        <li>
          Anthropic processes the data as our subprocessor under contractual
          confidentiality and security terms.
        </li>
        <li>
          Anthropic does <strong>not</strong> use your photos or content to
          train its foundation models when accessed through our enterprise API
          configuration.
        </li>
        <li>
          We retain your original photos and the resulting grade report in our
          Supabase storage so you can view, share, and dispute them later.
        </li>
        <li>
          We may use de-identified images and aggregated grading outputs to
          evaluate model accuracy, build internal benchmarks, and improve
          prompts. We will not publish your specific images without your
          consent except as part of a certificate you have chosen to make
          public.
        </li>
        <li>
          You retain ownership of the photos you upload. See{" "}
          <Link to="/terms">Terms of Service</Link> for the license you grant
          us to process and display them.
        </li>
      </ul>

      <h3 id="human-qa">4.1 Human quality-assurance review</h3>
      <p>
        To keep grades accurate and consistent, a small number of trained
        GradeThread reviewers may view the photos you submitted for grading —
        for example to audit low-confidence AI grades, investigate disputes,
        or run inter-rater reliability studies in which several reviewers
        independently grade the same garments. This access is deliberately
        limited:
      </p>
      <ul>
        <li>
          <strong>Minimized.</strong> For reliability studies, reviewers see
          the garment photos and basic garment attributes (type, category,
          brand) only. Your name, email address, and other account details
          are never displayed alongside them, and seller-written titles and
          descriptions are excluded.
        </li>
        <li>
          <strong>Access-logged.</strong> Every reviewer view of a sampled
          submission's photos is recorded in an audit log identifying the
          reviewer, the item, and the time of access.
        </li>
        <li>
          <strong>In place, not copied.</strong> Reviewers view photos through
          short-lived, expiring links inside the platform; QA studies store
          only the resulting numeric ratings and notes, not copies of your
          photos.
        </li>
        <li>
          <strong>Confidential.</strong> Reviewers are bound by
          confidentiality obligations and may use what they see only for
          quality assurance.
        </li>
      </ul>
      <p>
        <strong>Consent and retention for QA use.</strong> QA review is part
        of providing and improving the Service and is covered by the license
        you grant in the <Link to="/terms">Terms of Service</Link> together
        with this disclosure; for EEA/UK users our legal basis is our
        legitimate interest in grading quality. We do not seek separate
        per-photo consent, but you may object to QA review of your photos at
        any time by emailing{" "}
        <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a>{" "}
        — objecting does not affect your grades or certificates. QA access
        ends when your photos are deleted under the retention schedule in{" "}
        <a href="#retention">Section 7</a> (or earlier on request); deleted
        photos drop out of QA samples because reviewers always read the live
        stored photo, never a copy.
      </p>

      <h2 id="certificates">5. Public grade certificates</h2>
      <p>
        Grade certificates are designed to be shareable. When you publish a
        certificate or share its link, the certificate page (including the
        overall score, factor breakdown, garment category, and the photos
        attached to that grade) becomes accessible to anyone with the URL.
        Search engines may also index certificates. You can request the
        removal of a certificate at any time by contacting{" "}
        <a href="mailto:support@gradethread.com">support@gradethread.com</a>.
      </p>

      <h2 id="sharing">6. How we share information</h2>
      <p>
        We do not sell personal information. We share it only as follows. A
        complete, dated list of our subprocessors is on the{" "}
        <a href="/subprocessors">Subprocessors</a> page, and customers with
        data-processing obligations can review our{" "}
        <a href="/dpa">Data Processing Addendum</a>.
      </p>
      <ul>
        <li>
          <strong>Service providers (subprocessors).</strong> Vendors that
          host, secure, monitor, and support the Service, including:
          <ul>
            <li>
              <strong>Supabase / self-hosted infrastructure</strong> &mdash;
              database, authentication, and object storage;
            </li>
            <li>
              <strong>Anthropic, PBC</strong> &mdash; Claude Vision API for
              AI-assisted grading and listing generation;
            </li>
            <li>
              <strong>Stripe, Inc.</strong> &mdash; payment processing,
              subscription billing, and tax handling;
            </li>
            <li>
              <strong>Cloudflare, Inc.</strong> &mdash; hosting, DNS, CDN, and
              edge security;
            </li>
            <li>
              <strong>PostHog, Inc.</strong> &mdash; product analytics;
            </li>
            <li>
              <strong>Functional Software, Inc. (Sentry)</strong> &mdash;
              error monitoring and performance tracing;
            </li>
            <li>
              <strong>Email delivery providers</strong> &mdash; transactional
              and marketing email.
            </li>
          </ul>
        </li>
        <li>
          <strong>Marketplaces and integrations.</strong> When you connect a
          third-party marketplace or tool, we exchange information with that
          service as needed to perform the integration.
        </li>
        <li>
          <strong>Legal and safety.</strong> To comply with applicable law,
          legal process, or enforceable government request; to enforce our
          terms; to detect fraud or abuse; or to protect the rights, property,
          or safety of Pearson Media, our users, or others.
        </li>
        <li>
          <strong>Business transfers.</strong> In connection with a merger,
          acquisition, financing, reorganization, bankruptcy, or sale of
          assets, subject to standard confidentiality protections.
        </li>
        <li>
          <strong>With your consent.</strong> For any other purpose disclosed
          to you and with your permission.
        </li>
      </ul>

      <h2 id="retention">7. Data retention</h2>
      <p>
        We retain personal information for as long as your account is active
        and as needed to provide the Service, then delete or de-identify it
        according to the schedule below. We retain data longer only where
        required for legal, accounting, tax, fraud-prevention, or
        dispute-resolution purposes. Aggregate or de-identified data that
        cannot reasonably be linked to you may be retained indefinitely.
      </p>
      <table>
        <thead>
          <tr>
            <th>Data category</th>
            <th>Retention period</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Grading photos (uploaded garment images)</td>
            <td>
              Automatically deleted 2 years after submission; the resulting
              grade report is anonymized (photos removed) and retained for
              certificate validity and accuracy analytics.
            </td>
          </tr>
          <tr>
            <td>Grade reports &amp; certificates</td>
            <td>Life of the account (the certificate must remain verifiable).</td>
          </tr>
          <tr>
            <td>Account profile &amp; authentication data</td>
            <td>Deleted or de-identified within 90 days of account closure.</td>
          </tr>
          <tr>
            <td>Billing &amp; transaction records</td>
            <td>Up to 7 years (tax/accounting obligations).</td>
          </tr>
          <tr>
            <td>Support &amp; dispute correspondence</td>
            <td>Up to 3 years after resolution.</td>
          </tr>
          <tr>
            <td>Server &amp; security logs</td>
            <td>Up to 90 days, then purged or aggregated.</td>
          </tr>
        </tbody>
      </table>
      <p>
        Grading-photo deletion is enforced automatically by a scheduled purge
        job; you can also request earlier deletion at any time (see{" "}
        <a href="#your-rights">Your rights</a>).
      </p>

      <h2 id="your-rights">8. Your rights and choices</h2>
      <p>
        Depending on where you live, you may have rights to access, correct,
        delete, restrict, or port your personal information, and to object to
        certain processing. You can exercise these rights by:
      </p>
      <ul>
        <li>
          Editing your profile and submissions directly in{" "}
          <Link to="/dashboard/settings">Settings</Link>;
        </li>
        <li>
          Deleting individual submissions, certificates, items, or your entire
          account from within the Service;
        </li>
        <li>
          Emailing{" "}
          <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a>{" "}
          with your request. We may need to verify your identity before acting.
        </li>
      </ul>
      <p>
        <strong>EEA/UK residents.</strong> Our legal bases for processing are
        the performance of a contract with you, your consent, our legitimate
        interests (such as securing and improving the Service), and compliance
        with legal obligations. You may lodge a complaint with your local
        supervisory authority.
      </p>
      <p>
        <strong>California residents.</strong> Under the CCPA/CPRA, you have
        the right to know what personal information we collect, the right to
        delete, the right to correct, the right to opt out of certain
        &ldquo;sharing,&rdquo; and the right to non-discrimination. We do not
        sell personal information.
      </p>

      <h2 id="security">9. Security</h2>
      <p>
        We use industry-standard administrative, technical, and physical
        safeguards to protect your information &mdash; including encryption in
        transit (TLS), encryption at rest for sensitive fields, row-level
        security in our database, and least-privilege access controls. No
        method of transmission or storage is 100% secure, and we cannot
        guarantee absolute security.
      </p>

      <h2 id="international">10. International transfers</h2>
      <p>
        Pearson Media LLC is based in the United States. If you access the
        Service from outside the U.S., your information will be transferred
        to, stored in, and processed in the U.S. and other countries where our
        subprocessors operate. Where required, we rely on appropriate transfer
        mechanisms such as the Standard Contractual Clauses.
      </p>

      <h2 id="children">11. Children</h2>
      <p>
        The Service is intended for adults. You must be at least 18 years old to
        use it (see our <Link to="/terms">Terms of Service</Link>). The Service
        is not directed to children, and we do not knowingly collect personal
        information from anyone under 18. If you believe a minor has provided us
        information, contact{" "}
        <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a> and
        we will delete it.
      </p>

      <h2 id="changes">12. Changes to this policy</h2>
      <p>
        We may update this Privacy Policy from time to time. When we make
        material changes, we will update the &ldquo;Effective date&rdquo;
        above and, where required, notify you via email or in-product
        notification. Your continued use of the Service after the change
        becomes effective constitutes acceptance of the updated policy.
      </p>

      <h2 id="contact">13. Contact us</h2>
      <p>
        Pearson Media LLC
        <br />
        Attn: Privacy
        <br />
        <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a>
      </p>
    </LegalLayout>
  );
}
