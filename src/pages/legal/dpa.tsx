import { Link } from "react-router";
import { LegalLayout } from "@/components/legal/legal-layout";

export function DpaPage() {
  return (
    <LegalLayout
      title="Data Processing Addendum"
      description="GradeThread's Data Processing Addendum (DPA) for customers with GDPR/CCPA data-processing obligations."
      canonicalPath="/dpa"
      effectiveDate="June 12, 2026"
    >
      <p>
        This Data Processing Addendum (&ldquo;DPA&rdquo;) supplements the{" "}
        <Link to="/terms">Terms of Service</Link> between Pearson Media LLC
        (&ldquo;GradeThread&rdquo;, &ldquo;Processor&rdquo;) and the customer
        (&ldquo;Controller&rdquo;) and applies where GradeThread processes
        personal data on the Controller's behalf. It reflects obligations under
        the GDPR, UK GDPR, and CCPA/CPRA.
      </p>

      <h2 id="roles">1. Roles &amp; scope</h2>
      <p>
        For personal data a customer submits to the Service (e.g. end-user
        details in a workspace), the customer is the Controller and GradeThread
        is the Processor. GradeThread processes such data only on documented
        instructions, which include the Terms, this DPA, and use of the Service.
      </p>

      <h2 id="obligations">2. Processor obligations</h2>
      <ul>
        <li>Process personal data only for the purpose of providing the Service.</li>
        <li>Ensure personnel are bound by confidentiality.</li>
        <li>Implement appropriate technical and organizational security measures (encryption in transit/at rest, access controls, RLS tenant isolation, audited admin actions).</li>
        <li>Limit internal human review of customer-submitted photos (quality assurance and grading-reliability studies) to trained, confidentiality-bound personnel; minimize what reviewers see (no account identity or customer free text alongside photos), grant access through short-lived expiring links, and log every per-item view in an audit trail. See the <Link to="/privacy">Privacy Policy</Link>, section 4.1.</li>
        <li>Assist the Controller with data-subject requests, DPIAs, and breach notification.</li>
        <li>Delete or return personal data at the end of the engagement, subject to the retention schedule in the <Link to="/privacy">Privacy Policy</Link>.</li>
      </ul>

      <h2 id="subprocessors">3. Subprocessors</h2>
      <p>
        GradeThread uses the subprocessors listed on our{" "}
        <Link to="/subprocessors">Subprocessors page</Link>. We impose
        data-protection terms on each and remain responsible for their
        performance. We provide notice of new subprocessors as described there.
      </p>

      <h2 id="transfers">4. International transfers</h2>
      <p>
        Where personal data is transferred out of the EEA/UK, the parties rely on
        an appropriate transfer mechanism (e.g. the EU Standard Contractual
        Clauses), incorporated by reference into this DPA.
      </p>

      <h2 id="breach">5. Security incidents</h2>
      <p>
        GradeThread will notify the Controller without undue delay after becoming
        aware of a personal-data breach affecting the Controller's data, and will
        provide information reasonably necessary for the Controller to meet its
        own notification obligations.
      </p>

      <h2 id="request">6. Requesting a signed DPA</h2>
      <p>
        To execute a countersigned copy of this DPA, email{" "}
        <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a> with
        your legal entity name and signatory. Until countersigned, this published
        DPA governs GradeThread's processing of Controller personal data.
      </p>
    </LegalLayout>
  );
}
