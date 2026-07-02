import { Link } from "react-router-dom";
import { LegalLayout } from "@/components/legal/legal-layout";

export function DmcaPage() {
  return (
    <LegalLayout
      title="Copyright & Content Takedown (DMCA)"
      description="How to report infringing or abusive content on GradeThread and FlipDesk, and our DMCA designated-agent information."
      canonicalPath="/dmca"
      effectiveDate="April 1, 2026"
    >
      <p>
        GradeThread hosts user-generated content — uploaded photos, AI-generated
        listings, and public grade certificates. We respond to valid reports of
        infringing, illegal, or abusive content under the U.S. Digital Millennium
        Copyright Act (DMCA) and our{" "}
        <Link to="/acceptable-use">Acceptable Use Policy</Link>.
      </p>

      <h2 id="report">1. How to report content</h2>
      <p>
        To report content that infringes your copyright, or that is otherwise
        abusive or violates our policies, email{" "}
        <a href="mailto:abuse@gradethread.com">abuse@gradethread.com</a> with the
        URL(s) and a description of the issue. For copyright claims, include the
        elements in section 3 below.
      </p>

      <h2 id="agent">2. DMCA designated agent</h2>
      <p>
        Copyright infringement notifications may be sent to our designated agent:
      </p>
      <p>
        DMCA Agent, Pearson Media LLC<br />
        7888 Beechtree Ln<br />
        West Des Moines, IA 50266, United States<br />
        Email: <a href="mailto:dmca@gradethread.com">dmca@gradethread.com</a>
      </p>
      <p>
        Our full provider details are also on the{" "}
        <Link to="/imprint">Imprint / Legal Notice</Link> page.
      </p>

      <h2 id="notice">3. Elements of a valid notice</h2>
      <p>A complete DMCA notice must include:</p>
      <ol>
        <li>Your physical or electronic signature.</li>
        <li>Identification of the copyrighted work claimed to be infringed.</li>
        <li>
          Identification of the infringing material and information reasonably
          sufficient to locate it (e.g. the certificate or listing URL).
        </li>
        <li>Your contact information (address, phone, email).</li>
        <li>
          A statement that you have a good-faith belief the use is not authorized
          by the copyright owner, its agent, or the law.
        </li>
        <li>
          A statement, under penalty of perjury, that the information is accurate
          and that you are the owner or authorized to act on the owner's behalf.
        </li>
      </ol>

      <h2 id="process">4. Our process</h2>
      <ul>
        <li>We review valid reports and remove or disable access to violating content, which may include revoking a public certificate or removing a listing/image.</li>
        <li>We notify the affected user where appropriate and may suspend repeat infringers.</li>
        <li>Counter-notices may be submitted to the agent above; we follow the DMCA counter-notice and restoration procedure.</li>
      </ul>

      <h2 id="abuse">5. Other abuse</h2>
      <p>
        For non-copyright abuse (harassment, illegal content, privacy violations),
        use <a href="mailto:abuse@gradethread.com">abuse@gradethread.com</a>. See
        the <Link to="/acceptable-use">Acceptable Use Policy</Link> for the full
        list of prohibited content and the enforcement actions we may take.
      </p>
    </LegalLayout>
  );
}
