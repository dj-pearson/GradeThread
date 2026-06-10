// Plan-downgrade user communication (US-776).
//
// When the Stripe webhook fails closed to Free (an unmappable price, or a
// past-due cap drop), the demotion is correct but used to be SILENT — the
// customer lost paid benefits with no email and no in-app notice. This sends
// BOTH: an in-app billing notification AND a durable transactional email (the
// email self-enqueues to the retry outbox on a transient SMTP failure via its
// category, so it's not fire-and-forget). Deps are injectable so the orchestration
// is unit-testable without a DB or SMTP.

import { notifyUser, type NotifyInput } from "./notify.ts";
import { sendPlanDowngradedEmail } from "./email.ts";

export interface PlanDowngradeNotifyDeps {
  notify: (userId: string, input: NotifyInput) => Promise<void>;
  sendEmail: (to: string, data: { userName: string; fromPlan: string }) => Promise<boolean>;
}

const defaultDeps: PlanDowngradeNotifyDeps = {
  notify: notifyUser,
  sendEmail: (to, data) => sendPlanDowngradedEmail(to, data),
};

export interface PlanDowngradeArgs {
  userId: string;
  email: string | null;
  userName: string;
  /** The paid plan the user was demoted from (label, e.g. "Pro"). */
  fromPlan: string;
}

// Notify a user that their plan was demoted to Free. Never throws — both legs
// are best-effort (the in-app insert swallows errors; the email persists to the
// outbox on failure). Returns nothing; callers fire-and-forget.
export async function notifyPlanDowngrade(
  args: PlanDowngradeArgs,
  deps: PlanDowngradeNotifyDeps = defaultDeps,
): Promise<void> {
  await deps.notify(args.userId, {
    type: "billing",
    title: "Your plan changed to Free",
    message:
      `We hit a problem applying your ${args.fromPlan} subscription, so your account ` +
      `is on Free for now and your paid benefits are paused. Review your billing to restore it.`,
    link: "/dashboard/billing",
  });

  if (args.email) {
    await deps.sendEmail(args.email, { userName: args.userName, fromPlan: args.fromPlan });
  }
}
