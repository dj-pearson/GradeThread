import { Link } from "react-router";
import { LegalLayout } from "@/components/legal/legal-layout";

export function TermsPage() {
  return (
    <LegalLayout
      title="Terms of Service"
      description="The terms that govern your use of GradeThread and FlipDesk."
      canonicalPath="/terms"
      effectiveDate="August 19, 2026"
    >
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) form a binding agreement
        between you and Pearson Media LLC (&ldquo;Pearson Media,&rdquo;
        &ldquo;GradeThread,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or
        &ldquo;our&rdquo;) governing your access to and use of the
        GradeThread website at{" "}
        <a href="https://gradethread.com">gradethread.com</a>, the FlipDesk
        reseller workspace, our APIs, and any related software or services
        (collectively, the &ldquo;Service&rdquo;).
      </p>
      <p>
        By creating an account, clicking &ldquo;I agree,&rdquo; or otherwise
        using the Service, you accept these Terms, our{" "}
        <Link to="/privacy">Privacy Policy</Link>,{" "}
        <Link to="/cookies">Cookie Policy</Link>, and{" "}
        <Link to="/acceptable-use">Acceptable Use Policy</Link>. If you do not
        agree, do not use the Service.
      </p>

      <h2 id="eligibility">1. Eligibility and accounts</h2>
      <p>
        You must be at least 18 years old (or the age of majority in your
        jurisdiction) and able to form a binding contract to use the Service.
        The Service is not directed to children, and we do not knowingly
        collect personal data from anyone under 18. If you believe a minor has
        provided us personal data, contact{" "}
        <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a>{" "}
        and we will delete it. When you create an account you confirm that you
        meet this age requirement. If you use the Service on behalf of a
        business, you represent that you have authority to bind that business to
        these Terms.
      </p>
      <p>
        You are responsible for the accuracy of the information you provide,
        for safeguarding your credentials, and for all activity that occurs
        under your account. Notify us immediately at{" "}
        <a href="mailto:security@gradethread.com">security@gradethread.com</a>{" "}
        if you suspect unauthorized access.
      </p>

      <h2 id="service">2. The Service</h2>
      <p>
        GradeThread provides AI-assisted condition grading for pre-owned
        clothing, shareable grade certificates, and a reseller workflow
        (FlipDesk) that helps you source, catalog, photograph, list, sell, and
        reconcile inventory across marketplaces. Features available to you
        depend on the plan you select.
      </p>

      <h2 id="plans-and-billing">3. Plans, billing, and refunds</h2>
      <ul>
        <li>
          <strong>Plans.</strong> Current plans, prices, and included
          allotments are described on our pricing page and may change with
          notice for future billing periods.
        </li>
        <li>
          <strong>Subscriptions.</strong> Paid subscriptions are billed in
          advance through Stripe on a recurring monthly or annual basis and
          renew automatically until cancelled.
        </li>
        <li>
          <strong>Cancellation.</strong> You may cancel your subscription at
          any time from{" "}
          <Link to="/dashboard/account?tab=billing">Billing</Link>. Cancellation takes
          effect at the end of the current billing period.
        </li>
        <li>
          <strong>Refunds.</strong> Subscription fees are non-refundable except
          where required by law or expressly stated by us. Unused grading
          credits do not roll over and are not refundable.
        </li>
        <li>
          <strong>Taxes.</strong> Stated prices exclude taxes unless otherwise
          noted. You are responsible for applicable sales, use, VAT, GST, and
          other taxes.
        </li>
        <li>
          <strong>Failed payments.</strong> If a charge fails, we may suspend
          paid features until the balance is resolved.
        </li>
        <li>
          <strong>Free plan and trials.</strong> Free or trial access may be
          limited, modified, or terminated at our discretion.
        </li>
      </ul>

      <h2 id="user-content">4. Your content and licenses</h2>
      <p>
        &ldquo;Your Content&rdquo; means the photos, descriptions, listings,
        notes, measurements, sourcing data, and other materials you submit to
        the Service. You retain all ownership rights in Your Content.
      </p>
      <p>
        You grant Pearson Media a worldwide, non-exclusive, royalty-free
        license to host, store, reproduce, transmit, display, adapt, and
        process Your Content as needed to (a) provide and improve the
        Service, (b) generate grade reports, certificates, and listing
        drafts, (c) display certificates you have made publicly available,
        and (d) use de-identified or aggregated derivatives to evaluate model
        quality and improve our products.
      </p>
      {/* US-3038. Deliberately its own clause and deliberately narrow.
          Clause (d) permits INTERNAL use of aggregated derivatives; publishing
          one is a different act, and stretching (d) to cover it would be the
          kind of reading that makes a licence mean whatever is convenient
          later. Measurements only, aggregate only, floor stated, opt-out
          stated. Do not broaden this to "Your Content" — the whole point is
          that it reaches one field and stops. */}
      <p>
        <strong>Garment measurements.</strong> You additionally grant us a
        license to publish <em>aggregate</em> garment measurements derived from
        Your Content &mdash; that is, statistics such as a median and a range
        computed across many sellers&rsquo; garments of the same brand, style
        and size. This license covers measurements only. It does not extend to
        your photos, prices, listings, or any material that identifies you, and
        an aggregate is published only where at least five garments from at
        least three different sellers support it. Measurement sharing is on by
        default and you can turn it off at any time in Settings, which also
        deletes the measurements you have already contributed. See{" "}
        <Link to="/privacy">Privacy Policy</Link> Section 9.
      </p>
      <p>
        You represent and warrant that you own or have the necessary rights to
        Your Content, that it does not infringe any third-party rights, and
        that it accurately depicts the item being graded.
      </p>

      <h2 id="ai">5. AI-generated outputs</h2>
      <p>
        Grade scores, factor breakdowns, written summaries, certificate
        language, listing titles, descriptions, item specifics, price
        recommendations, and other AI-generated outputs (&ldquo;Outputs&rdquo;)
        are produced by automated systems based on the inputs you provide.
      </p>
      <ul>
        <li>
          Outputs are advisory. They are <strong>not</strong> appraisals,
          authentications, certifications of authenticity, or financial
          advice.
        </li>
        <li>
          We do not guarantee that Outputs are accurate, complete, or suitable
          for any particular purpose. You are responsible for reviewing
          Outputs before relying on or publishing them.
        </li>
        <li>
          Outputs may be similar or identical for similar inputs and may be
          generated for other users. We do not claim copyright in Outputs and,
          to the extent we have any rights, we assign them to you, subject to
          the licenses you grant us in Section 4.
        </li>
        <li>
          You are solely responsible for your use of Outputs, including in
          marketplace listings, advertising, customer communications, and any
          downstream representations to buyers.
        </li>
      </ul>

      <h2 id="grading-disclaimers">6. Grading and certificate disclaimers</h2>
      <ul>
        <li>
          Grades reflect a probabilistic assessment of garment condition based
          on the photos and metadata supplied. They are not a guarantee of
          condition, value, authenticity, or marketability.
        </li>
        <li>
          A certificate confirms that GradeThread issued a grade for the
          identified item at a point in time. It does not warrant the item or
          the actions of any seller or buyer.
        </li>
        <li>
          You may not represent a grade or certificate as an appraisal,
          authentication, or endorsement of any party.
        </li>
        <li>
          We may withdraw, correct, or annotate a grade if we discover
          material errors, fraud, manipulation, or a successful dispute.
        </li>
      </ul>

      <h2 id="api">7. API access</h2>
      <p>
        Eligible plans include access to the GradeThread API. Your use of the
        API is subject to these Terms, our{" "}
        <Link to="/acceptable-use">Acceptable Use Policy</Link>, and any
        documented rate limits or technical requirements. You must:
      </p>
      <ul>
        <li>Keep API keys confidential and rotate them if compromised;</li>
        <li>Not exceed published rate limits or otherwise burden the Service;</li>
        <li>Not resell raw API access or wrap the API in a competing grading service;</li>
        <li>Comply with any additional terms posted in API documentation.</li>
      </ul>
      <p>
        We may suspend or revoke API access for violation of these Terms,
        suspected abuse, or security risk.
      </p>

      {/* US-9127 AC4, the Terms half. The Privacy Policy says where connector
          data goes; this says who is answerable for what it does. The two facts
          a seller needs from a contract rather than a privacy notice: an action
          Claude takes is the seller's own action, and a confirmation prompt is
          a safeguard rather than a review of whether the action is wise. */}
      <h2 id="claude-connector">8. The Claude connector</h2>
      <p>
        On eligible plans you may connect your own Claude account to
        GradeThread, so that Claude can read your workspace and act in it on
        your instruction. Connecting is optional. You choose what to grant when
        you approve the connection, and you may revoke it at any time from
        Settings &rarr; API keys.
      </p>
      <ul>
        <li>
          <strong>Actions taken through the connector are your actions.</strong>{" "}
          A listing published, a price changed, or an item ended through Claude
          is treated exactly as if you had done it yourself in FlipDesk. It is
          subject to these Terms, our{" "}
          <Link to="/acceptable-use">Acceptable Use Policy</Link>, and the terms
          of any marketplace it reaches.
        </li>
        <li>
          <strong>Claude is not our agent, and we are not yours.</strong> Your
          Claude subscription is an agreement between you and Anthropic. We do
          not control what the model asks us to do, and we do not review your
          conversation. Anything the model produces is an Output under Section
          5, including the parts of it you never see.
        </li>
        <li>
          <strong>
            Confirmation prompts are a safeguard, not a review.
          </strong>{" "}
          Anything that spends money or reaches a marketplace asks you to
          confirm the exact change first, and we refuse some requests outright
          when the numbers look like a mistake. Neither is a judgment about
          whether the action is right for your business. Read what you confirm.
        </li>
        <li>
          <strong>Connector actions are metered and capped.</strong> Your plan
          states a monthly allowance of connector actions, and we additionally
          apply hourly and daily ceilings to publishing, repricing, ending
          listings and grading. We may change any of these on notice under
          Section 19.
        </li>
        <li>
          <strong>We may suspend or revoke it.</strong> We may withdraw
          connector access for violation of these Terms, suspected abuse, or
          security risk, on the same basis as API access under Section 7.
        </li>
      </ul>
      <p>
        What the connector sends to Anthropic, what it does not send, and how
        long each call is retained are described in Section 5 of our{" "}
        <Link to="/privacy">Privacy Policy</Link>.
      </p>

      <h2 id="marketplaces">9. Marketplace and third-party integrations</h2>
      <p>
        FlipDesk lets you connect third-party services such as eBay, Poshmark,
        and Mercari. Your use of those services remains governed by their own
        terms. We are not responsible for the availability, accuracy, or
        actions of any third-party service, and revocation of access by a
        third party may impair related FlipDesk features.
      </p>

      <h2 id="acceptable-use">10. Acceptable use</h2>
      <p>
        You agree to comply with our{" "}
        <Link to="/acceptable-use">Acceptable Use Policy</Link>, which
        prohibits, among other things, fraudulent grading, knowingly grading
        counterfeit goods, scraping, abuse of the API, and any unlawful or
        infringing activity.
      </p>

      <h2 id="ip">11. Our intellectual property</h2>
      <p>
        The Service, including the GradeThread and FlipDesk brands, logos,
        designs, software, models, prompts, evaluation rubrics, and
        documentation, is owned by Pearson Media or its licensors and is
        protected by intellectual property laws. We grant you a limited,
        non-exclusive, non-transferable, revocable license to access and use
        the Service in accordance with these Terms. No other rights are
        granted.
      </p>
      <p>
        You may not (a) copy, modify, or create derivative works of the
        Service, (b) reverse engineer or attempt to extract source code,
        models, or weights, (c) remove proprietary notices, or (d) use the
        Service to build a competing product.
      </p>

      <h2 id="feedback">12. Feedback</h2>
      <p>
        If you send us suggestions or feedback, you grant us a perpetual,
        irrevocable, royalty-free license to use it without restriction or
        compensation.
      </p>

      <h2 id="copyright">13. Copyright complaints</h2>
      <p>
        We respond to notices of alleged copyright infringement under the
        Digital Millennium Copyright Act (DMCA). Send takedown notices and
        counter-notices to{" "}
        <a href="mailto:dmca@gradethread.com">dmca@gradethread.com</a>. We may
        suspend or terminate the accounts of repeat infringers.
      </p>

      <h2 id="termination">14. Suspension and termination</h2>
      <p>
        We may suspend or terminate your access to the Service at any time, with
        or without notice, if you violate these Terms, create risk or legal
        exposure for us, or use the Service in a way we reasonably believe is
        harmful. You may terminate at any time by deleting your account. On
        termination, your right to use the Service ends, and we may delete
        Your Content after a reasonable period in accordance with our{" "}
        <Link to="/privacy">Privacy Policy</Link>.
      </p>

      <h2 id="warranties">15. Disclaimer of warranties</h2>
      <p>
        THE SERVICE AND ALL OUTPUTS ARE PROVIDED &ldquo;AS IS&rdquo; AND
        &ldquo;AS AVAILABLE,&rdquo; WITHOUT WARRANTIES OF ANY KIND, WHETHER
        EXPRESS, IMPLIED, OR STATUTORY, INCLUDING WARRANTIES OF
        MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE,
        NON-INFRINGEMENT, ACCURACY, AND UNINTERRUPTED OR ERROR-FREE OPERATION.
        WE DO NOT WARRANT THAT GRADES, CERTIFICATES, OR LISTING CONTENT WILL
        MEET YOUR REQUIREMENTS OR PRODUCE ANY PARTICULAR FINANCIAL OUTCOME.
      </p>

      <h2 id="liability">16. Limitation of liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, PEARSON MEDIA AND ITS
        AFFILIATES, OFFICERS, EMPLOYEES, AGENTS, AND LICENSORS WILL NOT BE
        LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY,
        OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS, REVENUE, GOODWILL, DATA,
        OR BUSINESS, ARISING OUT OF OR RELATED TO THE SERVICE, EVEN IF WE HAVE
        BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
      </p>
      <p>
        OUR TOTAL CUMULATIVE LIABILITY ARISING OUT OF OR RELATED TO THESE
        TERMS OR THE SERVICE WILL NOT EXCEED THE GREATER OF (A) THE AMOUNTS
        YOU PAID US IN THE 12 MONTHS PRECEDING THE EVENT GIVING RISE TO THE
        CLAIM, OR (B) ONE HUNDRED U.S. DOLLARS ($100).
      </p>
      <p>
        Some jurisdictions do not allow certain limitations, so portions of
        this section may not apply to you.
      </p>

      <h2 id="indemnity">17. Indemnification</h2>
      <p>
        You will defend, indemnify, and hold harmless Pearson Media and its
        affiliates from any claims, damages, liabilities, and expenses
        (including reasonable attorneys&rsquo; fees) arising out of (a) Your
        Content, (b) your use of the Service, (c) your violation of these
        Terms or applicable law, or (d) your infringement or misappropriation
        of any third party&rsquo;s rights.
      </p>

      <h2 id="law">18. Governing law and disputes</h2>
      <p>
        These Terms are governed by the laws of the State of Iowa, USA,
        without regard to its conflict-of-laws principles. Subject to the
        arbitration provision below, you and Pearson Media agree to the
        exclusive jurisdiction of the state and federal courts located in
        Polk County, Iowa for any dispute not subject to arbitration.
      </p>
      <p>
        <strong>Arbitration and class waiver.</strong> Any dispute arising out
        of or relating to these Terms or the Service will be resolved by final,
        binding arbitration administered by the American Arbitration
        Association under its Consumer Arbitration Rules, on an individual
        basis. You and Pearson Media waive any right to a jury trial and to
        participate in a class, collective, or representative action. You may
        opt out of arbitration by sending written notice to{" "}
        <a href="mailto:legal@gradethread.com">legal@gradethread.com</a>{" "}
        within 30 days of first accepting these Terms.
      </p>

      <h2 id="changes">19. Changes to the Service or these Terms</h2>
      <p>
        We may modify the Service or these Terms at any time. If we make
        material changes to the Terms, we will provide notice (for example, by
        email or in-product banner) and update the &ldquo;Effective date&rdquo;
        above. Your continued use of the Service after the change becomes
        effective constitutes acceptance of the updated Terms.
      </p>

      <h2 id="misc">20. Miscellaneous</h2>
      <ul>
        <li>
          <strong>Entire agreement.</strong> These Terms, together with the
          Privacy Policy, Cookie Policy, and Acceptable Use Policy, are the
          entire agreement between you and Pearson Media regarding the
          Service.
        </li>
        <li>
          <strong>Severability.</strong> If any provision is held
          unenforceable, the remaining provisions remain in effect.
        </li>
        <li>
          <strong>Assignment.</strong> You may not assign these Terms without
          our consent. We may assign them to an affiliate or in connection
          with a corporate transaction.
        </li>
        <li>
          <strong>No waiver.</strong> Our failure to enforce a provision is
          not a waiver of our right to do so later.
        </li>
        <li>
          <strong>Force majeure.</strong> We are not liable for delay or
          failure caused by events beyond our reasonable control.
        </li>
        <li>
          <strong>Contact.</strong> Questions about these Terms? Email{" "}
          <a href="mailto:legal@gradethread.com">legal@gradethread.com</a>.
        </li>
      </ul>
    </LegalLayout>
  );
}
