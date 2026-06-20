// US-920: AI-generated, email-safe imagery for the autonomous newsletter.
//
// Two image strategies, chosen per section type:
//   1. PHOTOGRAPHIC hero — gpt-image-1 (openai-images.ts) renders an editorial
//      photo from the issue's image prompt. Uploaded to the PUBLIC content-images
//      bucket on a stable, issue-scoped path with a 1-year cache header and an
//      ABSOLUTE public URL (signed/private URLs break in email clients).
//   2. BRANDED BANNER CARD — a deterministic Satori card (functions/og/social/card)
//      referenced by absolute URL. No AI, never fails, edge-cached. Used when the
//      photographic hero is disabled OR its generation fails (AC4 graceful degrade).
//
// Every emitted <img> is email-safe (AC3): bounded display width with retina-
// friendly source, explicit width/height, descriptive alt text, and a brand
// background-color so a blocked image still shows a coloured box + the alt copy.
//
// Cost is bounded per issue by the assembler's max-images setting and EACH photo
// generation is logged to the ai_usage_events ledger (feature 'newsletter_image')
// so it surfaces in the AI-spend dashboard and is cappable by an AI budget
// guardrail (AC5). Generated assets are recorded in newsletter_issue_assets,
// linked to the issue id for reuse + cleanup (AC6).

import { supabaseAdmin } from "./supabase.ts";
import { getDefaultImageModel } from "./ai-config.ts";
import { generateHeroImage, uploadHeroImage } from "./openai-images.ts";
import { validateImageUpload } from "./upload-validation.ts";
import { stripImageMetadata } from "./image-metadata.ts";
import { recordAiCall } from "./ai-usage.ts";
import { escapeHtml } from "./newsletter-issue.ts";

const BRAND_NAVY = "#0F3460";
const BRAND_GRAY = "#F5F5F5";

// The newsletter content column is 600px wide with 32px padding each side, so the
// usable display width is 536px. Sources are generated larger (retina-friendly)
// then bounded to this width in the markup so weight stays sensible in-client.
export const EMAIL_IMAGE_DISPLAY_WIDTH = 536;

// gpt-image-1 sizes per orientation. The hero is a 3:2 landscape photo.
const HERO_SIZE = "1536x1024" as const;
const HERO_QUALITY = "medium" as const;

export type IssueImageKind = "hero" | "branded_card";

export interface ResolvedIssueImage {
  kind: IssueImageKind;
  /** Absolute, email-safe public URL. */
  url: string;
  alt: string;
  /** Intrinsic source dimensions (used for the email-safe width/height attrs). */
  width: number;
  height: number;
  /** Ready-to-embed, email-safe <img> markup. */
  html: string;
}

// ── Pure: email-safe markup ──────────────────────────────────────────────────

export interface EmailImageInput {
  url: string;
  alt: string;
  /** Intrinsic source width/height — used to derive a correct display height. */
  width: number;
  height: number;
}

/**
 * Email-safe <img> for a hosted PNG. Bounded to the 600px content column (retina
 * source scaled down), with explicit attributes, a descriptive alt, and a brand
 * background so a client that blocks images shows a coloured box + the alt text
 * rather than a broken icon. Pure.
 */
export function buildEmailImageHtml(input: EmailImageInput): string {
  const ratio = input.height > 0 && input.width > 0 ? input.height / input.width : 0.625;
  const displayW = EMAIL_IMAGE_DISPLAY_WIDTH;
  const displayH = Math.round(displayW * ratio);
  const alt = escapeHtml(input.alt);
  return (
    `<img src="${escapeHtml(input.url)}" alt="${alt}" width="${displayW}" height="${displayH}" ` +
    `style="display:block;width:100%;max-width:${displayW}px;height:auto;border:0;` +
    `border-radius:8px;margin:0 0 24px;background-color:${BRAND_NAVY};color:${BRAND_GRAY};` +
    `font-size:13px;line-height:1.5;text-align:center;" />`
  );
}

// ── Pure: deterministic branded banner card URL (Satori) ─────────────────────

function publicSiteUrl(): string {
  const raw = (Deno.env.get("PUBLIC_SITE_URL") || "").trim();
  const base = raw || "https://gradethread.com";
  return base.replace(/\/+$/, "");
}

export interface BrandedCardInput {
  /** Headline rendered on the card (the issue title). */
  text: string;
  /** Small uppercase label above the headline (the topic/pillar). */
  eyebrow?: string | null;
  product?: "gradethread" | "flipdesk" | "both";
  siteUrl?: string;
}

/**
 * Absolute URL to the deterministic branded social card (Satori, edge-cached).
 * Landscape 1200x630. Pure given an explicit siteUrl; otherwise reads the
 * configured public origin. Used as the always-available fallback banner.
 */
export function brandedCardUrl(input: BrandedCardInput): string {
  const base = (input.siteUrl ?? publicSiteUrl()).replace(/\/+$/, "");
  const q = new URLSearchParams({
    ratio: "landscape",
    kind: "title",
    text: input.text.slice(0, 160),
    product: input.product ?? "gradethread",
  });
  const eyebrow = (input.eyebrow ?? "").trim();
  if (eyebrow) q.set("eyebrow", eyebrow.slice(0, 48));
  return `${base}/og/social/card?${q.toString()}`;
}

/** Branded card intrinsic size (matches SOCIAL_CARD_SIZES.landscape). */
export const BRANDED_CARD_SIZE = { width: 1200, height: 630 } as const;

/** Reconstruct a ResolvedIssueImage from a stored URL (resume/reuse path). The
 * branded-card endpoint is recognised by its path so the correct aspect ratio is
 * used; everything else is treated as a 3:2 photographic hero. Pure. */
export function resolveImageFromUrl(url: string, alt: string): ResolvedIssueImage {
  const isCard = /\/og\/social\/card(\?|$)/.test(url);
  const width = isCard ? BRANDED_CARD_SIZE.width : 1536;
  const height = isCard ? BRANDED_CARD_SIZE.height : 1024;
  return {
    kind: isCard ? "branded_card" : "hero",
    url,
    alt,
    width,
    height,
    html: buildEmailImageHtml({ url, alt, width, height }),
  };
}

// ── Pure: gpt-image-1 cost estimate (faithful token-based) ───────────────────

// Published gpt-image-1 image-token estimates per size + quality. Used to log a
// realistic token count to the spend ledger; the ai_spend / ai_budget RPCs then
// re-price it from system_settings.ai_model_prices['gpt-image-1'] (seeded 00288).
export function estimateImageTokens(size: string, quality: string): number {
  const square = size === "1024x1024";
  const q = quality === "low" ? "low" : quality === "high" ? "high" : "medium";
  if (square) {
    return q === "low" ? 272 : q === "high" ? 4160 : 1056;
  }
  // 1024x1536 / 1536x1024 (the larger 3:2 / 2:3 frames).
  return q === "low" ? 408 : q === "high" ? 6240 : 1584;
}

// ── Impure: spend ledger + asset registry ────────────────────────────────────

async function recordImageSpend(model: string, size: string, quality: string, latencyMs: number | null): Promise<void> {
  // gpt-image-1 bills image-output tokens; log them as output_tokens so the
  // dashboard/budget re-pricing reflects real cost (feature 'newsletter_image').
  await recordAiCall({
    feature: "newsletter_image",
    userId: null,
    usage: {
      model,
      inputTokens: 0,
      outputTokens: estimateImageTokens(size, quality),
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    latencyMs,
    promptHash: null,
  });
}

export interface RegisterAssetInput {
  issueId: string;
  kind: IssueImageKind;
  url: string;
  path: string | null;
  alt: string;
  prompt: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  model: string | null;
}

/** Record a generated/selected asset against the issue (reuse + cleanup, AC6).
 * Best-effort — a tracking-write failure must never block the issue build. */
async function registerIssueAsset(input: RegisterAssetInput): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("newsletter_issue_assets").insert({
      issue_id: input.issueId,
      kind: input.kind,
      url: input.url,
      path: input.path,
      alt: input.alt,
      prompt: input.prompt,
      width: input.width,
      height: input.height,
      bytes: input.bytes,
      model: input.model,
    } as never);
    if (error) {
      console.warn(`[newsletter-imagery] asset register failed (${input.issueId}): ${error.message}`);
    }
  } catch (e) {
    console.warn(
      `[newsletter-imagery] asset register threw (${input.issueId}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/** Delete every storage object + registry row for an issue's generated imagery.
 * Used by the issue-deletion / cleanup path so abandoned issues don't leak public
 * assets. Best-effort; returns the number of storage objects removed. */
export async function cleanupIssueAssets(issueId: string): Promise<number> {
  let removed = 0;
  try {
    const { data } = await supabaseAdmin
      .from("newsletter_issue_assets")
      .select("path")
      .eq("issue_id", issueId);
    const paths = ((data ?? []) as Array<{ path: string | null }>)
      .map((r) => r.path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    if (paths.length > 0) {
      const { error } = await supabaseAdmin.storage.from("content-images").remove(paths);
      if (!error) removed = paths.length;
      else console.warn(`[newsletter-imagery] storage cleanup failed (${issueId}): ${error.message}`);
    }
    // The registry rows cascade-delete with the issue; remove them explicitly too
    // so a manual cleanup (issue kept, imagery dropped) leaves no orphans.
    await supabaseAdmin.from("newsletter_issue_assets").delete().eq("issue_id", issueId);
  } catch (e) {
    console.warn(
      `[newsletter-imagery] cleanup threw (${issueId}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return removed;
}

// ── Impure: the per-issue orchestrator ───────────────────────────────────────

export interface ResolveImageInput {
  issueId: string;
  /** Issue title — the branded-card headline + the photo alt subject. */
  title: string;
  /** Topic label — the editorial photo subject + the branded-card eyebrow. */
  topicLabel: string;
  /** Explicit photographic prompt; derived from the topic when omitted. */
  imagePrompt?: string | null;
  product?: "gradethread" | "flipdesk" | "both";
  /** 0 disables the AI photo (branded card only); >0 attempts the photo first. */
  maxImages: number;
}

function defaultPhotoPrompt(topicLabel: string): string {
  return (
    `Editorial photograph for a newsletter about ${topicLabel}. ` +
    `Photographic realism, clean composition, natural light, no text in the image.`
  );
}

/**
 * Resolve the issue's lead image. Tries the photographic hero (gpt-image-1) when
 * imagery is enabled; on any failure — or when disabled — falls back to the
 * deterministic branded banner card so the issue is NEVER blocked on imagery
 * (AC4). Never throws. Returns the chosen image plus an audit detail.
 */
export async function resolveIssueImage(
  input: ResolveImageInput,
): Promise<{ image: ResolvedIssueImage; detail: string }> {
  const eyebrow = input.topicLabel;
  const cardFallback = (): { image: ResolvedIssueImage; detail: string } => {
    const url = brandedCardUrl({ text: input.title, eyebrow, product: input.product });
    const alt = `${input.title} — GradeThread`;
    const { width, height } = BRANDED_CARD_SIZE;
    const image: ResolvedIssueImage = {
      kind: "branded_card",
      url,
      alt,
      width,
      height,
      html: buildEmailImageHtml({ url, alt, width, height }),
    };
    return { image, detail: "branded-card" };
  };

  if (input.maxImages <= 0) {
    const card = cardFallback();
    await registerIssueAsset({
      issueId: input.issueId,
      kind: "branded_card",
      url: card.image.url,
      path: null,
      alt: card.image.alt,
      prompt: null,
      width: card.image.width,
      height: card.image.height,
      bytes: null,
      model: null,
    });
    return card;
  }

  const model = getDefaultImageModel();
  const prompt = input.imagePrompt?.trim() || defaultPhotoPrompt(input.topicLabel);
  try {
    const gen = await generateHeroImage({ prompt, size: HERO_SIZE, quality: HERO_QUALITY });
    // Log spend before the upload so a storage hiccup still records the AI cost.
    await recordImageSpend(model, gen.meta.size, gen.meta.quality, gen.meta.latency_ms);

    const verdict = validateImageUpload(gen.bytes, { allow: ["jpeg", "png", "webp"] });
    let bytes = gen.bytes;
    let contentType = "image/png";
    let ext = "png";
    if (verdict.ok) {
      const stripped = stripImageMetadata(gen.bytes, verdict.format);
      bytes = stripped.bytes;
      contentType = verdict.contentType;
      ext = verdict.ext;
    }
    const up = await uploadHeroImage({
      postId: input.issueId,
      bytes,
      contentType,
      ext,
      surface: "blog",
      slug: `newsletter-${input.issueId}`,
    });
    const alt = `Editorial photograph illustrating ${input.topicLabel}`;
    const image: ResolvedIssueImage = {
      kind: "hero",
      url: up.url,
      alt,
      width: 1536,
      height: 1024,
      html: buildEmailImageHtml({ url: up.url, alt, width: 1536, height: 1024 }),
    };
    await registerIssueAsset({
      issueId: input.issueId,
      kind: "hero",
      url: up.url,
      path: up.path,
      alt,
      prompt,
      width: 1536,
      height: 1024,
      bytes: bytes.byteLength,
      model,
    });
    return { image, detail: "photo" };
  } catch (e) {
    // AC4: a generation/upload failure degrades to the branded card, not a block.
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[newsletter-imagery] photo failed; using branded card: ${reason}`);
    const card = cardFallback();
    await registerIssueAsset({
      issueId: input.issueId,
      kind: "branded_card",
      url: card.image.url,
      path: null,
      alt: card.image.alt,
      prompt: null,
      width: card.image.width,
      height: card.image.height,
      bytes: null,
      model: null,
    });
    return { image: card.image, detail: `photo-failed:${reason}` };
  }
}
