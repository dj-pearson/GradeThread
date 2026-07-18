import { Link } from "react-router-dom";
import { LegalLayout } from "@/components/legal/legal-layout";

export function AcceptableUsePage() {
  return (
    <LegalLayout
      title="Acceptable Use Policy"
      description="What you can and cannot do on GradeThread and FlipDesk."
      canonicalPath="/acceptable-use"
      effectiveDate="April 1, 2026"
    >
      <p>
        This Acceptable Use Policy (&ldquo;AUP&rdquo;) governs how you may use
        GradeThread, FlipDesk, and our APIs (the &ldquo;Service&rdquo;).
        It supplements and is incorporated into our{" "}
        <Link to="/terms">Terms of Service</Link>. Violations may result in
        warning, content removal, certificate revocation, account suspension,
        or termination.
      </p>

      <h2 id="prohibited-content">1. Prohibited content and conduct</h2>
      <p>You may not use the Service to upload, store, share, or generate:</p>
      <ul>
        <li>
          Content that is illegal, infringing, defamatory, harassing, hateful,
          threatening, or that violates the rights of others;
        </li>
        <li>
          Sexually explicit material, child sexual abuse material, or any
          content that exploits minors;
        </li>
        <li>
          Photos that you do not own or have permission to upload, or that
          contain personally identifying information of third parties (faces,
          IDs, payment cards) without consent;
        </li>
        <li>
          Malware, viruses, or any code designed to disrupt, damage, or gain
          unauthorized access to systems;
        </li>
        <li>
          Content that promotes terrorism, organized violence, or human
          trafficking.
        </li>
      </ul>

      <h2 id="prohibited-uses">2. Prohibited use of grading and certificates</h2>
      <ul>
        <li>
          <strong>No fraudulent grading.</strong> Do not submit photos that
          misrepresent the item being graded &mdash; for example, photos of a
          different garment, AI-generated or composited images, or photos
          deliberately staged to obscure defects.
        </li>
        <li>
          <strong>No counterfeits.</strong> Do not knowingly submit, grade,
          or list counterfeit, replica, or trademark-infringing items.
        </li>
        <li>
          <strong>No misrepresentation.</strong> Do not represent a
          GradeThread grade or certificate as an appraisal, authentication,
          or endorsement, or alter, deface, or forge a certificate.
        </li>
        <li>
          <strong>No reuse on different items.</strong> A certificate
          corresponds to the specific item it was issued for. Do not attach
          it to a different item in a listing.
        </li>
        <li>
          <strong>No reselling raw output.</strong> Do not resell, sublicense,
          or repackage AI grading output as a competing grading service.
        </li>
      </ul>

      <h2 id="technical-abuse">3. Technical abuse</h2>
      <ul>
        <li>
          Do not probe, scan, or test the vulnerability of the Service or
          breach any security or authentication measure;
        </li>
        <li>
          Do not access the Service through automated means except through
          documented APIs and within published rate limits;
        </li>
        <li>
          Do not scrape, harvest, or systematically copy content from the
          Service;
        </li>
        <li>
          Do not interfere with or disrupt the Service, our infrastructure, or
          other users&rsquo; use of it;
        </li>
        <li>
          Do not attempt to reverse engineer, decompile, or extract our
          models, prompts, weights, or proprietary algorithms;
        </li>
        <li>
          Do not share API keys, sell account credentials, or use one account
          on behalf of multiple unaffiliated parties to evade plan limits.
        </li>
      </ul>

      <h2 id="ai-misuse">4. AI misuse</h2>
      <ul>
        <li>
          Do not use the Service to generate content that violates the
          Anthropic{" "}
          <a
            href="https://www.anthropic.com/legal/aup"
            target="_blank"
            rel="noopener noreferrer"
          >
            Usage Policies
          </a>{" "}
          for Claude, which apply to inputs and outputs flowing through our AI
          provider;
        </li>
        <li>
          Do not attempt to override safety systems, manipulate Outputs to
          mislead buyers, or use the Service to generate deceptive marketing
          claims about items;
        </li>
        <li>
          Do not represent AI-generated Outputs as the work of a human expert
          or as a formal certification by a regulated body.
        </li>
      </ul>

      <h2 id="marketplace">5. Marketplace and reseller integrity</h2>
      <ul>
        <li>
          Comply with the terms of every marketplace, payment processor, and
          third-party tool you connect through FlipDesk;
        </li>
        <li>
          Do not use FlipDesk to evade marketplace fees, manipulate buyer
          reviews, or violate consumer-protection laws;
        </li>
        <li>
          Accurately represent condition, materials, and authenticity in
          listings drafted through the Service.
        </li>
      </ul>

      {/* US-1757/US-1885: the extension popup's consent clickwrap says "I am
          responsible for each marketplace's Terms of Service" and its "Read the
          terms" link points HERE. Until this section existed, that link landed
          on a page that never mentioned the extension, browser automation, or
          cross-posting — a consent gate whose terms did not describe the thing
          being consented to. */}
      <h2 id="extension">6. The browser extension and assisted cross-posting</h2>
      <p>
        The GradeThread extension fills marketplace listing forms in{" "}
        <strong>your own logged-in browser session</strong>. It does not act on
        your accounts from our servers, and we never receive your marketplace
        passwords or cookies. Because the actions happen as you, you remain the
        party responsible for them.
      </p>
      <ul>
        <li>
          <strong>Each marketplace&rsquo;s own rules still apply.</strong> Some
          marketplaces restrict or prohibit automated or assisted listing. It is
          your responsibility to know the rules of every marketplace you use and
          to stop using the extension there if it is not permitted.
        </li>
        <li>
          <strong>Review before you publish.</strong> The extension prefills a
          draft; it does not decide that a listing is accurate. You are
          responsible for the final content, including condition, measurements,
          authenticity and price.
        </li>
        <li>
          <strong>Do not use it to evade a marketplace&rsquo;s limits.</strong>{" "}
          That includes circumventing listing caps, rate limits, suspensions, or
          bans, and operating accounts you are not authorised to operate.
        </li>
        <li>
          <strong>One person, your own accounts.</strong> Do not use the
          extension to operate accounts on behalf of others in a way those
          marketplaces prohibit, or to run bulk activity that would breach their
          terms.
        </li>
      </ul>
      <p>
        Consequences of a marketplace enforcing its own rules against your
        account &mdash; including suspension &mdash; sit with you, not with
        GradeThread. If a marketplace tells you not to use assisted listing,
        that instruction takes precedence over anything the extension makes
        possible. Data handling for the extension is described in Section 6 of
        our <Link to="/privacy">Privacy Policy</Link>.
      </p>

      <h2 id="reporting">7. Reporting abuse</h2>
      <p>
        To report a violation of this AUP, a suspected counterfeit certificate,
        copyright infringement, or any other abuse, email{" "}
        <a href="mailto:abuse@gradethread.com">abuse@gradethread.com</a>.
        Include the certificate ID, URL, or account in question and a
        description of the issue. For copyright/DMCA notices and our full
        takedown process, see our{" "}
        <Link to="/dmca">Copyright &amp; Content Takedown (DMCA)</Link> page.
      </p>

      <h2 id="enforcement">8. Enforcement</h2>
      <p>
        We may investigate suspected violations and take any action we
        consider appropriate, including removing content, revoking
        certificates, suspending API keys, terminating accounts, or
        cooperating with law enforcement. We may also publish or report on
        aggregate enforcement activity. Decisions are made at our reasonable
        discretion.
      </p>

      <h2 id="changes">9. Changes</h2>
      <p>
        We may update this AUP from time to time. The &ldquo;Effective
        date&rdquo; above will reflect the latest version.
      </p>
    </LegalLayout>
  );
}
