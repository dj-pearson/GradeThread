import { Link } from "react-router-dom";
import { LegalLayout } from "@/components/legal/legal-layout";

export function AccessibilityPage() {
  return (
    <LegalLayout
      title="Accessibility Statement"
      description="GradeThread's commitment to digital accessibility: WCAG 2.1 AA, Section 508, and EN 301 549 conformance across our web app and iOS app."
      canonicalPath="/accessibility"
      effectiveDate="April 1, 2026"
    >
      <p>
        Pearson Media LLC is committed to making GradeThread and FlipDesk
        accessible to everyone, including people who use assistive technologies.
        This commitment applies to both our <strong>web application</strong> and
        our <strong>native iOS application</strong>. We aim to conform to the{" "}
        <a
          href="https://www.w3.org/TR/WCAG21/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Web Content Accessibility Guidelines (WCAG) 2.1, Level AA
        </a>
        .
      </p>
      <p>
        <em>Last conformance review: June 12, 2026.</em>
      </p>

      <h2 id="standards">1. Standards we follow</h2>
      <p>
        Our accessibility program is documented in a Voluntary Product
        Accessibility Template (VPAT® 2.5 INT) — an Accessibility Conformance
        Report covering, in a single document:
      </p>
      <ul>
        <li>
          <strong>WCAG 2.1</strong> Level A and Level AA (the W3C standard
          referenced by the ADA).
        </li>
        <li>
          <strong>Revised Section 508</strong> (U.S. — 36 CFR Part 1194).
        </li>
        <li>
          <strong>EN 301 549</strong> (EU accessibility requirements for ICT).
        </li>
      </ul>
      <p>
        Our VPAT / Accessibility Conformance Report is available to customers and
        procurement teams on request — email{" "}
        <a href="mailto:accessibility@gradethread.com">
          accessibility@gradethread.com
        </a>
        .
      </p>

      <h2 id="measures">2. Measures we take</h2>
      <ul>
        <li>Semantic HTML, landmarks, labeled form controls, and accessible names on icon-only controls.</li>
        <li>Full keyboard operability with visible focus indicators; focus is trapped and restored correctly in dialogs.</li>
        <li>Color is never the sole means of conveying status or information — we pair color with text, icons, or shapes.</li>
        <li>Color-contrast targets that meet AA (≥ 4.5:1 for normal text) in both light and dark themes.</li>
        <li>Respect for reduced-motion preferences and a full dark theme.</li>
        <li>Automated accessibility checks (axe and a build-blocking accessibility linter) run in our CI pipeline on every change, supplemented by manual review.</li>
      </ul>

      <h2 id="ios">3. Accessibility on iOS</h2>
      <p>
        The GradeThread iOS app is built to work with Apple&apos;s accessibility
        features. It supports:
      </p>
      <ul>
        <li>
          <strong>VoiceOver</strong> — labeled controls, grouped elements, and
          spoken announcements for results so the app can be explored with
          gestures, a keyboard, braille, or speech output.
        </li>
        <li>
          <strong>Voice Control</strong> — control names match their on-screen
          labels so you can tap, swipe, and type by voice.
        </li>
        <li>
          <strong>Larger Text (Dynamic Type)</strong> — text scales to 200% and
          beyond, with no artificial size cap.
        </li>
        <li>
          <strong>Dark Interface</strong> — a full dark color scheme that
          follows your system setting.
        </li>
        <li>
          <strong>Differentiate Without Color</strong> — key information such as
          grade tiers and statuses use shapes and text in addition to color.
        </li>
        <li>
          <strong>Sufficient Contrast</strong> — colors include high-contrast
          variants that respond to the Increase Contrast setting.
        </li>
        <li>
          <strong>Reduced Motion</strong> — animations are reduced or removed
          when Reduce Motion is enabled.
        </li>
      </ul>
      <p>
        Our app does not contain pre-recorded audio or video content, so{" "}
        <strong>Captions</strong> and <strong>Audio Descriptions</strong> do not
        apply.
      </p>

      <h2 id="conformance">4. Conformance status</h2>
      <p>
        GradeThread is <strong>partially conformant</strong> with WCAG 2.1 AA:
        the large majority of the product meets the standard, and we are actively
        remediating the remaining gaps. Automated testing covers a meaningful
        subset of success criteria; we supplement it with manual review and, on
        iOS, an automated accessibility audit in our test suite.
      </p>

      <h2 id="limitations">5. Known limitations</h2>
      <p>Despite our efforts, some areas may not yet be fully accessible:</p>
      <ul>
        <li>
          Downloadable condition-grade certificate <strong>PDFs</strong> are not
          yet fully tagged (PDF/UA); the equivalent online certificate page is
          accessible and provides the same information.
        </li>
        <li>
          Some complex data grids (e.g. the bulk inventory editor) are still
          being refined for complete screen-reader and keyboard parity.
        </li>
        <li>
          Some third-party embedded components (payment, analytics) are outside
          our direct control; we choose accessible vendors where possible.
        </li>
        <li>
          User-generated images may lack descriptive alt text supplied by the
          uploader; we provide photo-type labels (front, back, label, detail) as
          accessible names.
        </li>
      </ul>

      <h2 id="feedback">6. Feedback and remediation</h2>
      <p>
        If you encounter an accessibility barrier, please tell us — we treat
        accessibility reports as a priority and will work with you on an
        accommodation. Contact{" "}
        <a href="mailto:accessibility@gradethread.com">
          accessibility@gradethread.com
        </a>{" "}
        and include the page or screen, the issue, and the assistive technology
        you use. We aim to acknowledge reports within 5 business days.
      </p>

      <h2 id="related">7. Related policies</h2>
      <p>
        See our <Link to="/privacy">Privacy Policy</Link> and{" "}
        <Link to="/terms">Terms of Service</Link> for related information.
      </p>
    </LegalLayout>
  );
}
