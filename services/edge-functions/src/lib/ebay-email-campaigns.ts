// US-2953: the seller's own eBay followers.
//
// A seller with an eBay Store has an audience they already own and pay nothing
// to reach, and FlipDesk could not send to it. Every other channel in the
// product costs money per impression; this one costs nothing and converts
// better, because the recipients chose to follow this shop.
//
// ── A SEND IS ALWAYS A HUMAN ACTION ─────────────────────────────────────────
//
// No automation rule can reach this module, and there is no scheduled sender.
// The reason is not caution about eBay: it is that a mailing list is the one
// asset here that a mistake destroys permanently. A rule that emails followers
// weekly because a threshold drifted does not produce a bad campaign, it
// produces unfollows, and those do not come back.
//
// ── STORE-ONLY, DETECTED RATHER THAN ASSUMED ────────────────────────────────
//
// eBay gates this on a Store subscription. `isStoreRequiredError` reads that
// off the response instead of guessing from the account, so a seller who
// subscribes tomorrow sees the feature appear without a code change.
//
// Auth and transport are ebay-marketing's marketingFetch.
//
// TENANT SCOPING: every function takes a userId and runs under that seller's
// own token (US-268).

import { marketingFetch } from "./ebay-marketing.ts";

export interface EmailCampaign {
  campaignId: string;
  name: string | null;
  status: string | null;
  /** When it went out, or is due to. Null for a draft. */
  scheduledAt: string | null;
  recipientCount: number | null;
  opens: number | null;
  clicks: number | null;
}

interface RawEmailCampaign {
  campaignId?: string;
  emailCampaignId?: string;
  campaignName?: string;
  name?: string;
  campaignStatus?: string;
  status?: string;
  scheduledDate?: string;
  audienceSize?: number | string;
  openCount?: number | string;
  clickCount?: number | string;
}

function num(v: number | string | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Flatten eBay's campaign shape. Pure — unit-tested. */
export function normalizeEmailCampaign(raw: RawEmailCampaign): EmailCampaign {
  return {
    campaignId: raw.campaignId ?? raw.emailCampaignId ?? "",
    name: raw.campaignName ?? raw.name ?? null,
    status: raw.campaignStatus ?? raw.status ?? null,
    scheduledAt: raw.scheduledDate ?? null,
    recipientCount: num(raw.audienceSize),
    opens: num(raw.openCount),
    clicks: num(raw.clickCount),
  };
}

/**
 * Does this error mean "you need an eBay Store"?
 *
 * Read off the response rather than inferred from the account, so a seller who
 * subscribes tomorrow gets the feature without a code change — and so a
 * seller who HAS a Store never sees a "you need a Store" message because we
 * guessed wrong about their subscription.
 */
export function isStoreRequiredError(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  if (e?.status === 403) return true;
  return /store\s+subscription|requires?\s+an?\s+ebay\s+store|not\s+a\s+store\s+seller/i.test(
    e?.message ?? "",
  );
}

export async function listEmailCampaigns(userId: string): Promise<EmailCampaign[]> {
  const { body } = await marketingFetch<{
    emailCampaigns?: RawEmailCampaign[];
    campaigns?: RawEmailCampaign[];
  }>(userId, "/sell/marketing/v1/email_campaign?limit=100");
  const rows = body.emailCampaigns ?? body.campaigns ?? [];
  return rows.map(normalizeEmailCampaign).filter((c) => c.campaignId);
}

export interface CreateEmailCampaignInput {
  name: string;
  subject: string;
  /** eBay listing ids to feature. */
  listingIds: string[];
}

/** Create a DRAFT. Sending is a separate, explicit call. */
export async function createEmailCampaign(
  userId: string,
  input: CreateEmailCampaignInput,
): Promise<string | null> {
  const { body, location } = await marketingFetch<{ campaignId?: string }>(
    userId,
    "/sell/marketing/v1/email_campaign",
    {
      method: "POST",
      body: JSON.stringify({
        campaignName: input.name.slice(0, 90),
        subject: input.subject.slice(0, 120),
        listingIds: input.listingIds,
      }),
    },
  );
  if (body.campaignId) return body.campaignId;
  if (!location) return null;
  const parts = location.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

/** Send one. Called only from a route behind an explicit confirm. */
export async function sendEmailCampaign(
  userId: string,
  campaignId: string,
): Promise<void> {
  await marketingFetch<unknown>(
    userId,
    `/sell/marketing/v1/email_campaign/${encodeURIComponent(campaignId)}/send`,
    { method: "POST" },
  );
}

/** Opens and clicks for one campaign, after it has gone out. */
export async function emailCampaignReport(
  userId: string,
  campaignId: string,
): Promise<{ opens: number | null; clicks: number | null; recipients: number | null }> {
  const { body } = await marketingFetch<{
    openCount?: number | string;
    clickCount?: number | string;
    audienceSize?: number | string;
  }>(
    userId,
    `/sell/marketing/v1/email_campaign/${encodeURIComponent(campaignId)}/report`,
  );
  return {
    opens: num(body.openCount),
    clicks: num(body.clickCount),
    recipients: num(body.audienceSize),
  };
}
