import { Link } from "react-router-dom";
import { LegalLayout } from "@/components/legal/legal-layout";

export function AccessibilityPage() {
  return (
    <LegalLayout
      title="Accessibility Statement"
      description="GradeThread's commitment to digital accessibility and WCAG 2.1 AA conformance."
      canonicalPath="/accessibility"
      effectiveDate="April 1, 2026"
    >
      <p>
        Pearson Media LLC is committed to making GradeThread and FlipDesk
        accessible to everyone, including people who use assistive technologies.
        We aim to conform to the{" "}
        <a
          href="https://www.w3.org/TR/WCAG21/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Web Content Accessibility Guidelines (WCAG) 2.1, Level AA
        </a>
        .
      </p>

      <h2 id="measures">1. Measures we take</h2>
      <ul>
        <li>Semantic HTML, labeled form controls, and accessible names on icon-only controls.</li>
        <li>Keyboard operability and visible focus indicators for interactive elements.</li>
        <li>Color is never the sole means of conveying status or information.</li>
        <li>Automated accessibility checks (axe) run in our CI pipeline on every change.</li>
        <li>Color-contrast targets that meet AA in both light and dark themes.</li>
      </ul>

      <h2 id="conformance">2. Conformance status</h2>
      <p>
        GradeThread is <strong>partially conformant</strong> with WCAG 2.1 AA:
        most of the product meets the standard, and we are actively remediating
        the remaining gaps. Automated testing covers a meaningful subset of
        success criteria; we supplement it with manual review.
      </p>

      <h2 id="limitations">3. Known limitations</h2>
      <p>Despite our efforts, some areas may not yet be fully accessible:</p>
      <ul>
        <li>
          Complex data grids (e.g. the bulk inventory editor) are being improved
          for full screen-reader and keyboard parity.
        </li>
        <li>
          Some third-party embedded components (payment, analytics) are outside
          our direct control; we choose accessible vendors where possible.
        </li>
        <li>
          User-generated images may lack descriptive alt text supplied by the
          uploader.
        </li>
      </ul>

      <h2 id="feedback">4. Feedback and remediation</h2>
      <p>
        If you encounter an accessibility barrier, please tell us — we treat
        accessibility reports as a priority and will work with you on an
        accommodation. Contact{" "}
        <a href="mailto:accessibility@gradethread.com">
          accessibility@gradethread.com
        </a>{" "}
        and include the page, the issue, and the assistive technology you use.
        We aim to acknowledge reports within 5 business days.
      </p>

      <h2 id="related">5. Related policies</h2>
      <p>
        See our <Link to="/privacy">Privacy Policy</Link> and{" "}
        <Link to="/terms">Terms of Service</Link> for related information.
      </p>
    </LegalLayout>
  );
}
