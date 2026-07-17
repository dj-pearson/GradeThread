import { supabaseAdmin } from "./supabase.ts";
import {
  dispatchContentWebhook,
  type WebhookPayloadSocial,
} from "./content-webhook.ts";
import type { SocialVariantOutput } from "./content-ai-prompts.ts";
import {
  buildSocialCardUrl,
  deriveCardText,
  IMAGE_FIELD_RATIO,
  normalizeEnabledPlatforms,
  type SocialPlatform,
} from "./social-platforms.ts";

// US-870: persistence + platform-aware publish fan-out for social posts.
//
// A social_posts row is the editorial anchor; the per-platform tailoring lives
// in social_platform_variants. On generate we (re)write those child rows; on
// publish we fan one social.published webhook out per ENABLED platform that has
// a variant — so a Make.com router can dispatch by platform. Posts with no
// variants (legacy, or generated before US-870) fall back to the long/short
// fan-out so nothing silently stops publishing.

export interface SocialVariantRow {
  platform: SocialPlatform;
  body: string;
  hashtags: string[];
  image_field: string | null;
  char_limit: number | null;
}

// Minimal shape needed to fan out — works for both the route's `updated` row
// and the scheduler's `published` row.
export interface SocialPostForPublish {
  id: string;
  cta_url: string | null;
  product_focus: "gradethread" | "flipdesk" | "both";
  long_body: string;
  short_body: string;
  hashtags: string[];
  // US-871: a manually uploaded/overridden card. When absent we auto-fill a
  // branded /og/social/card URL per platform so the payload always has an image.
  asset_image_url?: string | null;
  // Video-distribution: "video" fans out the video_url below to the enabled
  // platforms (TikTok / IG Reels / FB video); anything else stays an image post.
  media_type?: "image" | "video" | null;
  // Publicly fetchable video URL (content-videos bucket) for video posts.
  video_url?: string | null;
}

// Replace the post's variant rows with a freshly generated set. We delete +
// insert (rather than upsert) so platforms dropped from a regeneration don't
// linger as stale variants.
export async function persistSocialVariants(
  postId: string,
  variants: SocialVariantOutput[],
): Promise<void> {
  await supabaseAdmin
    .from("social_platform_variants")
    .delete()
    .eq("social_post_id", postId);
  if (variants.length === 0) return;
  const rows = variants.map((v) => ({
    social_post_id: postId,
    platform: v.platform,
    body: v.body,
    hashtags: v.hashtags,
    image_field: v.image_field,
    char_limit: v.char_limit,
  }));
  const { error } = await supabaseAdmin
    .from("social_platform_variants")
    .insert(rows);
  if (error) {
    console.error("[content-social-publish] variant insert failed:", error.message);
  }
}

export async function loadSocialVariants(
  postId: string,
): Promise<SocialVariantRow[]> {
  const { data } = await supabaseAdmin
    .from("social_platform_variants")
    .select("platform, body, hashtags, image_field, char_limit")
    .eq("social_post_id", postId);
  return (data ?? []) as SocialVariantRow[];
}

async function loadEnabledPlatforms(): Promise<SocialPlatform[]> {
  const { data } = await supabaseAdmin
    .from("content_settings")
    .select("social_platforms")
    .eq("id", 1)
    .maybeSingle();
  return normalizeEnabledPlatforms(data?.social_platforms);
}

// US-871: the public base URL the auto-filled card images point at. Prefers the
// content_settings override, then PUBLIC_SITE_URL, then production.
async function loadPublicSiteUrl(): Promise<string> {
  const { data } = await supabaseAdmin
    .from("content_settings")
    .select("public_site_url")
    .eq("id", 1)
    .maybeSingle();
  const fromDb = (data?.public_site_url as string | undefined)?.trim();
  if (fromDb) return fromDb.replace(/\/$/, "");
  const envUrl = Deno.env.get("PUBLIC_SITE_URL")?.trim();
  return (envUrl ?? "https://gradethread.com").replace(/\/$/, "");
}

// Pure selection logic (unit-tested): given the enabled platforms and the
// variants on a post, return the webhook payloads to fire. Falls back to the
// legacy long/short payloads when the post has no usable platform variants.
export function planSocialFanout(args: {
  post: SocialPostForPublish;
  enabled: SocialPlatform[];
  variants: SocialVariantRow[];
  timestamp: string;
  // Base URL for auto-filled card images. Defaults to production.
  siteUrl?: string;
}): WebhookPayloadSocial[] {
  const { post, enabled, variants, timestamp } = args;
  const siteUrl = args.siteUrl ?? "https://gradethread.com";
  const asset = post.asset_image_url?.trim() || null;
  // Video-distribution: a video post carries a public video_url; the image
  // stays as the cover/poster. When the post isn't a video (or has no url) we
  // omit the video fields entirely so image posts are byte-for-byte unchanged.
  const video = post.media_type === "video" ? (post.video_url?.trim() || null) : null;
  const videoFields = video
    ? { media_type: "video" as const, video_url: video }
    : { media_type: "image" as const };
  const byPlatform = new Map<SocialPlatform, SocialVariantRow>();
  for (const v of variants) {
    if (v.body?.trim()) byPlatform.set(v.platform, v);
  }

  // US-871: resolve the image for a variant — the uploaded asset wins; otherwise
  // an auto-filled branded card in the aspect this platform wants.
  const imageFor = (v: SocialVariantRow): string => {
    if (asset) return asset;
    const ratio = IMAGE_FIELD_RATIO[v.image_field ?? ""] ?? "landscape";
    return buildSocialCardUrl({
      siteUrl,
      ratio,
      kind: "quote",
      text: deriveCardText(v.body),
      product: post.product_focus,
    });
  };

  const platformPayloads = enabled
    .map((platform) => byPlatform.get(platform))
    .filter((v): v is SocialVariantRow => !!v)
    .map((v) => ({
      event: "social.published" as const,
      platform: v.platform,
      timestamp,
      data: {
        id: post.id,
        body: v.body,
        hashtags: v.hashtags ?? [],
        cta_url: post.cta_url ?? null,
        product_focus: post.product_focus,
        image_field: v.image_field ?? null,
        image_url: imageFor(v),
        ...videoFields,
      },
    }));

  if (platformPayloads.length > 0) return platformPayloads;

  // Legacy fallback: no platform variants on this post. Auto-fill a landscape
  // card from whichever body is present so even legacy posts ship with an image.
  const legacyImage = (body: string): string =>
    asset ??
      buildSocialCardUrl({
        siteUrl,
        ratio: "landscape",
        kind: "quote",
        text: deriveCardText(body),
        product: post.product_focus,
      });

  const legacy: WebhookPayloadSocial[] = [];
  if (post.long_body?.trim()) {
    legacy.push({
      event: "social.published",
      format: "long",
      timestamp,
      data: {
        id: post.id,
        body: post.long_body,
        hashtags: post.hashtags ?? [],
        cta_url: post.cta_url ?? null,
        product_focus: post.product_focus,
        image_url: legacyImage(post.long_body),
        ...videoFields,
      },
    });
  }
  if (post.short_body?.trim()) {
    legacy.push({
      event: "social.published",
      format: "short",
      timestamp,
      data: {
        id: post.id,
        body: post.short_body,
        hashtags: post.hashtags ?? [],
        cta_url: post.cta_url ?? null,
        product_focus: post.product_focus,
        image_url: legacyImage(post.short_body),
        ...videoFields,
      },
    });
  }
  return legacy;
}

// Fire the publish fan-out for a post. Best-effort + non-throwing: a webhook
// failure must never roll back a publish (errors are logged to
// content_webhook_log and stay retryable).
export async function fireSocialWebhooks(
  post: SocialPostForPublish,
  timestamp: string,
): Promise<void> {
  const [enabled, variants, siteUrl] = await Promise.all([
    loadEnabledPlatforms(),
    loadSocialVariants(post.id),
    loadPublicSiteUrl(),
  ]);
  const payloads = planSocialFanout({ post, enabled, variants, timestamp, siteUrl });
  await Promise.all(payloads.map((p) => dispatchContentWebhook(p))).catch((e) =>
    console.error("[content-social-publish] fan-out failed:", e)
  );
}
