import { Link } from "react-router";
import { LegalLayout } from "@/components/legal/legal-layout";

export function PrivacyPage() {
  return (
    <LegalLayout
      title="Privacy Policy"
      description="How GradeThread collects, uses, and protects your information."
      canonicalPath="/privacy"
      effectiveDate="August 19, 2026"
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
          <strong>Buyer feature usage.</strong> When you use a buyer feature
          &mdash; an extension condition check, a condition alert, a grade
          confirmation, a guarantee claim, an authenticity or video-grade credit
          &mdash; we record that the feature ran, its outcome, and your buyer
          plan. Browser-side events only run if you accept analytics cookies.
          Server-side records of actions you take in your account (for example
          spending a credit) are kept on our legitimate interest in measuring and
          operating the Service; they do not include the item, listing, price, or
          photos involved.
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
        <li>
          <strong>Device location, only if you turn on Thrift Radar.</strong>{" "}
          Contributing to Thrift Radar is off unless you switch it on. While it
          is on, a Prospect scan sends your position once so we can work out
          which coarse area cell you are in; we keep the cell and discard the
          position. Nothing here applies while the switch is off. See{" "}
          <a href="#radar">Section 8</a>.
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

      {/* US-1846: the buyer platform stores a class of data the seller-shaped
          sections above never described — a person's body measurements, what
          they own, and what they are shopping for. Every table listed here is
          enumerated in services/edge-functions/src/lib/buyer-pii.ts, which is
          also what GET /api/account/export iterates, so this section and the
          export cannot describe different sets of data. */}
      <h3 id="buyer-data">2.4 Buyer features</h3>
      <p>
        If you use the buyer side of GradeThread — condition alerts, your
        closet, fit predictions, the Purchase Guarantee — we hold the following
        about you. All of it is private to your account by default, protected by
        row-level security so no other user can read it, and included in the
        data export described under <a href="#your-rights">Your rights</a>.
      </p>
      <ul>
        <li>
          <strong>Body measurements.</strong> The measurements and fit
          preferences you enter for fit predictions. We treat these as
          sensitive: they are never shown on a certificate, never shared with
          sellers, and never part of a public profile.
        </li>
        <li>
          <strong>Listings you asked us to check.</strong> When you use the
          extension&rsquo;s &ldquo;check this against my alerts&rdquo; action,
          we store that one listing (its address, title, brand, stated
          condition, price, one photo link) together with our grade, so your
          alerts can match against it. This is a record of what you were
          shopping for, so we treat it as sensitive: it is private to you, you
          can delete any of it at any time, and we delete it automatically after
          90 days.
        </li>
        <li>
          <strong>Your closet and purchases.</strong> Items you add to your
          closet, purchases you link to a certificate, what you paid, arrival
          photos, our value estimates, and any guarantee coverage or claims on
          them.
        </li>
        <li>
          <strong>Shopping preferences and alerts.</strong> Brands, categories,
          sizes, price range, condition floor, alert cadence and quiet hours,
          your saved searches, watchlist, and want list.
        </li>
        <li>
          <strong>Reputation.</strong> Your Trust Score and level, the grade
          confirmations behind it, your reward-credit balance and ledger, and
          how much of each monthly allowance you have used.
        </li>
        <li>
          <strong>Public buyer profile (off by default).</strong> Nothing about
          you is published unless you turn on a public Trust Score profile,
          choose a handle, and pick which individual stats appear on it. You can
          make it private again at any time.
        </li>
      </ul>
      <p>
        Grade confirmations you submit after an item arrives are also a
        measurement of our own grading accuracy and of the seller&rsquo;s
        record. When you delete your account, those measurements are
        de-identified — your link to them is removed — rather than destroyed;
        everything else listed above is deleted outright.
      </p>

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
        <a href="#retention">Section 11</a> (or earlier on request); deleted
        photos drop out of QA samples because reviewers always read the live
        stored photo, never a copy.
      </p>

      {/* US-9127 AC4: a NEW data flow, and materially different from section 4.
          There we are the controller sending photos to our subprocessor. Here
          the seller holds the relationship with Anthropic and we answer their
          client's requests, so the retention terms are Anthropic's rather than
          ours. Stated before launch rather than after, because it is a change
          in where a seller's data goes. */}
      <h2 id="claude-connector">5. The Claude connector</h2>
      <p>
        If you connect GradeThread to Claude, you are linking{" "}
        <strong>your own Claude account</strong> to your GradeThread account.
        That is a different arrangement from the AI grading described above, and
        the difference matters for where your data goes.
      </p>
      <ul>
        <li>
          <strong>What we send.</strong> Only what the tool you asked for
          returns: item titles, brands, sizes, prices, grades, listing details,
          sales figures and the like. It goes to Claude because you asked Claude
          for it.
        </li>
        <li>
          <strong>No photos cross this path.</strong> Every connector tool
          returns text. Your garment images are not sent to Claude by the
          connector, whatever you ask it.
        </li>
        <li>
          <strong>Anthropic is not acting as our subprocessor here.</strong> In
          grading, we send your photos to Anthropic under our contract with
          them. In the connector, the conversation is yours, and what happens to
          it is governed by <em>your</em> agreement with Anthropic rather than
          ours.
        </li>
        <li>
          <strong>Anthropic retains connector data under its standard policy.</strong>{" "}
          Anthropic&rsquo;s Model Context Protocol connector is expressly not
          eligible for zero-data-retention arrangements, so the tool definitions
          we publish and the results we return are retained by Anthropic under
          the terms of your Claude plan. We cannot shorten that on your behalf.
        </li>
        <li>
          <strong>We record every call.</strong> Each connector action is written
          to an audit log with the tool, the items it touched, whether it
          succeeded and why it was refused if it was. We keep those for 400 days
          so a disputed action can be reconstructed. The log stores the ids
          acted on and a summary of the request, never image data and never
          credentials.
        </li>
        <li>
          <strong>You choose what it can do, and can revoke it.</strong> The
          approval screen lets you grant read-only access if that is all you
          want. Disconnecting from Settings &rarr; API keys stops it
          immediately, including any access already issued.
        </li>
      </ul>
      <p>
        If you do not connect it, none of the above applies and nothing about
        your account reaches Claude.
      </p>

      <h2 id="certificates">6. Public grade certificates</h2>
      <p>
        Grade certificates are designed to be shareable. When you publish a
        certificate or share its link, the certificate page (including the
        overall score, factor breakdown, garment category, and the photos
        attached to that grade) becomes accessible to anyone with the URL.
        Search engines may also index certificates. You can request the
        removal of a certificate at any time by contacting{" "}
        <a href="mailto:support@gradethread.com">support@gradethread.com</a>.
      </p>

      {/* US-1757 AC1: the Chrome Web Store and Firefox AMO both require the
          submitted privacy policy to disclose what the EXTENSION collects, and
          extension-unified/SUBMISSION.md sends operators to this exact URL.
          Until this section existed, that submission would have pointed at a
          policy silent about the extension. Every claim below is checked
          against the shipped code, not the marketing copy. */}
      <h2 id="extension">7. The GradeThread browser extension</h2>
      <p>
        The extension is optional and separate from your account. Most of it
        works without signing in, and what it sends depends on what you ask it
        to do.
      </p>
      <p>
        <strong>Condition reads.</strong> When you click for a condition read on
        a marketplace listing, the extension sends that listing&rsquo;s public
        photo URLs and basic details (title, brand, price, stated condition) to
        our grading service to produce a score. It reads the page you are
        already looking at; it does not browse on your behalf, and it does not
        run on sites outside the marketplaces it supports. We do not keep the
        result: your recent reads and settings stay on your device.
      </p>
      {/* US-1846: this paragraph is the correction. The one above used to end
          "Results are not stored on our servers" full stop, which stopped being
          true when US-1808 added the ingest endpoint — a signed-in buyer's
          click writes a row keyed to their account and keeps it for 90 days.
          The extension is a store-submitted product whose disclosed policy is
          this page, so a stale sentence here is a failed review, not just an
          inaccuracy. */}
      <p>
        <strong>Checking a listing against your alerts.</strong> This one is
        different, and only happens if you are signed in and press it. It sends
        the same listing details to your GradeThread account, where we grade the
        item and compare it against <em>your</em> saved searches so we can alert
        you. Because the answer belongs to your account, we{" "}
        <strong>do</strong> keep this one: the listing&rsquo;s address, title,
        brand, stated condition, price, one photo link and our grade are stored
        privately against your account. Nobody else can read it, you can delete
        it, and we delete it automatically after 90 days. It is one listing per
        press — the extension has no way to hand us a page of results, and we
        never fetch the listing page itself, only the photos your browser had
        already loaded.
      </p>
      <p>
        <strong>Diagnostics are off by default.</strong> If you turn on
        &ldquo;report when a site&rsquo;s layout breaks the read&rdquo;, the
        extension tells us which marketplace failed and which part of the page
        it could not read, plus the version of its configuration. It does{" "}
        <strong>not</strong> send the listing, the page address, your account,
        or any identifier for you or your installation &mdash; the report cannot
        be tied back to a person or a browsing history, by design rather than by
        promise. You can turn it off again at any time in the
        extension&rsquo;s popup.
      </p>
      <p>
        <strong>Usage counts are off by default, and separate.</strong> If you
        turn on &ldquo;share anonymous usage counts&rdquo; &mdash; a second,
        independent switch, not part of the diagnostics one above &mdash; the
        extension keeps two running totals on your device: how many condition
        reads you asked for, and how many times you clicked a link back to
        gradethread.com. Every few hours it sends those <em>totals</em> and the
        extension&rsquo;s version number, and nothing else. It does{" "}
        <strong>not</strong> send when anything happened, in what order, which
        listing or which page, your account, or any identifier for you or your
        installation. Because only totals leave the device, there is no sequence
        of events for anyone to reconstruct. We use it to tell whether people who
        install the extension go on to use it. Turning the switch off also
        deletes any totals still waiting on your device.
      </p>
      <p>
        <strong>Seller tools.</strong> If you use the cross-posting tools, the
        form filling happens entirely in your own logged-in browser tab. Your
        marketplace passwords and cookies are never sent to GradeThread, and we
        do not read your marketplace accounts. On gradethread.com the extension
        runs a small message relay so our own site can hand it a cross-posting
        request &mdash; it reads no page content and forwards only our own
        messages.
      </p>
      <p>
        <strong>Repeating your own seller actions.</strong> Sellers can turn on a
        separate, opt-in tool that repeats actions you already take yourself
        &mdash; sharing a listing, following an account, sending an offer &mdash;
        as clicks in your own logged-in tab, with a daily limit and randomly
        spaced timing. It is behind its own consent, not the cross-posting one.
        We do not read your closet, your followers, or your buyers, and none of
        those actions run on a GradeThread server. If the site asks for a human
        check, the tool stops and hands the tab back to you. We never answer one.
      </p>
      <p>
        <strong>Queueing work from your phone.</strong> If you ask a phone or
        tablet to list or end a listing, we store an{" "}
        <em>instruction</em> &mdash; which of your items, which marketplace, and
        the country site &mdash; and keep it with that item. Anything your
        desktop has not picked up within 7 days is marked expired and shown to
        you, so nothing sits pending forever. We never store a marketplace
        password, cookie, or session of yours, so the queue is not a way into
        your account.
      </p>
      <p>
        <strong>Signing in.</strong> If you sign in, a short-lived access token
        is stored locally so the extension can apply your plan&rsquo;s limits
        and unlock seller features. The extension does not have the{" "}
        <code>cookies</code> permission.
      </p>

      {/* US-1861: Thrift Radar. This section is the consent, not a summary of
          it — the toggle in Settings and the one on iOS both point here, and a
          reader has to be able to check every claim against what the code does.
          Location is a new kind of data, so it gets its own section rather than
          a line inside "Information we collect": folding it into an existing
          disclosure would change what an earlier consent meant. */}
      <h2 id="radar">8. Thrift Radar and location</h2>
      <p>
        Thrift Radar is a shared map of where secondhand supply turns up, built
        from the scans resellers run in the field. Contributing to it is{" "}
        <strong>off unless you turn it on</strong>, on every device. Until you
        do, no scan of yours carries a location and none is recorded.
      </p>
      {/* US-1866: looking at the map can use a location too, and saying only
          "we ask for no location until you contribute" stopped being true the
          day the map got a "near me" button. A policy claim has no compiler, so
          the second use is stated here rather than left to be discovered. */}
      <p>
        <strong>Looking around you is a separate thing, and it records
        nothing.</strong> If you ask Radar to show what is near you, your
        device works out a rough rectangle a few kilometres across and asks us
        which stores fall inside it. We do not keep that rectangle, it is not a
        contribution, and it never makes you a contributor. You can also use
        Radar without sharing any location at all &mdash; it will show the
        stores you have already linked.
      </p>
      <p>
        <strong>What a contribution contains.</strong> While the switch is on,
        each Prospect scan you run adds one observation: the rough area you
        scanned in, the brand and category we read off the item, the condition
        band we estimated, whether the item looked worth buying, and when. It
        does <strong>not</strong> include your photos, what you paid, or the
        item itself.
      </p>
      <p>
        <strong>The area is deliberately coarse, and your exact position is
        not kept.</strong> Your device sends a position only to work out which
        area cell you are in &mdash; roughly a kilometre across. We store the
        cell and discard the position in the same request. There is no column
        in our database for a precise coordinate, so no trail of where you have
        been can be assembled from Radar data, by us or by anyone who obtained
        it.
      </p>
      <p>
        <strong>Contributions are not labelled with you.</strong> Instead of
        your account, each observation carries a scrambled code derived from it,
        so we can count how many different people scanned a place without
        knowing which people. That code is regenerated every week, so
        contributions from different weeks cannot be strung together into one
        person&rsquo;s history.
      </p>
      <p>
        <strong>Places are only shown once enough different people have been
        there.</strong> Our servers withhold an area entirely until a minimum
        number of separate contributors have scanned it. This is enforced when
        the data is requested, not hidden in the app afterwards &mdash; below
        that threshold there is nothing to show and nothing is sent.
      </p>
      <p>
        <strong>Looking and contributing are separate choices.</strong> Opening
        Radar never enrols you as a contributor, and turning contribution off
        never takes the map away. You can switch contribution off at any time in
        Settings on the web or in the app; sharing stops with the next scan, and
        we do not go back and gather what happened while it was off. Your own
        sourcing history stays yours either way &mdash; it is not part of the
        shared map and is covered by your ordinary rights in{" "}
        <a href="#your-rights">Section 12</a>.
      </p>
      {/* US-1864: the personal layer. Stated here rather than left to the
          sentence above, because it is a SECOND record written from the same
          position, with a different purpose and a different gate — and an
          unstated second use of location is precisely what the separate-consent
          rule exists to prevent. */}
      <p>
        <strong>Your own store history is a separate, private record.</strong>{" "}
        When your device works out an area cell, we also keep a private note for
        you of which store you were at, so &ldquo;My stores&rdquo; can show what
        each place you buy from has actually earned you. That record carries your
        account, is visible only to you, is never part of the shared map, and
        still holds no precise position &mdash; only the store or the area cell.
        It is included in your data export, you can delete it, and it is deleted
        with your account.
      </p>

      {/* US-3038: the Fit & Measurement Index. This section is the consent, not
          a summary of it — the toggle in Settings points here, and every claim
          has to be checkable against what the code does.

          It gets its own section for the same reason Radar does, and one more:
          this is the only sharing on this page that is ON by default. The
          existing aggregate clause in Section 4 permits INTERNAL use of
          de-identified data for model accuracy and benchmarks. Publishing an
          aggregate on a public page is a different thing, and reading it into
          that clause would be exactly the kind of stretch US-2643 was written
          to stop. */}
      <h2 id="measurements">9. Garment measurements and the size guides</h2>
      <p>
        Clothing brands publish <em>body</em> size charts &mdash; the wearer&rsquo;s
        chest, the wearer&rsquo;s waist. Almost nobody publishes what a garment
        actually measures laid flat, which is the number a resale listing is
        written with and the number a buyer asks for. We build that reference
        from the measurements our sellers record.
      </p>
      <p>
        <strong>
          This one is on unless you turn it off, which makes it different from
          everything else on this page.
        </strong>{" "}
        You can switch it off at any time under Settings &rarr; Preferences
        &rarr; Measurement sharing.
      </p>
      <p>
        <strong>What is shared.</strong> The measurements themselves, and the
        brand, style and size they belong to. Not your photos, not your prices,
        not your listings, not your name or account.
      </p>
      <p>
        <strong>Nothing is published on the strength of your items alone.</strong>{" "}
        A measurement appears on a public page only once at least five garments
        from at least three different sellers support it. What we publish is the
        middle value across those garments and the range around it, so no single
        measurement can be picked out and none of them can be traced back to
        you. A number that only your inventory supports is a fact about your
        inventory, and we do not publish those.
      </p>
      <p>
        <strong>If you turn it off,</strong> we stop taking new measurements and
        delete the ones you have already contributed. Averages that included
        them are recalculated on the next daily update rather than frozen, so a
        page may still show the previous number for up to a day. If removing
        your measurements leaves fewer than five garments behind a number, that
        number stops being published at all. Deleting your account removes your
        measurements the same way.
      </p>

      <h2 id="sharing">10. How we share information</h2>
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
          host, secure, monitor, and support the Service. This list is
          representative, not exhaustive &mdash; the authoritative, dated list
          is maintained on our <a href="/subprocessors">Subprocessors</a> page.
          They include:
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
              <strong>OpenAI, L.L.C.</strong> &mdash; AI-assisted listing and
              marketing image generation;
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
              <strong>eBay, Inc.</strong> &mdash; marketplace listing, order,
              and payout integration for FlipDesk (only when you connect an
              eBay account);
            </li>
            <li>
              <strong>PostHog, Inc.</strong> &mdash; product analytics;
            </li>
            <li>
              <strong>Functional Software, Inc. (Sentry)</strong> &mdash;
              error monitoring and performance tracing;
            </li>
            <li>
              <strong>Our infrastructure hosting provider</strong> &mdash; the
              VPS/hosting environment where the Service runs (data in transit
              and at rest);
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

      <h2 id="retention">11. Data retention</h2>
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
            <td>Listings you asked the extension to check</td>
            <td>
              Deleted automatically 90 days after the check; you can delete any
              of them sooner.
            </td>
          </tr>
          <tr>
            <td>Work you queued from a phone for your desktop browser</td>
            <td>
              Kept with the item as a record of the job. Anything your desktop
              has not picked up within 7 days is marked expired and shown to
              you; you can delete a queued item yourself at any time.
            </td>
          </tr>
          <tr>
            <td>
              Buyer profile data (measurements, closet, preferences, alerts,
              reputation)
            </td>
            <td>
              Life of the account; deleted when you delete your account or
              remove the individual entry.
            </td>
          </tr>
          <tr>
            <td>Thrift Radar contributions (area cell, brand, condition band)</td>
            <td>
              Up to 180 days, then pruned; only area-level totals remain. They
              carry no precise position and no account, so they are not linked
              to you at any point.
            </td>
          </tr>
          {/* US-3038. Two rows, not one, because the observation and the
              published average have genuinely different lifetimes and saying so
              in a single row would require a sentence that is true of neither. */}
          <tr>
            <td>Garment measurements you contribute (Section 9)</td>
            <td>
              Kept while measurement sharing is on. Turning it off deletes them
              immediately, and so does deleting your account.
            </td>
          </tr>
          <tr>
            <td>The published averages built from those measurements</td>
            <td>
              Kept indefinitely, because they are aggregate figures about a
              garment rather than about you &mdash; they carry no account and no
              single measurement can be recovered from them. They are
              recalculated daily, so an average stops including your
              measurements on the next update after you withdraw them, and stops
              being published at all if fewer than five garments are left behind
              it.
            </td>
          </tr>
          <tr>
            <td>Your own store history (which stores you scanned at)</td>
            <td>
              Life of the account. It is your trading record, so we do not prune
              it on a timer; you can delete it, and it is deleted with your
              account.
            </td>
          </tr>
          {/* US-2643: this row used to read "Server & security logs — Up to 90
              days, then purged or aggregated", and no part of that was true of
              anything we store. Measured, not assumed: not one application audit
              or event table has a time-based sweep, and admin_audit_log is
              append-only ON PURPOSE — a test fails if any RLS policy on it ever
              grants UPDATE or DELETE, because a log that can be deleted is not
              evidence. The old row promised a purge we do not do, of a record we
              deliberately keep. Split in two so each half says what happens. */}
          <tr>
            <td>Infrastructure logs (hosting, CDN, error reporting)</td>
            <td>
              Up to 90 days. These are operational records held by our hosting,
              network and error-reporting providers, and they are aged out on
              those providers&rsquo; schedules rather than ours.
            </td>
          </tr>
          <tr>
            <td>Security audit trail (admin actions, access records)</td>
            <td>
              Kept for the life of the account, then de-identified rather than
              deleted. This record is append-only by design: it exists to show
              who did what to an account, including us, and a log that can be
              erased cannot do that. Each entry records the action, when it
              happened, which account it affected, and the staff member who
              performed it (their email address and network address). It does not
              contain your uploaded photos or the text of your listings. Where a
              staff member sends you a notice, the notice they wrote is recorded
              with it.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Grading-photo deletion is enforced automatically by a scheduled purge
        job; you can also request earlier deletion at any time (see{" "}
        <a href="#your-rights">Your rights</a>).
      </p>

      <h2 id="your-rights">12. Your rights and choices</h2>
      <p>
        Depending on where you live, you may have rights to access, correct,
        delete, restrict, or port your personal information, and to object to
        certain processing. You can exercise these rights by:
      </p>
      <ul>
        <li>
          Editing your profile and submissions directly in{" "}
          <Link to="/dashboard/account?tab=settings">Settings</Link>;
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
        sell personal information. You can exercise the opt-out for
        cross-context behavioral advertising through the &ldquo;Your Privacy
        Choices&rdquo; control in our cookie settings, and we honor Global
        Privacy Control (GPC) browser signals as a valid opt-out request.
      </p>
      <p>
        <strong>Other U.S. state residents.</strong> If you reside in a state
        with a comprehensive consumer privacy law &mdash; including Virginia
        (VCDPA), Colorado (CPA), Connecticut (CTDPA), Utah (UCPA), Texas
        (TDPSA), Oregon, and others as they take effect &mdash; you may have
        rights to access, correct, delete, and obtain a portable copy of your
        personal information, and to opt out of targeted advertising, the
        &ldquo;sale&rdquo; of personal information, and certain profiling. You
        may exercise these rights using the same methods above, and where the
        law permits, you may appeal a decision by contacting{" "}
        <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a>.
        We honor the &ldquo;Your Privacy Choices&rdquo; control and GPC signals
        for residents of these states as well.
      </p>

      <h2 id="security">13. Security</h2>
      <p>
        We use industry-standard administrative, technical, and physical
        safeguards to protect your information &mdash; including encryption in
        transit (TLS), encryption at rest for sensitive fields, row-level
        security in our database, and least-privilege access controls. No
        method of transmission or storage is 100% secure, and we cannot
        guarantee absolute security.
      </p>

      <h2 id="international">14. International transfers</h2>
      <p>
        Pearson Media LLC is based in the United States. If you access the
        Service from outside the U.S., your information will be transferred
        to, stored in, and processed in the U.S. and other countries where our
        subprocessors operate. Where required, we rely on appropriate transfer
        mechanisms such as the Standard Contractual Clauses.
      </p>

      <h2 id="children">15. Children</h2>
      <p>
        The Service is intended for adults. You must be at least 18 years old to
        use it (see our <Link to="/terms">Terms of Service</Link>). The Service
        is not directed to children, and we do not knowingly collect personal
        information from anyone under 18. If you believe a minor has provided us
        information, contact{" "}
        <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a> and
        we will delete it.
      </p>

      <h2 id="changes">16. Changes to this policy</h2>
      <p>
        We may update this Privacy Policy from time to time. When we make
        material changes, we will update the &ldquo;Effective date&rdquo;
        above and, where required, notify you via email or in-product
        notification. Your continued use of the Service after the change
        becomes effective constitutes acceptance of the updated policy.
      </p>

      <h2 id="contact">17. Contact us</h2>
      <p>
        Pearson Media LLC
        <br />
        Attn: Privacy
        <br />
        7888 Beechtree Ln
        <br />
        West Des Moines, IA 50266
        <br />
        United States
        <br />
        <a href="mailto:privacy@gradethread.com">privacy@gradethread.com</a>
      </p>
      <p>
        Our full provider identification is on the{" "}
        <Link to="/imprint">Imprint / Legal Notice</Link> page.
      </p>
    </LegalLayout>
  );
}
