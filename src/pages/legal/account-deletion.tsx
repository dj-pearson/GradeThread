import { Link } from "react-router";
import { LegalLayout } from "@/components/legal/legal-layout";

/**
 * The public account-deletion page (US-2776).
 *
 * Google Play's User Data policy requires a URL that anyone can reach WITHOUT
 * signing in, describing how to delete the account and what happens to the data.
 * The App Store has no equivalent requirement, so this page exists for Play and
 * doubles as the plain-English version of the erasure right the privacy policy
 * states in legal terms.
 *
 * Every claim here is checked against the code that performs the deletion —
 * services/edge-functions/src/routes/account.ts, lib/financial-retention.ts and
 * lib/account-email-purge.ts. The retained categories are named rather than
 * glossed: a page promising an unconditional erase that the endpoint declines to
 * perform is worse than no page.
 */
export function AccountDeletionPage() {
  return (
    <LegalLayout
      title="Delete your account"
      description="How to permanently delete your GradeThread or FlipDesk account and what happens to your data, from the app, the website, or by email."
      canonicalPath="/account-deletion"
      effectiveDate="August 21, 2026"
    >
      <p>
        You can delete your GradeThread account yourself, at any time, from any
        of our apps or from this website. Deletion is permanent. We do not keep a
        hidden copy you can restore from, so export anything you want to keep
        first.
      </p>

      <h2 id="how">1. How to delete your account</h2>

      <h3>In the Android app</h3>
      <p>
        Open <strong>Settings</strong>, scroll to the bottom, and tap{" "}
        <strong>Delete account</strong>. Type <code>DELETE MY ACCOUNT</code> to
        confirm. If you signed up with an email address and password, you will
        also be asked for your password.
      </p>

      <h3>In the iOS app</h3>
      <p>
        Open <strong>Settings</strong> and tap <strong>Delete account</strong>,
        then confirm.
      </p>

      <h3>On the website</h3>
      <p>
        Sign in and go to{" "}
        <Link to="/dashboard/account">Account settings</Link>. The delete option
        is in the danger zone at the bottom of the page, behind the same typed
        confirmation.
      </p>

      <h3>By email</h3>
      <p>
        If you cannot sign in, email{" "}
        <a href="mailto:support@gradethread.com">support@gradethread.com</a> from
        the address on the account. We will verify it is yours and complete the
        deletion within 30 days.
      </p>

      <h2 id="export">2. Export your data first</h2>
      <p>
        Before you delete, you can download everything we hold about you as a
        single JSON file: <strong>Settings → Export my data</strong> in the
        mobile apps, or Account settings on the web. Once the account is gone we
        cannot produce the export.
      </p>

      <h2 id="deleted">3. What is deleted</h2>
      <p>
        Deleting your account removes, immediately and permanently:
      </p>
      <ul>
        <li>Your login, name, email address and profile.</li>
        <li>
          Every photo you uploaded — garment shots, tag and label photos,
          annotated defect images and listing imagery — from all of our storage
          buckets.
        </li>
        <li>
          Your inventory, measurements, condition grades and grade reports,
          listings, sales, expenses, payouts and consignor records.
        </li>
        <li>
          Your marketplace connections and the access tokens we stored for them,
          including eBay. Those tokens are short-lived and our copy is destroyed;
          you can also revoke our access from your eBay account settings at any
          time.
        </li>
        <li>
          Your saved searches, automations, templates, notification tokens and
          workspace memberships.
        </li>
        <li>
          Emails we had queued or sent to your address, and any support or
          feedback messages keyed to it.
        </li>
        <li>Your Stripe customer record, along with any active subscription.</li>
        <li>
          The link between your account and any Garment Passport history, so
          earlier ownership hops no longer resolve to you.
        </li>
      </ul>

      <h2 id="retained">4. What we keep, and why</h2>
      <p>
        Three narrow categories survive deletion. Each is kept because deleting it
        would break a legal obligation or harm you.
      </p>
      <ul>
        <li>
          <strong>Financial records.</strong> Credit-purchase and subscription
          ledger rows are retained for tax, accounting and payment-dispute
          purposes. A card network can raise a chargeback for months after a
          charge, and we have to be able to show what the charge was for.
          Personal details inside those records — the billing address and email
          address in the raw payment-processor payload — are stripped as part of
          the deletion, so what remains is the money, not you.
        </li>
        <li>
          <strong>Email suppression entries.</strong> If your address ever bounced
          or you unsubscribed, the address stays on our do-not-send list.
          Forgetting it would start the mail again, which is the opposite of what
          you asked for. It is stored for that purpose and nothing else.
        </li>
        <li>
          <strong>A deletion record.</strong> We log that an account was deleted
          and when, so we can prove the request was honoured. It does not contain
          your name, email address or content.
        </li>
      </ul>
      <p>
        Backups are a separate matter. Our database backups are encrypted and
        rotate on a fixed schedule, so a deleted account can persist inside a
        backup image until that image ages out. Backups are never used to serve
        the product; they are restored only to recover from an incident, and a
        restore re-applies pending deletions.
      </p>

      <h2 id="subscriptions">5. Subscriptions bought in an app store</h2>
      <p>
        If you subscribed through Google Play or the App Store, deleting your
        GradeThread account does <strong>not</strong> cancel the subscription —
        only the store can do that, because only the store holds the payment
        arrangement.
      </p>
      <ul>
        <li>
          <strong>Google Play:</strong> Play Store → your profile → Payments
          &amp; subscriptions → Subscriptions.
        </li>
        <li>
          <strong>App Store:</strong> Settings → your name → Subscriptions.
        </li>
      </ul>
      <p>
        Cancel there first, then delete the account. Subscriptions bought on our
        website through Stripe are cancelled automatically as part of the
        deletion.
      </p>

      <h2 id="timing">6. How long it takes</h2>
      <p>
        Self-service deletion runs immediately; by the time the confirmation
        appears the account is gone. An emailed request is completed within 30
        days. Occasionally the system will decline to start a deletion — if that
        happens nothing at all is removed, you will be told so plainly, and you
        can try again shortly.
      </p>

      <h2 id="more">7. Related</h2>
      <p>
        Our <Link to="/privacy">Privacy Policy</Link> describes the wider set of
        privacy rights, including access, correction and portability. The{" "}
        <Link to="/refund">Refund &amp; Cancellation Policy</Link> covers what
        happens to money already paid. For anything else, write to{" "}
        <a href="mailto:support@gradethread.com">support@gradethread.com</a>.
      </p>
    </LegalLayout>
  );
}
