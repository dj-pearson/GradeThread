import { Link } from "react-router";
import { LegalLayout } from "@/components/legal/legal-layout";

// Provider identification ("Impressum"/"Imprint"). Legally required for EU
// visitors — Germany's §5 DDG (ex-§5 TMG) and Austria's §5 ECG mandate an
// easily accessible imprint with the provider's name, address, and contact.
const POSTAL_ADDRESS_LINES: string[] = [
  "Pearson Media LLC",
  "7888 Beechtree Ln",
  "West Des Moines, IA 50266",
  "United States",
];

export function ImprintPage() {
  return (
    <LegalLayout
      title="Imprint / Legal Notice"
      description="Provider identification and legal notice for GradeThread, operated by Pearson Media LLC (Impressum / §5 DDG)."
      canonicalPath="/imprint"
      effectiveDate="July 2, 2026"
    >
      <p>
        This page provides the legally required provider identification (the
        &ldquo;Impressum&rdquo; or legal notice) for the GradeThread and FlipDesk
        services.
      </p>

      <h2 id="provider">Provider</h2>
      <p>
        {POSTAL_ADDRESS_LINES.map((line, i) => (
          <span key={i}>
            {line}
            <br />
          </span>
        ))}
      </p>
      <p>
        Pearson Media LLC is a limited liability company organized under the laws
        of the State of Iowa, United States.
      </p>

      <h2 id="contact">Contact</h2>
      <p>
        General: <a href="mailto:support@gradethread.com">support@gradethread.com</a>
        <br />
        Legal: <a href="mailto:legal@gradethread.com">legal@gradethread.com</a>
        <br />
        Privacy / data protection:{" "}
        <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a>
        <br />
        Website: <a href="https://gradethread.com">gradethread.com</a>
      </p>

      <h2 id="responsible">Responsible for content</h2>
      <p>
        Pearson Media LLC is responsible for the content of this website within
        the meaning of applicable media and telemedia law.
      </p>

      <h2 id="dispute-resolution">Consumer dispute resolution</h2>
      <p>
        The European Commission provides a platform for online dispute
        resolution (ODR) at{" "}
        <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noreferrer">
          ec.europa.eu/consumers/odr
        </a>
        . We are neither obliged nor generally willing to participate in dispute
        resolution proceedings before a consumer arbitration board. Disputes are
        handled as described in our <Link to="/terms">Terms of Service</Link>.
      </p>

      <h2 id="more">More legal information</h2>
      <p>
        See our <Link to="/privacy">Privacy Policy</Link>,{" "}
        <Link to="/terms">Terms of Service</Link>,{" "}
        <Link to="/cookies">Cookie Policy</Link>, and{" "}
        <Link to="/dmca">Copyright / DMCA</Link> page for further details.
      </p>
    </LegalLayout>
  );
}
