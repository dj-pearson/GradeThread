import { Link } from "react-router-dom";
import { LegalLayout } from "@/components/legal/legal-layout";

export function RefundPage() {
  return (
    <LegalLayout
      title="Refund & Cancellation Policy"
      description="How subscriptions, per-grade purchases, and credits are billed, cancelled, and refunded on GradeThread and FlipDesk — including EU/UK consumer rights."
      canonicalPath="/refund"
      effectiveDate="July 2, 2026"
    >
      <p>
        This Refund &amp; Cancellation Policy explains how billing, cancellation,
        and refunds work for GradeThread and FlipDesk. It supplements the billing
        terms in our <Link to="/terms">Terms of Service</Link> (Section 3). Where
        this policy and the Terms differ on refunds, this policy controls.
      </p>

      <h2 id="what-you-buy">1. What you can purchase</h2>
      <ul>
        <li>
          <strong>Subscriptions.</strong> FlipDesk plans billed monthly or
          annually in advance through Stripe, renewing automatically until
          cancelled.
        </li>
        <li>
          <strong>Per-grade purchases and credit packs.</strong> One-time
          payments for individual grades or bundles of grading credits.
        </li>
      </ul>

      <h2 id="cancellation">2. Cancelling a subscription</h2>
      <p>
        You can cancel at any time from{" "}
        <Link to="/dashboard/billing">Billing</Link>. Cancellation stops the next
        renewal; your plan stays active until the end of the billing period you
        have already paid for, and you are not charged again after that. We do
        not provide partial refunds for the unused portion of a billing period
        except where required by law or as described below.
      </p>

      <h2 id="refunds">3. Refunds</h2>
      <ul>
        <li>
          <strong>Subscription fees</strong> are non-refundable once a billing
          period has begun, except where required by law or expressly granted by
          us in writing.
        </li>
        <li>
          <strong>Grading credits and per-grade purchases</strong> are
          non-refundable once a grade has been generated, because the AI
          processing is performed and delivered immediately. Unused credits do
          not expire into a cash balance and are not redeemable for cash.
        </li>
        <li>
          <strong>Billing errors.</strong> If you were charged in error,
          double-charged, or charged after a valid cancellation, contact us
          within 60 days and we will investigate and refund any incorrect
          charge.
        </li>
        <li>
          <strong>Discretionary refunds.</strong> We may issue a refund or credit
          at our discretion — for example, for a prolonged service outage that
          prevented you from using paid features.
        </li>
      </ul>

      <h2 id="eu-uk-withdrawal">4. EU/EEA and UK consumers: right of withdrawal</h2>
      <p>
        If you are a consumer in the European Union, the European Economic Area,
        or the United Kingdom, you normally have a 14-day right to withdraw from a
        distance contract for digital services without giving a reason.
      </p>
      <p>
        GradeThread delivers digital content and services (grades, certificates,
        and listing tools) immediately. By purchasing and starting to use a
        grade, credit, or subscription during the withdrawal period, you{" "}
        <strong>expressly request that we begin performance immediately</strong>{" "}
        and acknowledge that:
      </p>
      <ul>
        <li>
          for a <strong>service</strong> (e.g. a subscription), once we have
          fully performed you lose your right of withdrawal, and if you withdraw
          during performance you may owe an amount proportionate to what was
          provided; and
        </li>
        <li>
          for <strong>digital content</strong> supplied on a non-tangible medium
          (e.g. a generated grade or certificate), you lose your right of
          withdrawal once performance has begun with your prior consent and
          acknowledgement.
        </li>
      </ul>
      <p>
        To exercise a right of withdrawal that still applies, email{" "}
        <a href="mailto:billing@gradethread.com">billing@gradethread.com</a>{" "}
        before starting the service. Nothing in this policy limits mandatory
        statutory consumer rights, including remedies for a service that is not
        as described or not of satisfactory quality.
      </p>

      <h2 id="chargebacks">5. Chargebacks</h2>
      <p>
        If you believe a charge is wrong, please contact us first — we can almost
        always resolve it faster than a bank dispute. Filing a chargeback for a
        legitimate, delivered purchase may result in suspension of your account
        pending resolution.
      </p>

      <h2 id="how-to-request">6. How to request a refund</h2>
      <p>
        Email <a href="mailto:billing@gradethread.com">billing@gradethread.com</a>{" "}
        from the address on your account with your order details and the reason
        for the request. Approved refunds are returned to the original payment
        method via Stripe, typically within 5–10 business days.
      </p>
    </LegalLayout>
  );
}
