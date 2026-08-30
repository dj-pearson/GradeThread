// Legacy single-plan enum (US-225 migrates these to FlipdeskPlan). Kept until
// the legacy users.plan column is dropped.
export type UserPlan = "free" | "starter" | "professional" | "enterprise";

// Pricing model split (US-200/US-201): FlipDesk subscription tier + Stripe lifecycle.
export type FlipdeskPlan = "free" | "starter" | "pro" | "business";
// Buyer Platform subscription tier (US-1799). Mirrors BUYER_PLANS keys in
// src/lib/constants.ts. Separate lifecycle from the FlipDesk/seller plan.
export type BuyerPlan = "free" | "guard" | "connoisseur";
export type SubscriptionStatus =
  | "none"
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "canceled"
  // US-2398 (migration 00529): an admin grant with no billing behind it. It
  // entitles like a paid status and is excluded from MRR.
  | "comp";
export type BillingInterval = "monthly" | "yearly";
export type GradeCreditReason =
  | "pack_purchase"
  | "grade_debit"
  | "included_grant"
  | "admin_grant"
  | "refund"
  | "expiration"
  // US-892: signed manual admin adjustment that is neither a pack purchase,
  // organic grade debit, nor a refund.
  | "correction";
export type GarmentType = "tops" | "bottoms" | "outerwear" | "dresses" | "footwear" | "accessories";
export type GarmentCategory =
  | "t-shirt" | "shirt" | "blouse" | "sweater" | "hoodie"
  | "jacket" | "coat" | "jeans" | "pants" | "shorts"
  | "skirt" | "dress" | "sneakers" | "boots" | "sandals"
  // US-2224 (00570): neckwear and gloves. See src/lib/constants.ts for why the
  // value is "neckwear" and not "tie".
  | "hat" | "bag" | "belt" | "scarf" | "neckwear" | "gloves" | "other";
export type SubmissionStatus =
  | "pending"
  | "processing"
  // Mandatory review: AI grade produced but PRELIMINARY — awaiting human
  // finalization. The certificate stays withheld and the item is not yet live.
  | "pending_review"
  | "completed"
  | "failed"
  | "disputed"
  // US-332: image-quality gate abstained — seller must add better photos.
  | "needs_photos"
  // US-773: abandoned checkout (started but never paid) retired by the reaper.
  | "expired";

// US-332: actionable feedback recorded when the quality gate abstains.
export interface QualityFeedback {
  summary: string;
  photo_requests: string[];
  issues: {
    image_type: string;
    problem: string;
    severity: "block" | "warn";
    message: string;
  }[];
  assessed_at: string;
}
export type GradeTier = "NWT" | "NWOT" | "Excellent" | "Very Good" | "Good" | "Fair" | "Poor";
export type ImageType =
  | "front"
  | "back"
  | "label"
  | "label_2"
  | "detail"
  | "detail_2"
  | "detail_3"
  | "detail_4"
  | "defect"
  | "measurement_chest"
  | "measurement_waist"
  | "measurement_length"
  | "measurement_sleeve"
  | "measurement_inseam";
export type DisputeStatus = "open" | "under_review" | "resolved" | "rejected";
export type ItemStatus =
  | "sourced"
  | "acquired"
  | "cataloged"
  | "measured"
  | "photographed"
  | "grading"
  | "graded"
  | "comped"
  | "drafted"
  | "listed"
  | "sold"
  | "shipped"
  | "completed"
  | "returned"
  | "archived"
  | "keeping"
  | "wearing";

// One comp record stored inside inventory_items.comp_set jsonb.
export interface ItemComp {
  price: number;
  source?: string;
  url?: string;
  sold_date?: string;
  notes?: string;
}
export type ListingPlatform =
  | "ebay"
  | "poshmark"
  | "mercari"
  | "depop"
  | "grailed"
  | "facebook"
  | "offerup"
  | "shopify"
  | "whatnot"
  | "other";
export type UserRole = "user" | "reviewer" | "admin" | "super_admin";

// ─── Workspace (team) roles ────────────────────────────────────────
// Single workspace per "owner user". Members can hold these roles in OTHER
// users' workspaces (the owner themself is implicit — no row in
// workspace_members; their effective role is always 'owner').
export type WorkspaceRole =
  | "viewer"
  | "member"
  | "listing_manager"
  | "admin"
  | "owner";
export type NotificationType =
  | "grade_complete"
  | "grading_submitted"
  | "grading_ready"
  // Mandatory-review lifecycle (seller-facing).
  | "grading_preliminary"
  | "grading_finalized"
  | "grading_failed"
  | "grading_incomplete"
  | "dispute_update"
  | "billing"
  | "system"
  | "item_status_change"
  | "listing_live"
  | "sale_recorded"
  | "low_stock"
  | "payout_imported"
  | "offer_received"
  | "return_requested"
  // US-1055: offer responses + return/dispute openings.
  | "offer_responded"
  | "return_opened"
  | "dispute_opened"
  // US-2560: a buyer asked to cancel an order (eBay Post-Order).
  | "cancellation_requested"
  // US-1803: buyer-side notification categories.
  | "buyer_condition_alert"
  | "buyer_reward"
  | "buyer_guarantee"
  | "buyer_portfolio"
  // US-1859: re-engagement nudges (streak-at-risk, near-miss, quests, expiring
  // rewards). Gated by its own `reward_nudges` preference category.
  | "reward_nudge"
  // US-1912: the seller's Grade Integrity tier moved. Only ever sent to the
  // seller — a demotion is never announced publicly.
  | "integrity_tier_change";

// ─── FlipDesk enums ────────────────────────────────────────────────
export type FlipdeskSourceType =
  | "thrift"
  | "goodwill_auction"
  | "estate_sale"
  | "wholesale"
  | "retail_arbitrage"
  | "consignment"
  | "other";
// US-600: consignment mode.
export type ConsignorStatus = "active" | "paused" | "archived";
export type ConsignorPayoutStatus =
  | "pending"
  | "processing"
  | "paid"
  | "failed"
  | "canceled"
  // US-2022: the sale reversed after the payout settled. "reversed" = clawed
  // back successfully; "clawback_pending" = the reversal FAILED and the seller
  // is out of pocket until a human recovers it.
  | "reversed"
  | "clawback_pending";
export type ItemCategory =
  | "clothing"
  | "shoes"
  | "watches"
  | "jewelry"
  | "sports_cards"
  | "collectibles"
  | "electronics"
  | "books"
  | "bags"
  | "accessories"
  // Migration 00570 added this to the item_category enum and to
  // ITEM_CATEGORIES, but never to this union — so `headwear` typechecked as an
  // invalid ItemCategory everywhere it was compared. Found and fixed while
  // wiring US-2465's per-category profile lookup.
  | "headwear"
  | "other";
export type FlipdeskPhotoType =
  | "front"
  | "back"
  | "tag"
  | "tag_2"
  | "detail"
  | "detail_2"
  | "detail_3"
  | "detail_4"
  | "interior"
  | "defect"
  | "flatlay"
  | "on_model"
  | "measurement_chest"
  | "measurement_waist"
  | "measurement_length"
  | "measurement_sleeve"
  | "measurement_inseam"
  // Universal roles added in migration 00230 for non-clothing categories.
  | "angle"
  | "sole"
  | "marking"
  | "serial"
  | "accessory"
  | "certificate"
  | "corner"
  | "surface"
  // US-1571 (migration 00346): the MeasureCard calibration frame — keys the
  // photo-measurement pipeline; never listed, never fed to generation AI.
  | "measurement"
  // US-1577 (migration 00350): generated card-free measurements photo —
  // listing-eligible, never primary.
  | "measurement_overlay"
  // US-1549 (migration 00340): seller-reference only — never sent to eBay,
  // never fed to AI, never shown on public surfaces.
  | "internal"
  // US-2462 (migration 00587): the two roles in the new vocabulary that had no
  // existing type to reuse. Everything else the epic added is an existing type
  // plus an `photo_role` qualifier — see src/lib/photo-roles.ts.
  | "on_hanger"
  | "set_pair";
export type ListingStatus = "draft" | "active" | "ended" | "sold" | "relisted";
export type GradingSubmissionTier = "standard" | "premium" | "express";
export type PayoutImportMethod = "csv_upload" | "api_sync";
// AutoLister (migration 00052)
export type ListingGenerationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "partial";
export type ListingGenerationJobStatus =
  | "pending"
  | "running"
  | "success"
  | "failed";
export type ListingGenerationSource = "autolister" | "manual" | "api";
export type BusinessPolicyType = "fulfillment" | "payment" | "return";
export type ExpenseCategory =
  | "shipping_supplies"
  | "mileage"
  | "subscriptions"
  | "platform_fees"
  | "sourcing_travel"
  | "equipment"
  | "storage"
  | "other";

// ─── Row types (what you SELECT) ───────────────────────────────────

// Per-event delivery channels. All optional so a category can advertise only
// the channels it supports (e.g. product_updates is email-only) and partial /
// legacy rows stay safe to read — fill via withPreferenceDefaults() (US-1058).
export type NotificationChannel = "email" | "in_app" | "push";
export interface NotificationChannelPrefs {
  email?: boolean;
  in_app?: boolean;
  push?: boolean;
}

export interface NotificationPreferences {
  grade_complete: NotificationChannelPrefs;
  dispute_updates: NotificationChannelPrefs;
  billing_alerts: NotificationChannelPrefs;
  product_updates: NotificationChannelPrefs;
  // US-911: master marketing-email umbrella (the canonical opt-out every
  // marketing send path honors) + the dedicated weekly-newsletter category.
  marketing: NotificationChannelPrefs;
  weekly_newsletter: NotificationChannelPrefs;
  // Selling lifecycle: listing went live, sale recorded, item status changed
  // (US-737). Payouts split into their own category in US-1058.
  selling_activity: NotificationChannelPrefs;
  // US-1058: granular per-event categories with their own opt-out.
  offers: NotificationChannelPrefs;
  returns: NotificationChannelPrefs;
  payouts: NotificationChannelPrefs;
  // US-1803: buyer-side categories (condition alerts, rewards, guarantee,
  // portfolio). Gate the buyer notification delivery layer (buyer-notify.ts);
  // mirror PREF_KEY in services/edge-functions/src/lib/notify.ts.
  buyer_alerts: NotificationChannelPrefs;
  buyer_rewards: NotificationChannelPrefs;
  buyer_guarantee: NotificationChannelPrefs;
  buyer_portfolio: NotificationChannelPrefs;
  // US-1859: re-engagement nudges. In-app + push only — a nudge that arrives by
  // email is a marketing email, and there is already a master switch for those.
  reward_nudges: NotificationChannelPrefs;
  // US-1912: Grade Integrity standing changes. In-app + push only — a standing
  // change is dashboard news, not something worth an inbox interruption.
  integrity_updates: NotificationChannelPrefs;
}

export type UserUseCase = "seller" | "buyer" | "consignment" | "developer";

// US-1670: self-reported signup-source survey values. MUST stay in sync with the
// whitelist in the handle_new_user() trigger (migration 00379) and
// SIGNUP_SOURCE_OPTIONS in src/lib/constants.ts.
export type SignupSource =
  | "ai_assistant"
  | "search"
  | "social"
  | "reddit"
  | "youtube"
  | "friend"
  | "reseller_community"
  | "ad"
  | "other";

// US-1442: reseller ship-from / return address, entered once in Settings and
// reused across marketplace/shipping flows. All parts optional so a partial
// address (e.g. just ZIP for the eBay location) is valid.
export interface ShipFromAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

// US-2417: a column whose stored value is an AES-256-GCM envelope. It IS a
// string at runtime, so it still logs and serializes, but the brand makes it
// unassignable to a plain `string` parameter — so a value that has to be
// decrypted first cannot be passed into a formatter, a phone link or a JSX
// child by accident. Widen it deliberately (`String(x)`) only where the intent
// really is to move the envelope around.
declare const encryptedColumnBrand: unique symbol;
export type EncryptedColumn = string & { readonly [encryptedColumnBrand]: true };

export interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  // US-1442: reseller business + ship-from profile (migration 00325).
  business_name: string | null;
  // ⚠ US-2417: THESE TWO ARE CIPHERTEXT ON THIS ROW. They are AES-256-GCM
  // envelopes bound to `id`, and the key is edge-only, so the browser can
  // neither read nor write them. Rendering one shows the seller "v2:AbC…".
  //
  // The plaintext lives behind GET /api/account/shipping-profile — use
  // `fetchShippingProfile()` from @/lib/shipping-profile. The address is typed
  // as an opaque string rather than as ShipFromAddress on purpose: reaching for
  // `.line1` on it is exactly the mistake this change has to prevent, and a
  // type error is a better teacher than a broken settings page. 00567 also
  // dropped both from the users self-update allowlist, so a direct write raises.
  business_phone: EncryptedColumn | null;
  ship_from_address: EncryptedColumn | null;
  // 00432: seller Promoted-Listings defaults. promote_listings_by_default is the
  // off-by-default opt-in; a new/un-configured listing follows it. rate/mode are
  // fallbacks (null → category suggestion / 'cps').
  promote_listings_by_default: boolean;
  default_promo_rate_pct: number | null;
  default_promo_mode: string | null;
  // 00668: seller listing defaults — the composer's starting position for a NEW
  // draft. Null means "no opinion, use the platform default" everywhere except
  // the two booleans, where off IS the platform default. A saved listing's own
  // value always wins; these only ever seed.
  default_listing_format: ListingFormat | null;
  default_auction_duration: string | null;
  default_best_offer_enabled: boolean;
  default_best_offer_on_auction: boolean;
  // PERCENT of the listing price (1-99), converted to best_offer_*_cents at seed
  // time. Stored as a percentage on purpose — see the 00668 header.
  default_best_offer_accept_pct: number | null;
  default_best_offer_decline_pct: number | null;
  default_listing_quantity: number | null;
  /** @deprecated legacy single-plan enum; use flipdesk_plan + grade_credit_balance (US-201/US-225). */
  plan: UserPlan;
  role: UserRole;
  stripe_customer_id: string | null;
  // REPURPOSED (US-201): now counts INCLUDED Standard grades used this billing cycle
  // against the FlipDesk tier's monthly bundle (Free 3, Starter 10, Pro 30, Business 75).
  grades_used_this_month: number;
  grade_reset_at: string;
  notification_preferences: NotificationPreferences;
  // 00669: quiet hours for PUSH only. Null = never configured. Read/written
  // through src/lib/quiet-hours.ts, which mirrors the edge parser.
  notification_quiet_hours: {
    enabled?: boolean;
    start_hour: number;
    end_hour: number;
    tz?: string;
  } | null;
  use_case: UserUseCase | null;
  // US-1670: self-reported "How did you hear about us?" at signup (SignupSource),
  // for SEO/GEO discovery attribution (esp. the "AI assistant" option). Migration 00379.
  signup_source: SignupSource | null;
  onboarded_at: string | null;
  // US-1796: additive buyer/seller role flags (migration 00401). One identity can
  // be seller, buyer, or both. Role markers only — capability still gates on
  // flipdesk_plan (seller) / the buyer plan (buyer, US-1800).
  is_seller: boolean;
  is_buyer: boolean;
  suspended: boolean;
  // FlipDesk user-state flags (migrations 00028, 00029, 00242)
  flipdesk_onboarded: boolean;
  dismissed_flipdesk_promo: boolean;
  // US-1061: dismissed the one-time "manage in FlipDesk" eBay publish disclaimer
  dismissed_ebay_publish_disclaimer: boolean;
  // AI enrichment usage (US-158, US-167)
  ai_actions_used_this_month: number;
  ai_actions_reset_at: string;
  ai_enrichment_enabled: boolean;
  ai_action_limit: number | null;
  // Closed-loop sale-outcome opt-in (US-132)
  share_sale_outcomes: boolean;
  // Thrift Radar contribution opt-in (US-1861, migration 00550). Its own toggle
  // on purpose — location is a new kind of data, so folding it under
  // share_sale_outcomes would retroactively change what that consent meant.
  // Default false; VIEWING Radar is a separate consent and never gated on this.
  radar_contribute: boolean;
  // Pricing split (US-201): FlipDesk subscription state
  flipdesk_plan: FlipdeskPlan;
  flipdesk_interval: BillingInterval | null;
  subscription_status: SubscriptionStatus;
  flipdesk_subscription_id: string | null;
  flipdesk_period_end: string | null;
  flipdesk_pause_until: string | null;
  flipdesk_cancel_at_period_end: boolean;
  // GradeThread credit wallet (US-201)
  grade_credit_balance: number;
  // 14-day Pro trial bookkeeping (US-219). One trial per user, ever.
  trial_ends_at: string | null;
  // US-1799: buyer-platform subscription state (migration 00402). Separate from
  // the flipdesk_* family — one Stripe customer can hold both a buyer and a
  // seller subscription. Buyer capability gates on buyer_plan (US-1800).
  buyer_plan: BuyerPlan;
  buyer_interval: BillingInterval | null;
  buyer_subscription_status: SubscriptionStatus;
  buyer_subscription_id: string | null;
  buyer_period_end: string | null;
  buyer_cancel_at_period_end: boolean;
  // Scheduled downgrade target (US-217). NULL when no downgrade is pending.
  pending_flipdesk_plan: FlipdeskPlan | null;
  pending_flipdesk_interval: BillingInterval | null;
  pending_schedule_id: string | null;
  pending_effective_at: string | null;
  // Multi-user (US-Team): the workspace this user is currently acting
  // inside. NULL = personal workspace (workspace_owner_id = id).
  active_workspace_owner_id: string | null;
  // US-374: owner-scoped MFA-enforcement threshold. When set, members at or
  // above this role must use MFA (AAL2) to act in this owner's workspace.
  // NULL = no enforcement.
  workspace_mfa_required_role: WorkspaceRole | null;
  // Soft upgrade triggers (US-209, migration 00071). usage_alert_thresholds:
  // percentages (out of 100) the user wants to be warned at — default [80],
  // Settings offers 50/80/95. last_warning_at: dedup ledger keyed
  // "<cap>:<threshold>" → "YYYY-MM" so each trigger fires once per month.
  usage_alert_thresholds: number[];
  last_warning_at: Record<string, string>;
  // GradeThread Verified — public seller trust profile (migration 00057).
  verified_handle: string | null;
  verified_display_name: string | null;
  verified_bio: string | null;
  verified_enabled: boolean;
  verified_since: string | null;
  // Storefront opt-in: list active listings on the public profile (migration 00122).
  verified_show_listings: boolean;
  // US-864: opt into the public top-referrers leaderboard + the PII-free alias
  // shown there (migration 00195).
  referral_leaderboard_enabled: boolean;
  referral_display_name: string | null;
  // US-1814: opt into the buyer confirmer rewards leaderboard + alias (00423).
  rewards_leaderboard_enabled: boolean;
  rewards_display_name: string | null;
  // US-1856: opt into the public reward leaderboards (XP / grades / finds /
  // share-driven signups) + the alias shown there (00547). A THIRD toggle on
  // purpose: those boards publish numbers the referral and buyer boards' copy
  // never covered. A NULL alias falls back to the verified display name, then
  // the referral alias, then the buyer alias.
  leaderboard_opt_in: boolean;
  leaderboard_alias: string | null;
  // US-1818: opt-in public buyer Trust Score profile (00427; private by default).
  buyer_profile_handle: string | null;
  buyer_profile_enabled: boolean;
  buyer_profile_show: Record<string, boolean>;
  // Cross-source sync-conflict email alert: send one email when the open
  // conflict count crosses this number (US-148, migration 00133). NULL disables.
  sync_conflict_email_threshold: number | null;
  // US-377: current accepted ToS/Privacy versions (clickwrap). NULL = never
  // recorded → the client legal gate blocks the dashboard until acceptance.
  tos_accepted_version: string | null;
  tos_accepted_at: string | null;
  privacy_accepted_version: string | null;
  privacy_accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Workspace membership / invitations ────────────────────────────

export interface WorkspaceMemberRow {
  id: string;
  owner_id: string;
  member_id: string;
  role: WorkspaceRole;
  invited_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMemberInsert {
  owner_id: string;
  member_id: string;
  role?: WorkspaceRole;
  invited_by?: string | null;
}

export type WorkspaceMemberUpdate = Partial<
  Pick<WorkspaceMemberRow, "role">
>;

export interface WorkspaceInvitationRow {
  id: string;
  owner_id: string;
  email: string;
  role: WorkspaceRole;
  token: string;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceInvitationInsert {
  owner_id: string;
  email: string;
  role: WorkspaceRole;
  token: string;
  invited_by?: string | null;
  expires_at?: string;
}

export type WorkspaceInvitationUpdate = Partial<
  Pick<WorkspaceInvitationRow, "role" | "revoked_at">
>;

// US-377: append-only ToS/Privacy clickwrap acceptance log. One row per
// acceptance event (signup / oauth / re-acceptance) — the provable, exportable
// record. Written only by the edge service-role client + the signup trigger.
export interface LegalAcceptanceRow {
  id: string;
  user_id: string;
  tos_version: string;
  privacy_version: string;
  method: string;
  user_agent: string | null;
  ip_address: string | null;
  accepted_at: string;
}

// US-374: single-use MFA recovery codes. Only SHA-256 hashes are persisted;
// plaintext is shown once at generation time.
export interface MfaRecoveryCodeRow {
  id: string;
  user_id: string;
  code_hash: string;
  used_at: string | null;
  created_at: string;
}

// Returned by peek_workspace_invitation RPC.
export interface WorkspaceInvitationPeek {
  email: string;
  role: WorkspaceRole;
  owner_email: string;
  owner_full_name: string | null;
  expires_at: string;
  status: "pending" | "accepted" | "revoked" | "expired";
}

// Shape used in the auth store to describe a workspace the user can
// switch into (either their own personal workspace, or one they're a
// member of).
export interface WorkspaceSummary {
  ownerId: string;
  ownerEmail: string;
  ownerName: string | null;
  role: WorkspaceRole;
  isPersonal: boolean;
}

export type ModerationStatus = "approved" | "rejected";

export interface SubmissionRow {
  id: string;
  user_id: string;
  garment_type: GarmentType;
  garment_category: GarmentCategory;
  brand: string | null;
  title: string;
  description: string | null;
  // Seller-declared intentional design features (distressed, raw-hem, …) — a
  // hint to the grader so factory distressing isn't read as damage.
  style_attributes: string[];
  status: SubmissionStatus;
  // The requested grade-speed tier (standard/premium/express) — sets the review
  // SLA + operator-queue priority (migration 00312). NOT the quality grade.
  service_tier: "standard" | "premium" | "express";
  flagged: boolean;
  flag_reason: string | null;
  moderation_status: ModerationStatus | null;
  // US-332: present when status === 'needs_photos' (the quality gate abstained).
  quality_feedback: QualityFeedback | null;
  // US-385: set when a per-grade charge was refunded/disputed — the grade's
  // public certificate is withheld and the submission is flagged for review.
  refunded_at: string | null;
  // US-340: the seller opted into the Verified Capture provenance path. The
  // badge is only AWARDED if the server-side checks also pass; opting in never
  // lowers a grade.
  verified_capture_opt_in: boolean;
  // US-601: the seller purchased the premium authenticity/counterfeit-confidence
  // add-on for this submission (Premium/Express tiers only).
  authenticity_addon: boolean;
  // US-773/US-569: durable grading job state. grading_started_at is stamped on
  // the first claim; grading_lease_until is the lease expiry (a live grade run
  // owns the row until then; an expired lease is re-claimable/resumable);
  // grading_attempts bounds resume retries of a poison submission.
  grading_started_at: string | null;
  grading_lease_until: string | null;
  grading_attempts: number;
  // US-949: one-tap retake chain. retake_of_submission_id points back to the
  // prior needs_photos/expired submission this one replaces. The prior row gets
  // superseded_at + superseded_by_submission_id set so it drops out of active
  // counts but is preserved as history (not orphaned/deleted).
  retake_of_submission_id: string | null;
  superseded_at: string | null;
  superseded_by_submission_id: string | null;
  // US-1841: a walk-around clip grade the BUYER asked for, paid with a
  // video-grade credit from their buyer plan rather than the seller precedence.
  // closet_item_id is the portfolio item it answers a question about; the
  // finished grade is written back onto that item.
  buyer_video_grade: boolean;
  closet_item_id: string | null;
  // US-1855: per-item consent for the public Showcase / "Finds" feed. Defaults
  // false and inherits nothing from the account-level verified-profile toggles —
  // a public profile is consent to be found, not to have THIS garment reposted.
  // showcase_value_cents is the seller's OWN stated value, never an inferred comp.
  showcase_opt_in: boolean;
  showcase_opted_in_at: string | null;
  showcase_value_cents: number | null;
  created_at: string;
  updated_at: string;
}

// Intentional design feature the grader judged present (does NOT lower grade).
export interface DetectedStyleAttribute {
  attribute: string;
  location: string;
  confidence: number;
}

// Genuine wear/damage the grader identified (NOT intentional design). Persisted
// on grade_reports.defects_found (migration 00058) — powers the Auto-Disclosure
// Engine's condition & flaws section + annotated defect photos.
export interface DefectFound {
  defect: string;
  severity: "minor" | "moderate" | "major";
  location: string;
  impact_on_grade?: string;
  // US-1027/1028/1286: the structured taxonomy the edge persists into the
  // defects_found jsonb (defect-weighting.ts). Optional for back-compat —
  // historical grades graded before the taxonomy never set them. Powers the
  // AI repair-triage recovered-value recommendations (lib/repair-triage.ts).
  defect_type?: string;
  repairability?: "reversible" | "repairable" | "permanent";
  size_bucket?: "pinhole" | "small" | "medium" | "large" | "extensive" | "unknown";
  area_pct?: number | null;
}

// US-1287: sanitized per-image defect callout exposed by the public_grade_reports
// view (migration 00313). One genuine, LOCALIZED defect: the same issue/severity/
// location already public via defects_found, plus the normalized [x,y,w,h] bbox
// (0..1, top-left + w/h) so the certificate can draw a PSA-style box over the
// photo. `bbox` is non-null in the view (only localized defects are projected),
// but typed nullable for client-side robustness.
export interface PublicDefectAnnotation {
  issue: string;
  severity: "minor" | "moderate" | "major";
  location: string;
  bbox: [number, number, number, number] | null;
}

export interface PublicImageDefectAnnotations {
  image_type: string;
  annotations: PublicDefectAnnotation[];
}

// Aggregated photo-authenticity assessment from the grading vision pass
// (US-336/US-338). A suspected result forces a human review; surfaced on the
// public certificate. Null on grades created before migration 00061.
export interface ImageAuthenticity {
  manipulation_suspected: boolean;
  manipulation_confidence: number;
  screenshot_or_watermark_detected: boolean;
  tells: string[];
  flagged_image_types: string[];
  summary: string;
}

// EXIF/provenance metadata captured client-side from the ORIGINAL file before
// compression (US-339). Every field is optional — absence is normal (re-shared
// photos, screenshots, stripped uploads) and is never penalized on its own.
// GPS, when present, is privacy-sensitive: access-controlled, never exposed
// publicly or to buyers.
export interface ImageExifMetadata {
  make?: string;
  model?: string;
  software?: string;
  lensModel?: string;
  orientation?: number;
  dateTime?: string;
  dateTimeOriginal?: string;
  gps?: { latitude: number; longitude: number };
}

// US-340: server-side Verified Capture provenance evaluation, persisted on
// grade_reports.verified_capture. A POSITIVE signal only — `verified: true`
// earned the certificate badge + a small confidence boost; it never lowers a
// grade and missing provenance is never penalized.
export interface VerifiedCaptureResult {
  verified: boolean;
  reasons: string[];
  device: string | null;
  with_exif: number;
  total: number;
  max_age_days: number;
  checked_at: string;
}

// US-861: "original photos verified" anti-fraud signal, persisted on
// grade_reports.original_photos. Derived from the photo-reuse scan (US-337): a
// POSITIVE signal only — `verified: true` means the photos were compared and
// none matched a DIFFERENT account (stock/stolen tell). `checked` is the count
// of hashable images actually compared (0 = scan couldn't run → no badge, never
// a negative claim). The public view exposes only the verified boolean.
export interface OriginalPhotosResult {
  verified: boolean;
  checked: number;
  checked_at: string;
}

// US-601: premium authenticity / counterfeit-confidence add-on result, persisted
// on grade_reports.authenticity_assessment. A SEPARATE garment-authenticity
// signal — distinct from the condition grade and from the photo-tamper check
// (ImageAuthenticity). A CONFIDENCE estimate, never a definitive authentication;
// the limitations are always disclosed. Null when the add-on was not purchased.
export type CounterfeitRisk = "low" | "elevated" | "high" | "indeterminate";

export interface AuthenticityAssessment {
  assessed: boolean;
  // 0.0–1.0 confidence that the garment is a GENUINE example of the claimed brand.
  authenticity_confidence: number;
  counterfeit_risk: CounterfeitRisk;
  brand_assessed: string | null;
  signals_examined: string[];
  // Owner/admin-only — never published raw on a public certificate.
  red_flags: string[];
  supporting_signals: string[];
  summary: string;
  limitations: string;
  model: string;
  prompt_version: string;
  // US-2145: set by POST /api/grade/authenticity-appeal. While an appeal is
  // open the server NULLS verdict / confidence / risk / summary and stashes the
  // original in appeal_hidden_original, so the seller is not left defending a
  // verdict that is still on display. Every nulled field above is therefore
  // nullable in practice — read them through the under_appeal check, not
  // around it.
  under_appeal?: boolean;
  appeal_opened_at?: string | null;
}

// US-341: server-side forensic manipulation pass fused with the US-336 vision
// signal, persisted on grade_reports.forensic_analysis. Internal anti-fraud
// data — never exposed on the public certificate. Null unless an uncompressed
// original was retained (US-339) so the pass actually ran.
export interface ForensicTamperAssessment {
  tamper_likelihood: number;
  manipulation_suspected: boolean;
  needs_review: boolean;
  confidence_penalty: number;
  forensic_ran: boolean;
  forensic_suspected: boolean;
  vision_suspected: boolean;
  tells: string[];
  summary: string;
  // Raw per-image forensic detail (structural scores + features).
  forensic?: unknown;
}

export interface SubmissionImageRow {
  id: string;
  submission_id: string;
  image_type: ImageType;
  storage_path: string;
  display_order: number;
  created_at: string;
  // US-337: 64-bit dHash (16 hex chars) for cross-submission photo-reuse
  // detection. Null when client-side hashing was unavailable.
  phash?: string | null;
  // US-339: structured EXIF/provenance read from the original file before
  // compression. Null/absent is normal.
  exif?: ImageExifMetadata | null;
  // US-339: path to the retained ORIGINAL (uncompressed, EXIF-intact) file in
  // the private bucket, for server-side forensic/provenance use. Null unless
  // original retention is enabled. Never public, never served to buyers.
  original_storage_path?: string | null;
  // US-2136 AC4: 0..1 sharpness measured client-side on the compressed bytes
  // (macro-photo-quality.ts). NULL means NOT MEASURED — an older client or a
  // canvas that could not decode — and readers must treat that as unknown, not
  // as zero. Only meaningful for the macro slots.
  quality_score?: number | null;
}

export interface GradeReportRow {
  id: string;
  submission_id: string;
  overall_score: number;
  grade_tier: GradeTier;
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
  ai_summary: string;
  // US-759: longer buyer-facing certified condition report. Null for grades
  // finalized before the write-up existed (the UI falls back to ai_summary).
  buyer_writeup: string | null;
  detailed_notes: Record<string, string> | null;
  // Intentional design features the AI recognized (distressing, raw hems, …).
  // These did NOT lower the grade — condition is graded vs. as-manufactured state.
  detected_style_attributes: DetectedStyleAttribute[];
  // Structured genuine defects (migration 00058). Empty array for historical
  // grades that never persisted them — the disclosure engine falls back to
  // detailed_notes.defects_summary in that case.
  defects_found: DefectFound[];
  // Raw per-image analysis trace (eval/training/dispute explanation). Nullable
  // for historical rows graded before migration 00050.
  per_image_analysis: unknown[] | null;
  confidence_score: number;
  needs_human_review: boolean;
  // Aggregated photo-authenticity assessment (US-336/US-338). Null for grades
  // created before migration 00061.
  image_authenticity: ImageAuthenticity | null;
  // US-340: Verified Capture provenance result. Null for grades produced before
  // the check / when the seller did not opt in.
  verified_capture: VerifiedCaptureResult | null;
  // US-861: "original photos verified" anti-fraud signal. Null for grades
  // produced before the check (migration 00194).
  original_photos: OriginalPhotosResult | null;
  // US-601: premium authenticity / counterfeit-confidence add-on result. Null
  // when the add-on was not purchased (migration 00172).
  authenticity_assessment: AuthenticityAssessment | null;
  // US-341: forensic manipulation pass fused with the vision signal. Null unless
  // a retained original made the pass run (migration 00139). Internal — never
  // exposed on the public certificate view.
  forensic_analysis: ForensicTamperAssessment | null;
  // True once a human reviewer has checked this grade (migration 00061).
  human_reviewed: boolean;
  // Mandatory-review lifecycle (migration 00312). pending = preliminary AI grade
  // awaiting human finalization (certificate withheld); approved = reviewer
  // agreed as-is; modified = reviewer adjusted the scores before finalizing.
  review_status: "pending" | "approved" | "modified";
  // When the grade was finalized (made official + public). Null while preliminary.
  finalized_at: string | null;
  // The reviewer who finalized it, and when.
  reviewed_by: string | null;
  reviewed_at: string | null;
  // Target review-by time (report creation + the requested tier SLA) — drives
  // operator-queue priority. Null for pre-00312 grades.
  review_due_at: string | null;
  model_version: string;
  // First-class prompt version that produced this grade (e.g. "composite_v2").
  prompt_version: string | null;
  certificate_id: string | null;
  // US-333 tamper-evident integrity (migration 00068). Null for grades
  // finalized before the integrity scheme — they verify as "unverifiable".
  content_hash: string | null;
  content_signature: string | null;
  integrity_version: number | null;
  // US-769: aggregate certificate view count (no buyer PII). 0 until viewed.
  view_count: number;
  // US-479: set when an admin reject-and-regrade replaced this report with a
  // fresh grade. A non-null value means this is HISTORY — the active report for
  // the submission is the one with superseded_at IS NULL. Null for every report
  // graded before the regrade flow existed.
  superseded_at: string | null;
  // US-1091: the Garment Passport this report's certificate maps to. Null for
  // non-certificated/superseded reports and pre-passport grades.
  garment_id: string | null;
  created_at: string;
}

// US-348: public-safe projection of a certified grade report, served by the
// `public_grade_reports` view. Anonymous certificate viewers read THIS, never
// the base grade_reports row — so anti-fraud/internal signals (raw
// confidence_score, image_authenticity.tells, per_image_analysis,
// detailed_notes, content_signature, needs_human_review) are never exposed.
export type PublicConfidenceLabel = "very_high" | "high" | "moderate" | "reviewed";

export interface PublicGradeReportRow {
  id: string;
  submission_id: string;
  certificate_id: string;
  // US-2392 (00522): when this certificate's CERTIFIED CONTENT — scores, tier,
  // integrity hash — was last rewritten in place by a human-review adjustment.
  // NULL means never revised, which is the truthful answer rather than a
  // missing value: an unrevised certificate has no modification date distinct
  // from its publication date. A REGRADE must not set it (00150 mints a new
  // certificate_id instead). Drives the schema.org dateModified.
  certified_content_updated_at: string | null;
  // 00307: PSA-style public certificate number ("GT-XXXXXXX"). Null only for
  // legacy rows before backfill. The verification key typed into /verify.
  certificate_number: string | null;
  created_at: string;
  overall_score: number;
  grade_tier: GradeTier;
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
  ai_summary: string;
  // US-759: longer buyer-facing certified condition report (null on older
  // certificates; the cert page falls back to ai_summary).
  buyer_writeup: string | null;
  model_version: string;
  human_reviewed: boolean;
  defects_found: DefectFound[];
  detected_style_attributes: DetectedStyleAttribute[];
  // Buyer-facing authenticity summary derived from image_authenticity; the raw
  // detection tells stay server-side so they can't be used to evade the check.
  authenticity_checked: boolean;
  authenticity_manipulation_suspected: boolean;
  authenticity_screenshot_or_watermark_detected: boolean;
  // Coarse confidence bucket — the precise confidence_score is not exposed.
  confidence_label: PublicConfidenceLabel;
  // US-340: true when the opt-in provenance checks passed (the certificate
  // "Verified Capture" badge). Only the pass/fail boolean is public — the raw
  // device/recency reasons stay server-side.
  verified_capture_passed: boolean;
  // US-601: premium authenticity add-on, buyer-safe projection. Coarse fields
  // only — the raw red_flags/signals stay server-side. Null/false when the
  // add-on wasn't purchased.
  authenticity_addon_included: boolean;
  authenticity_confidence_label: "high" | "moderate" | "low" | null;
  authenticity_counterfeit_risk: CounterfeitRisk | null;
  authenticity_summary: string | null;
  authenticity_limitations: string | null;
  // US-861: true when this submission's photos were compared and none matched a
  // different account ("Original photos verified" badge). Positive-only — the
  // raw reuse-scan counts stay server-side.
  original_photos_verified: boolean;
  // US-1283: true when this submission earned the strongest fraud-proof
  // "Live-Verified" badge (every photo captured live in-app, device-attested,
  // provenance verified, no manipulation). A downgrade to standard Verified
  // Capture surfaces via verified_capture_passed instead. Positive-only — the
  // raw downgrade reasons stay server-side.
  live_capture_verified?: boolean;
  // US-1281: true when this submission earned the premium "360-Verified" badge
  // (a passing photogrammetric/LiDAR true-geometric capture). Positive-only —
  // the raw capture metrics stay server-side.
  verified_360_badge?: boolean;
  // US-1762: true when this grade was produced from frames the SERVER extracted
  // from one continuous walk-around clip (no manipulation, no cross-account
  // reuse) — the "Video-Verified" badge. Positive-only; the frame metrics and
  // the reasons a clip fell short stay server-side.
  video_capture_verified?: boolean;
  // US-1766: true when that clip was ALSO recorded live in the in-app recorder,
  // so it never existed as a file before this submission. A stronger reading of
  // the badge above, never a second badge — it is never true on its own.
  video_live_capture_verified?: boolean;
  // Non-clothing grading (migration 00231): generic { factor_key: score } map +
  // the rubric that produced it (e.g. "sports_cards"). Null on clothing & legacy
  // certificates — the cert renders the typed factor columns instead.
  //
  // The view PROJECTS both as of 00530 (US-1997); until then it did not, so this
  // comment's older wording — "exposed only once the pipeline writes them" —
  // named one gap and missed the other. Two independent things had to be true and
  // only one was tracked: the pipeline must WRITE them (still Phase 2, gated on a
  // non-clothing golden set) and the view must PROJECT them (done). So they are
  // still always null today, but for one reason now instead of two.
  //
  // factor_scores arrives sanitized: the view keeps only number-valued entries
  // and returns NULL rather than {} when none survive, precisely so the
  // `factor_scores && rubric_key` guard below cannot be satisfied by an empty
  // object ({} is truthy) and fall into an all-zero breakdown.
  factor_scores?: Record<string, number> | null;
  rubric_key?: string | null;
  // US-1287: genuine, localized defects with their normalized bounding boxes,
  // grouped per image_type, for the certificate's PSA-style photo callouts.
  // Always an array (the view COALESCEs to []); absent/[] on grades whose
  // defects were never localized — the cert falls back to the text flaw list.
  defect_annotations?: PublicImageDefectAnnotations[] | null;
  // US-1278: the 2D inspection-zone coverage record (US-1276) powering the
  // certificate coverage badge + silhouette heatmap. Null on reports graded
  // before 00308 — the cert widget hides itself in that case.
  coverage?: PublicCoverageRecord | null;
}

// US-1278: buyer-safe shape of grade_reports.coverage as projected by the
// public_grade_reports view. Mirrors the grading engine's CoverageResult
// (services/edge-functions/src/lib/coverage.ts) — kept inline so this types
// file stays free of edge-runtime imports.
export interface PublicCoverageRecord {
  garment_category: string;
  // Zones this garment type legitimately has — the coverage denominator.
  applicable_zones: string[];
  covered_zones: string[];
  // applicable_zones that no submitted photo documented (out of grade scope).
  missing_zones: string[];
  // covered / applicable, 0–100, whole percent.
  coverage_pct: number;
  coverage_source?: "photos_2d" | "geometric_360";
}

export interface DisputeRow {
  id: string;
  grade_report_id: string;
  user_id: string;
  reason: string;
  status: DisputeStatus;
  resolution_notes: string | null;
  // US-1416: storage paths (submission-images bucket) of the evidence photos the
  // filer attached. Reviewers sign these via the admin evidence endpoint.
  evidence_paths: string[];
  created_at: string;
  updated_at: string;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  last_used_at: string | null;
  expires_at: string | null;
  webhook_url: string | null;
  created_at: string;
}

export interface InventoryItemRow {
  id: string;
  user_id: string;
  title: string;
  brand: string | null;
  garment_type: GarmentType | null;
  garment_category: GarmentCategory | null;
  size: string | null;
  color: string | null;
  acquired_price: number | null;
  acquired_date: string | null;
  acquired_source: string | null;
  condition_notes: string | null;
  status: ItemStatus;
  submission_id: string | null;
  grade_report_id: string | null;
  // FlipDesk extensions
  sku: string | null;
  item_category: ItemCategory | null;
  source_id: string | null;
  target_price: number | null;
  location_bin: string | null;
  measurements: Record<string, number | string> | null;
  material: string | null;
  grade_value: number | null;
  grade_label: string | null;
  certificate_url: string | null;
  // Tracking fields (mirror user's Google Sheet)
  container: string | null;
  style: string | null;
  description: string | null;
  sourced_by: string | null;
  comp_set: ItemComp[];
  // AI enrichment (US-158)
  ai_field_sources: Record<string, AiFieldSource>;
  ai_enriched_at: string | null;
  // US-821: canonical listing attributes captured in the single AI extract
  // pass. Lowercase snake_case key -> value (string) or values (string[] for
  // multi attrs like `features`). NOT eBay aspect names — US-822 maps these to
  // per-category eBay aspects. condition_summary + ebay_category_query were
  // previously extracted but dropped; now persisted (migration 00182).
  attributes: CanonicalAttributes;
  condition_summary: string | null;
  ebay_category_query: string | null;
  // eBay taxonomy mapping (migration 00030)
  ebay_category_id: string | null;
  ebay_aspects: Record<string, string[]> | null;
  // US-1475 (migration 00328): adopted eBay Catalog product (EPID); sent in the
  // inventory-item product block at publish to auto-fill required specifics.
  ebay_epid: string | null;
  // US-825 (migration 00184): per-aspect provenance parallel to ebay_aspects —
  // { aspectName: "ai_extracted" | "inventory_derived" | "manual" }.
  ebay_aspect_sources: Record<string, string> | null;
  // AutoLister: when listing fields were last AI-generated (migration 00052)
  ai_generated_aspects_at: string | null;
  // AI photo-QA readiness (US-537, migration 00090)
  photo_qa_score: number | null;
  photo_qa_issues: PhotoQaIssue[] | null;
  photo_qa_at: string | null;
  // Per-listing automation override (US-150, migration 00135)
  exclude_from_automations: boolean;
  // US-538: opt-in — AutoLister auto-attaches AI defect-callout photos
  // composited from the verified grade report (migration 00152).
  annotate_defect_photos: boolean;
  // US-600: consignment mode. consignor_id set ⇒ item is consigned.
  // consignment_split_pct snapshots the split at intake (null ⇒ use consignor's).
  consignor_id: string | null;
  consignment_split_pct: number | null;
  created_at: string;
  updated_at: string;
}

// US-537: one issue the photo-QA vision pass found with an item's photos.
export interface PhotoQaIssue {
  type:
    | "blurry"
    | "dark"
    | "overexposed"
    | "cropped"
    | "low_resolution"
    | "cluttered_background"
    | "glare"
    | "tag_unreadable"
    | "missing_angle"
    | "other";
  severity: "low" | "medium" | "high";
  message: string;
  // 1-based index of the offending photo, or null for set-level issues
  // (e.g. a missing back/tag shot).
  photo_index?: number | null;
}

export interface AiFieldSource {
  source: string; // e.g. "text", "photo:tag", "photo:front"
  confidence: number; // 0..1
  accepted: boolean;
}

// US-821: canonical listing attributes persisted on inventory_items.attributes
// (jsonb). Single-value attributes store a scalar string; multi attributes
// (currently only `features`) store a string[]. Keys are canonical lowercase
// snake_case — the per-category eBay aspect mapping happens downstream (US-822).
export type CanonicalAttributes = Record<string, string | string[]>;

// The canonical attribute keys the AI extract pass can capture (US-821).
export const CANONICAL_ATTRIBUTE_KEYS = [
  "department",
  "size_type",
  "sleeve_length",
  "neckline",
  "pattern",
  "fit",
  "closure",
  "features",
  "garment_care",
  "country_of_manufacture",
  "vintage",
  "theme",
  "mpn",
] as const;
export type CanonicalAttributeKey = (typeof CANONICAL_ATTRIBUTE_KEYS)[number];

// Only `features` is multi-valued; every other canonical attribute is single.
export const MULTI_ATTRIBUTE_KEYS: readonly CanonicalAttributeKey[] = [
  "features",
];

// US-766: how the Digital Slab (QR-bearing graded photo) is attached to a
// listing's marketplace images. 'off' = not attached; 'hero' = lead image;
// 'extra' = supplementary image.
export type SlabImageMode = "off" | "hero" | "extra";

/**
 * US-2675: where a mined demand term's evidence came from.
 *
 * `sold` means the term was over-represented in the titles of items that
 * actually sold; `active` means it came only from what other sellers are
 * currently asking. Only the first is buyer demand, which is the whole reason
 * the distinction is stored rather than inferred.
 *
 * US-2683 added `ebay_search`, which outranks both: a query a buyer actually
 * TYPED against this seller's own items, from eBay's Promoted Listings report.
 * Sold titles are still seller writing weighted by outcome; this is not an
 * inference at all.
 */
export type DemandTermSource = "ebay_search" | "sold" | "active";

export interface DemandTermDetail {
  term: string;
  /** How many titles in the corpus named by `source` carried the term. */
  count: number;
  source: DemandTermSource;
  /**
   * Sold-versus-active frequency lift; 1 means equally common in both. Absent
   * when there were too few sold comps to divide by, in which case `source` is
   * "active" for every term.
   */
  lift?: number;
}

/**
 * US-2956: which kind of description block a `DescriptionBlock` is.
 *
 * The kind decides who owns the content. `intro`/`features`/`condition` are
 * written by the AI and edited by the seller; `attributes`/`measurements`/
 * `grade`/`disclosure`/`credentials`/`facts` are DERIVED at render time and
 * store no text, which is what makes them impossible to drift from the fields
 * they show; `snippet` points at a `listing_snippets` row; `text` is one-off
 * typing (and is what a legacy description parses into).
 */
export type DescriptionBlockKey =
  | "intro"
  | "features"
  | "condition"
  | "attributes"
  | "measurements"
  | "grade"
  | "disclosure"
  | "credentials"
  | "facts"
  | "snippet"
  | "text";

/** Who owns a block's content. Mirrors the table in the US-2956 design doc. */
export type DescriptionBlockSource =
  | "ai"
  | "item"
  | "grade"
  | "seller"
  | "system"
  | "account"
  | "user";

/**
 * One entry of `listings.description_blocks` (migration 00678).
 *
 * Array order is render order, with one exception the renderer enforces: the
 * `facts` block is always emitted last, because US-2682 needs it at a fixed
 * position for revise-in-place to replace it rather than accumulate a copy.
 */
export interface DescriptionBlock {
  key: DescriptionBlockKey;
  /** Off blocks keep their position so toggling back on restores the order. */
  on: boolean;
  src: DescriptionBlockSource;
  /** Free-form content. Absent on derived blocks; on `snippet` it overrides the referenced body. */
  text?: string | null;
  /** `attributes` only: which item columns to show, in order. */
  fields?: string[];
  /** `measurements` only: the length unit to render (US-648). */
  unit?: "in" | "cm";
  /** `snippet` only: the `listing_snippets.id` this block renders. */
  ref?: string | null;
  /**
   * US-2957: the exact bytes that precede this block in the rendered output.
   * Defaults to "\n\n". A legacy parse records what was really there, which is
   * what lets convert-on-open reproduce a live description byte for byte
   * instead of silently renormalising its whitespace.
   */
  sep?: string;
}

export interface ListingRow {
  id: string;
  inventory_item_id: string;
  // Denormalized owning tenant (= inventory_items.user_id), kept in sync by the
  // set_listings_tenant trigger (US-410, migration 00146).
  user_id: string;
  platform: ListingPlatform;
  platform_listing_id: string | null;
  listing_url: string | null;
  listing_price: number;
  // US-2727: NULL for a draft -- a row the extension prefilled but the seller
  // has not published. Migration 00634 dropped the NOT NULL to match what the
  // code has written since US-1877; this type still claimed non-null, which is
  // how a null would have reached `new Date(...)` unguarded.
  listed_at: string | null;
  is_active: boolean;
  notes: string | null;
  // FlipDesk extensions
  listing_title: string | null;
  listing_description: string | null;
  // US-2956 (migration 00678): the ordered blocks `listing_description` is
  // RENDERED FROM. NULL means this listing predates blocks, which is the signal
  // to parse the legacy string on open. The rendered column survives because
  // full-text search (00016), fuzzy search (00248) and return attribution
  // (00655) all read it.
  description_blocks: DescriptionBlock[] | null;
  // US-546: high-demand eBay search terms mined from live comps (migration
  // 00154). Fed into the title/description prompt and the US-1892 title meter's
  // pack-to-80 chips.
  demand_terms: string[] | null;
  // US-2675 (migration 00621): the same terms with provenance, ranked. `source`
  // says whether the term was over-represented among items that SOLD or came
  // only from active listings. NULL on drafts generated before this shipped,
  // which means "unknown", not "active".
  demand_terms_detail: DemandTermDetail[] | null;
  listing_status: ListingStatus;
  watchers: number;
  views: number;
  // Listing-composer picks (migration 00027)
  primary_photo_id: string | null;
  badge_enabled: boolean;
  // US-766: Digital-Slab image mode (migration 00180). 'off' | 'hero' |
  // 'extra' — attach the QR-bearing graded photo as lead or supplementary.
  slab_image_mode: SlabImageMode;
  // eBay handles (migrations 00031, 00034)
  platform_offer_id: string | null;
  platform_category_id: string | null;
  // AutoLister draft + publish fields (migration 00052)
  batch_id: string | null;
  // US-1568 (00349): when a human reviewed this draft (composer / bulk-edit
  // save); null = still in the AutoLister needs-review queue. Cleared when a
  // regeneration overwrites the draft.
  reviewed_at: string | null;
  scheduled_publish_at: string | null;
  publish_error: string | null;
  publish_failed_at: string | null;
  ebay_condition: string | null;
  ebay_condition_description: string | null;
  item_specifics_override: Record<string, string[]> | null;
  // US-825 (migration 00184): per-aspect provenance parallel to
  // item_specifics_override — { aspectName: "ai_extracted" | "inventory_derived" | "manual" }.
  item_specifics_sources: Record<string, string> | null;
  // US-828 (migration 00186): per-aspect needs-review list from generation-time
  // reconciliation — aspects whose name or value couldn't be matched to the eBay
  // category spec (and were kept, not dropped). NULL = nothing flagged.
  aspect_review: AspectReviewEntry[] | null;
  // US-2424 (migration 00540): the eBay leaf categories AutoLister weighed when
  // it picked this draft's category, best-first (element 0 is the chosen one),
  // with the required-aspect score behind each. Lets the composer offer a
  // one-click switch to the runner-up without a fresh AI run. NULL when the item
  // already had a category, so nothing was chosen.
  category_candidates: ListingCategoryCandidate[] | null;
  // US-2425 (migration 00541): how complete this draft's item specifics were at
  // generation time. Required and recommended are kept SEPARATE — a required
  // gap blocks the publish, a recommended one only costs search placement.
  aspect_coverage: ListingAspectCoverage | null;
  return_policy_id: string | null;
  shipping_policy_id: string | null;
  payment_policy_id: string | null;
  quantity: number;
  best_offer_enabled: boolean;
  // US-562 / US-2405: per-listing best-offer auto-clear thresholds (cents), set
  // by the seller by hand. NULL → no threshold; the offer waits for them.
  best_offer_auto_accept_cents: number | null;
  best_offer_auto_decline_cents: number | null;
  synced_to_ebay_at: string | null;
  price_is_estimated: boolean;
  // US-542: comp-derived price range + confidence + source. price_comp_source
  // is one of: 'ai_estimate' | 'active_asking' | 'private_sales' | 'ebay_sold'.
  // price_is_estimated is false only for the sold-backed sources.
  price_range_low_cents: number | null;
  price_range_high_cents: number | null;
  price_confidence: number | null;
  price_comp_source: string | null;
  // Per-field winning source for cross-source sync conflicts, e.g.
  // {"price": "flipdesk"} (US-148, migration 00133). A field pinned to a
  // non-eBay source is protected from the eBay pull's default overwrite.
  source_of_truth: Record<string, string>;
  // US-1077 (migration 00232): provenance marker. 'gradethread' = published from
  // FlipDesk (GradeThread is source of truth, eBay pull mirrors only read-only
  // signals); 'ebay' = imported/matched from eBay (eBay is source of truth, full
  // mirror, eBay-owned fields locked in the editor). Drives sync direction + the
  // UI editing badge. Supersedes the deprecated source_of_truth pin (US-148).
  // See vault/20-domain/sync-source-of-truth.md.
  listing_origin: ListingOrigin;
  // Cross-listing group key (US-149, migration 00134): siblings created by a
  // multi-marketplace push share the source draft's id; the source draft
  // points at itself.
  draft_id: string | null;
  // Promoted Listings ad rate (US-150, migration 00135). promo_rate_pct is the
  // seller's accepted/adjusted ad rate (%); null falls back to the category
  // suggestion at publish. The rest (US-561, migration 00157) is the eBay-side
  // ad state surfaced post-publish.
  promo_rate_pct: number | null;
  // US-561: per-listing opt-out from Promoted Listings; eBay campaign/ad handles
  // created at publish; lifecycle status ('active'|'failed'|eBay's adStatus);
  // accrued ad spend (cents, charged only on sale); last performance sync.
  promo_opt_out: boolean;
  // 00432: tri-state per-listing promotion override — NULL inherits the seller
  // default users.promote_listings_by_default, true/false is explicit. Publish
  // uses promote_override ?? seller default (promotion is off by default).
  promote_override: boolean | null;
  // US-1447 (migration 00330): 'cps' (Cost-Per-Sale, default) or 'cpc'
  // (Cost-Per-Click / Priority) Promoted Listings mode for this listing.
  promo_mode: string;
  promo_campaign_id: string | null;
  promo_ad_id: string | null;
  promo_status: string | null;
  promo_ad_fees_cents: number;
  promo_synced_at: string | null;
  // Listing-performance metrics from Sell Analytics getTrafficReport
  // (US-151, migration 00136), synced every 6h. view_trend_7d is a rolling
  // per-day array of views snapshots (oldest→newest, max 7) for the sparkline.
  views_total: number;
  watchers_count: number;
  impressions_7d: number;
  click_through_rate: number | null;
  last_metrics_synced_at: string | null;
  view_trend_7d: Array<{ date: string; views: number }>;
  // US-547/US-551: snapshot of the AI's generated fields at draft time. Stays
  // immutable as the seller edits the live columns, so the composer + bulk grid
  // can diff edited-vs-AI and offer a per-field revert-to-AI. Null for listings
  // that were never AI-generated (manual drafts).
  ai_generated_snapshot: ListingAiSnapshot | null;
  // US-568: listing format + auction terms + variation matrix. listing_format
  // is 'fixed_price' (default) or 'auction'; the auction price columns are cents
  // and only consulted when the format is 'auction'. variations is the
  // multi-variant matrix (null/empty → single-SKU listing).
  listing_format: ListingFormat;
  auction_start_price_cents: number | null;
  auction_reserve_price_cents: number | null;
  auction_buy_it_now_price_cents: number | null;
  auction_duration: string | null;
  variations: ListingVariations | null;
  // US-889: admin moderation takedown marker (migration 00213). An operator
  // unpublish sets this true (alongside is_active=false, listing_status='ended');
  // the audited restore endpoint flips it back. Default false.
  moderation_hidden: boolean;
  // US-1422 (migration 00326): eBay Listing Health — open Sell Compliance
  // violations for this listing, populated by the /compliance/sync job.
  compliance_violation_count: number;
  compliance_types: string[] | null;
  compliance_checked_at: string | null;
  // ── US-2177: sixteen columns that existed in the schema and not here ──────
  //
  // This interface had drifted 16 columns behind `listings`, and several of the
  // missing ones are heavily used. That is worse than an untyped field: code
  // reading them had to cast, so the cast — not the schema — became the source
  // of truth, and a column rename in a migration produced no tsc error anywhere.
  // src/test/listing-row-schema-parity.test.ts now fails when the two diverge.
  //
  // US-1892 (00154): A/B title testing. `title_variants` is the variant array
  // and `active_title_variant` names which one is live ('A' by default).
  title_variants: TitleVariantRow[] | null;
  active_title_variant: string | null;
  // US-547 (00088): the AI's own confidence in a generated draft. `ai_confidence`
  // is the overall 0–1 score; `ai_field_confidence` is per-field. `needs_review`
  // is the flag those feed — the AutoLister queue reads it, so a draft that
  // silently lost it would publish without ever being looked at.
  ai_confidence: number | null;
  ai_field_confidence: Record<string, number> | null;
  needs_review: boolean;
  // US-556 (00155): which prompt version produced this draft, for the
  // acceptance-rate comparison the prompt lifecycle gates on.
  ai_prompt_version: string | null;
  // US-1875 (00177): a delist was ASKED FOR. It stays set until the Lister
  // extension confirms the takedown, which is the whole point — the listing is
  // still live in the meantime and must not read as ended.
  delist_requested_at: string | null;
  // US-2145 (00477): the seller-facing SKU carried onto the marketplace listing.
  inventory_sku: string | null;
  // US-1466 (00338): which marketplace_connections row published this listing.
  // Null for rows that predate the column or were never published.
  marketplace_connection_id: string | null;
  // US-141 (00113): per-platform fields that do not deserve a column of their
  // own, plus when they were generated. The Poshmark/Mercari markers the
  // cross-listing alerts read live in here.
  platform_fields: Record<string, unknown> | null;
  platform_fields_generated_at: string | null;
  // US-1552 (00086): the publish-worker lease. A non-null value means a worker
  // holds this row; the reclaim compares it against the stale threshold.
  publish_claimed_at: string | null;
  // US-2170 (00476): the listing quality score and its block flag. Publishing
  // is refused while `quality_blocked` is true.
  quality_score: number | null;
  quality_blocked: boolean | null;
  quality_scored_at: string | null;
  //
  // NOT here on purpose: `search_vec`. It is a tsvector maintained by a trigger
  // and consumed only by a GIN index — Postgres is its only reader. Typing it
  // would invite a client `select` that ships a large internal blob for nothing.
  // The parity guard carries it as a declared exemption.
  created_at: string;
  updated_at: string;
}

/** One entry in `listings.title_variants` (US-1892, migration 00154). */
export interface TitleVariantRow {
  title?: string;
  [k: string]: unknown;
}

// US-828: one aspect (or set of values) the generation-time reconciliation
// couldn't match to the eBay category spec. `unknown_aspect` = the aspect name
// isn't in the category; `unmatched_value` = a SELECTION_ONLY value not in the
// allowed set even after US-823 normalization. The values are KEPT on the draft
// (in item_specifics_override) so the seller can fix them before publish.
export interface AspectReviewEntry {
  aspect: string;
  values: string[];
  reason: "unknown_aspect" | "unmatched_value";
}

// US-2424: one eBay leaf AutoLister weighed before choosing this draft's
// category. `rank` is eBay's own suggestion position, kept so a re-rank is
// explainable; the requiredFilled/requiredTotal pair is the deterministic score
// that decided it (how much of the leaf's REQUIRED specifics the item can
// already satisfy). Mirrors CategoryCandidateScore on the edge.
export interface ListingCategoryCandidate {
  categoryId: string;
  categoryPath: string | null;
  rank: number;
  requiredFilled: number;
  requiredTotal: number;
  requiredMissing: string[];
}

// US-2425: one tier of eBay-aspect coverage for a generated draft.
export interface ListingAspectCoverageTier {
  filled: number;
  total: number;
  /** The unfilled aspect names — ranked by buyer search volume for the
   *  recommended tier, in category-spec order for the required one. */
  missing: string[];
}

// US-2425: the draft's item-specifics completeness at generation time. Mirrors
// DraftAspectCoverage on the edge. The two tiers stay separate because they
// mean different things: a required gap BLOCKS the publish, a recommended gap
// only costs search placement.
export interface ListingAspectCoverage {
  categoryId: string | null;
  required: ListingAspectCoverageTier;
  recommended: ListingAspectCoverageTier;
  computedAt: string;
}

// US-1077: listing provenance. Mirrors the listings.listing_origin enum.
export type ListingOrigin = "gradethread" | "ebay";

// US-568: eBay offer format. Mirrors listings.listing_format.
export type ListingFormat = "fixed_price" | "auction";

// US-568: one variant of a multi-variant listing. aspects names the
// variation values (e.g. {"Size":"M","Color":"Red"}); quantity is per-variant
// stock; price_cents optionally overrides the listing price for this variant;
// sku_suffix is appended to the base SKU when publishing (derived from the
// aspects when omitted).
export interface ListingVariation {
  aspects: Record<string, string>;
  quantity: number;
  price_cents?: number | null;
  sku_suffix?: string | null;
}

// US-568: shape of listings.variations. specifications are the varies-by
// aspect names (e.g. ["Size", "Color"]); variants enumerates the combinations.
export interface ListingVariations {
  specifications: string[];
  variants: ListingVariation[];
}

// US-551: shape of listings.ai_generated_snapshot (written in ai-listing.ts).
export interface ListingAiSnapshot {
  title?: string | null;
  description?: string | null;
  price_cents?: number | null;
  ebay_condition?: string | null;
  condition_description?: string | null;
  category_id?: string | null;
  item_specifics?: Record<string, string[]> | null;
}

export interface SaleRow {
  id: string;
  inventory_item_id: string;
  // Denormalized owning tenant (= inventory_items.user_id), kept in sync by the
  // set_sales_tenant trigger (US-410, migration 00146).
  user_id: string;
  listing_id: string | null;
  sale_price: number;
  platform_fees: number;
  sale_date: string;
  buyer_username: string | null;
  buyer_notes: string | null;
  // FlipDesk extensions
  shipping_collected: number;
  payment_processing_fees: number;
  shipping_cost: number;
  grading_cost: number;
  other_costs: number;
  net_profit: number | null;
  buyer_id: string | null;
  sold_at: string | null;
  shipped_at: string | null;
  tracking_number: string | null;
  // US-960: shipping carrier (USPS/UPS/…) + delivery timestamp for the
  // Shipped-tab fulfillment flow (00250).
  carrier: string | null;
  delivered_at: string | null;
  payout_reference: string | null;
  tax: number;
  payout_amount: number | null;
  // Sale lifecycle (00111). Only 'completed' counts toward revenue/profit/sold.
  status: "completed" | "cancelled" | "refunded" | "pending";
  cancelled_at: string | null;
  // Marketplace order/fulfillment identifiers for API sales (US-714, 00176) —
  // e.g. { platform: 'depop', purchase_id, parcel_id } for mark-as-shipped.
  platform_order_ref: Record<string, unknown> | null;
  created_at: string;
}

// ─── FlipDesk rows ─────────────────────────────────────────────────

export interface SourceRow {
  id: string;
  user_id: string;
  name: string;
  source_type: FlipdeskSourceType;
  location: string | null;
  notes: string | null;
  // US-1864 (00553): the shared Thrift Radar venue this source IS, once the owner
  // has linked them. This column is the JOIN that lets a store's money (items,
  // spend, sales) meet its visits — set through the edge, never written here.
  radar_venue_id: string | null;
  created_at: string;
  updated_at: string;
}

// US-2886 (00672): the per-workspace roster of PEOPLE who source inventory.
// Feeds the "Sourced by" picker; inventory_items.sourced_by still stores the
// chosen NAME as text, so iOS/Android/CSV/Sheets keep working unchanged.
export interface SourcerRow {
  id: string;
  user_id: string;
  name: string;
  // The real user this entry IS, when it is one. NULL for people who are not
  // users of the workspace (a spouse, a picker, "Joint").
  member_user_id: string | null;
  // Set = hidden from the pickers. Historical sourced_by text is untouched.
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

// US-600: consignment mode. Base table from 00107 (US-676); the status /
// Stripe-Connect / intake columns are added in 00171.
export interface ConsignorRow {
  id: string;
  user_id: string;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
  default_split_pct: number;
  notes: string | null;
  // 00171 web-portal additions.
  status: ConsignorStatus;
  stripe_connect_account_id: string | null;
  payouts_enabled: boolean;
  intake_signed_at: string | null;
  intake_signature_name: string | null;
  intake_agreement_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConsignorInsert {
  user_id: string;
  name: string;
  contact_email?: string | null;
  contact_phone?: string | null;
  default_split_pct?: number;
  status?: ConsignorStatus;
  notes?: string | null;
}

export type ConsignorUpdate = Partial<
  Omit<ConsignorRow, "id" | "user_id" | "created_at" | "updated_at">
>;

export interface ConsignorPnlRow {
  consignor_id: string;
  user_id: string;
  name: string;
  default_split_pct: number;
  status: ConsignorStatus;
  payouts_enabled: boolean;
  total_items: number;
  items_sold: number;
  gross_revenue: number;
  net_proceeds: number;
  consignor_share: number;
  store_share: number;
  payouts_paid: number;
  payouts_pending: number;
  balance_owed: number;
  // US-1123: reconciled-payout transparency. consignor_share / net_proceeds now
  // use the real reconciled marketplace payout when a sale is matched, falling
  // back to the estimate when unreconciled. estimated_* mirror the pre-reconciled
  // numbers and *_delta = actual − estimate so over/under-payments are visible.
  items_reconciled: number;
  items_unreconciled: number;
  estimated_net_proceeds: number;
  reconciled_net_proceeds: number;
  estimated_consignor_share: number;
  net_proceeds_delta: number;
  consignor_share_delta: number;
}

export interface ConsignorPayoutRow {
  id: string;
  user_id: string;
  consignor_id: string;
  sale_id: string | null;
  inventory_item_id: string | null;
  amount: number;
  status: ConsignorPayoutStatus;
  stripe_transfer_id: string | null;
  note: string | null;
  error: string | null;
  paid_at: string | null;
  // US-1123: id of the reconciled payout_imports row this payout is backed by,
  // back-filled by reconciliation. NULL while the sale is unreconciled.
  payout_reference: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConsignorPayoutInsert {
  user_id: string;
  consignor_id: string;
  sale_id?: string | null;
  inventory_item_id?: string | null;
  amount: number;
  status?: ConsignorPayoutStatus;
  note?: string | null;
}

export type ConsignorPayoutUpdate = Partial<
  Omit<ConsignorPayoutRow, "id" | "user_id" | "consignor_id" | "created_at" | "updated_at">
>;

export interface ItemPhotoRow {
  id: string;
  inventory_item_id: string;
  photo_url: string;
  storage_path: string | null;
  photo_type: FlipdeskPhotoType;
  // US-2462 (migration 00587): open-text qualifier saying what the photo shows
  // — 'fabric' on a detail, 'size' on a tag, 'inseam' on a measurement. NULL
  // means no qualifier. Deliberately unconstrained in the DB; the vocabulary
  // lives in src/lib/photo-roles.ts so a new role costs no migration.
  photo_role: string | null;
  sort_order: number;
  used_for_grading: boolean;
  ebay_uploaded: boolean;
  archived_to_r2: boolean;
  created_at: string;
  // 00035 — thumbnails generated client-side at upload time.
  thumbnail_url: string | null;
  thumbnail_storage_path: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  // 00066 — photo-dump reconciliation: original EXIF capture time + session.
  captured_at: string | null;
  reconcile_session_id: string | null;
  // 00339 (US-1539) — photo provenance: the source file's original name
  // (e.g. "IMG_0551.jpg"), the durable signal for filename-sequence grouping
  // (US-1540) and grouping audits. Never rendered on public surfaces.
  original_filename: string | null;
  // US-889 (migration 00213): admin moderation marker. A hide sets this true so
  // the photo is withheld from public/marketplace surfaces; the audited unhide
  // endpoint flips it back. Default false.
  is_hidden: boolean;
  // US-2208 (migration 00495): non-destructive editing. `original_storage_path`
  // holds the pristine pre-edit file, copied aside once on the first save; NULL
  // means the photo has never been edited and `storage_path` IS the original.
  // `edit_recipe` is the geometry + tone that derived the current image — see
  // PhotoEditRecipe in src/lib/photo-edit-recipe.ts.
  original_storage_path: string | null;
  edit_recipe: unknown | null;
}

// US-889: reusable moderation queue row for listings + item_photos. Operator-only
// (service-role; deny-all RLS) — mirrors public.content_moderation_flags (00213).
export type ModerationContentType = "listing" | "photo";
export type ModerationFlagStatus = "open" | "resolved" | "dismissed";

export interface ContentModerationFlagRow {
  id: string;
  content_type: ModerationContentType;
  content_id: string;
  owner_user_id: string | null;
  reason: string;
  source: string;
  status: ModerationFlagStatus;
  flagged_by: string | null;
  resolved_by: string | null;
  resolution_action: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ReconcileSessionStatus = "open" | "committed" | "abandoned";

// One entry of the persisted assignment snapshot (00067) — enough to restore
// the cluster grouping on reload. Photo blobs themselves are re-bound client-side.
export interface ReconcileAssignmentSnapshot {
  id: string;
  capturedAt: string | null;
  name: string;
  clusterId: string | null;
  manual: boolean;
  // US-289: when a photo was staged by the iOS app (uploaded to storage before
  // an item exists), this points at the already-uploaded blob in the
  // `item-photos` bucket. The web board hydrates a preview from it on restore
  // and, at commit, references the existing object instead of re-uploading.
  // Absent for browser-staged photos whose blob lives only in memory.
  storagePath?: string | null;
  photoType?: FlipdeskPhotoType | null;
  // US-2461: the `item_photos.photo_role` qualifier the seller picked on the
  // board. Optional so a session snapshot written before this shipped restores
  // with a null role rather than failing to parse.
  photoRole?: string | null;
}

export interface ReconcileSessionRow {
  id: string;
  user_id: string;
  photo_count: number;
  status: ReconcileSessionStatus;
  assignments: ReconcileAssignmentSnapshot[];
  gap_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface ReconcileSessionInsert {
  user_id: string;
  photo_count?: number;
  status?: ReconcileSessionStatus;
  assignments?: ReconcileAssignmentSnapshot[];
  gap_seconds?: number;
}

export type ReconcileSessionUpdate = Partial<
  Omit<ReconcileSessionRow, "id" | "user_id" | "created_at" | "updated_at">
>;

export interface MarketplaceConnectionRow {
  id: string;
  user_id: string;
  marketplace: ListingPlatform;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  account_handle: string | null;
  // 00140: marketplace-stable account id (eBay /commerce/identity userId), used
  // to match account-deletion webhooks on a verified id, not the handle (US-364).
  external_account_id: string | null;
  scopes: string[];
  is_active: boolean;
  last_synced_at: string | null;
  last_refresh_attempt_at: string | null;
  refresh_error: string | null;
  // 00054: cached default Sell Inventory location key (US-314).
  merchant_location_key: string | null;
  // 00136: set when getTrafficReport 403s for missing Sell Analytics access
  // (US-151) so the UI can prompt a reconnect to enable performance metrics.
  analytics_access_denied: boolean;
  created_at: string;
  updated_at: string;
}

// AutoLister batch generation (migration 00052)
export interface ListingGenerationBatchRow {
  id: string;
  user_id: string;
  status: ListingGenerationStatus;
  source: ListingGenerationSource;
  item_count: number;
  succeeded_count: number;
  failed_count: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListingGenerationBatchInsert {
  user_id: string;
  status?: ListingGenerationStatus;
  source?: ListingGenerationSource;
  item_count?: number;
  succeeded_count?: number;
  failed_count?: number;
  error?: string | null;
}

export type ListingGenerationBatchUpdate = Partial<
  Omit<ListingGenerationBatchRow, "id" | "user_id" | "created_at" | "updated_at">
>;

export interface ListingGenerationJobRow {
  id: string;
  batch_id: string;
  inventory_item_id: string;
  status: ListingGenerationJobStatus;
  error: string | null;
  attempts: number;
  listing_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListingGenerationJobInsert {
  batch_id: string;
  inventory_item_id: string;
  status?: ListingGenerationJobStatus;
  error?: string | null;
  attempts?: number;
  listing_id?: string | null;
}

export type ListingGenerationJobUpdate = Partial<
  Omit<ListingGenerationJobRow, "id" | "batch_id" | "inventory_item_id" | "created_at">
>;

export interface BusinessPolicyRow {
  id: string;
  user_id: string;
  marketplace: ListingPlatform;
  policy_id: string;
  policy_type: BusinessPolicyType;
  policy_name: string | null;
  policy_data: Record<string, unknown> | null;
  is_default: boolean;
  synced_from_ebay_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessPolicyInsert {
  user_id: string;
  marketplace: ListingPlatform;
  policy_id: string;
  policy_type: BusinessPolicyType;
  policy_name?: string | null;
  policy_data?: Record<string, unknown> | null;
  is_default?: boolean;
  synced_from_ebay_at?: string | null;
}

export type BusinessPolicyUpdate = Partial<
  Omit<BusinessPolicyRow, "id" | "user_id" | "created_at" | "updated_at">
>;

export interface PayoutImportRow {
  id: string;
  user_id: string;
  marketplace: ListingPlatform;
  import_method: PayoutImportMethod;
  raw_payload: Record<string, unknown>;
  reconciled: boolean;
  sale_id: string | null;
  payout_date: string | null;
  amount: number | null;
  created_at: string;
  updated_at: string;
}

// Read-only join of inventory_items + most-recent listing + sale.
// Backed by the items_full view (migration 00009).
export interface ItemFullRow {
  id: string;
  user_id: string;
  item_number: string | null;
  container: string | null;
  item_title: string;
  item_description: string | null;
  brand: string | null;
  style: string | null;
  size: string | null;
  notes: string | null;
  comps: ItemComp[];
  category: string | null;
  source_name: string | null;
  source_id: string | null;
  sourced_by: string | null;
  purchase_date: string | null;
  purchase_price: number | null;
  listed: boolean;
  list_date: string | null;
  link: string | null;
  list_price: number | null;
  sale_date: string | null;
  sale_price: number | null;
  fees: number | null;
  tax: number | null;
  shipping_cost: number | null;
  net_profit: number | null;
  payout: number | null;
  status: ItemStatus;
  days_to_sell: number | null;
  tracking: string | null;
  target_price: number | null;
  grade_value: number | null;
  grade_label: string | null;
  certificate_url: string | null;
  measurements: Record<string, number | string> | null;
  // US-2790 (migration 00650): the parcel estimator's inputs, exposed on the
  // items_full view so a per-item profit figure can count postage.
  //
  // ⚠ `category` above is NOT a substitute. It is
  // coalesce(item_category, garment_category), so it is a merchandising
  // category whenever one is set — passing it to estimateParcel hands a
  // merchandising value to a function expecting a garment type, falls through
  // to the `other` base weight, and still reports the number as
  // category-derived.
  garment_category: GarmentCategory | null;
  material: string | null;
  location_bin: string | null;
  created_at: string;
  updated_at: string;
  // Trailing columns added in migration 00012
  buyer_id: string | null;
  sold_at_raw: string | null;
  payout_reference: string | null;
  listing_status: ListingStatus | null;
  // Trailing columns added in migration 00013
  listing_id: string | null;
  listing_watchers: number | null;
  listing_views: number | null;
  // Trailing columns added in migration 00018
  photo_count: number;
  has_required_photos: boolean;
  // Trailing columns added in migration 00033 — AI provenance for fields
  // and prefixed measurement keys (measurements.<field>).
  ai_field_sources: Record<string, AiFieldSource> | null;
  ai_enriched_at: string | null;
  // Trailing columns added in migration 00111 — sale lifecycle. Null when the
  // item has no sale. Only 'completed' counts toward sold/revenue/profit.
  sale_status: "completed" | "cancelled" | "refunded" | "pending" | null;
  sale_cancelled_at: string | null;
  // Trailing columns added in migration 00249 — color (from inventory_items)
  // and the most-recent listing's marketplace, both used by the web advanced
  // filter (US-1051).
  color: string | null;
  listing_platform: ListingPlatform | null;
  // Trailing columns added in migration 00250 — Shipped-tab fulfillment, joined
  // from the most-recent sale (US-960). Null until the order is shipped.
  carrier: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  // US-1569 (00349): draft-review fields from the most-recent listing.
  listing_needs_review: boolean | null;
  listing_reviewed_at: string | null;
  listing_title: string | null;
  // US-2170 (00506): the persisted Listing Quality Score of the most-recent
  // listing, exposed on the row so the inventory table can sort by it.
  quality_score: number | null;
}

// ── Admin task / project management (00047) ──────────────────────────────
export type AdminTaskStatus = "todo" | "in_progress" | "blocked" | "done";
export type AdminTaskPriority = "low" | "medium" | "high";

export interface AdminTaskProjectRow {
  id: string;
  title: string;
  description: string | null;
  archived: boolean;
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminTaskProjectInsert {
  title: string;
  description?: string | null;
  archived?: boolean;
  position?: number;
}

export type AdminTaskProjectUpdate = Partial<
  Omit<AdminTaskProjectRow, "id" | "created_by" | "created_at" | "updated_at">
>;

export interface AdminTaskRow {
  id: string;
  project_id: string;
  title: string;
  body: string | null;
  section: string | null;
  status: AdminTaskStatus;
  priority: AdminTaskPriority;
  due_date: string | null;
  position: number;
  created_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminTaskInsert {
  project_id: string;
  title: string;
  body?: string | null;
  section?: string | null;
  status?: AdminTaskStatus;
  priority?: AdminTaskPriority;
  due_date?: string | null;
  position?: number;
  completed_at?: string | null;
}

export type AdminTaskUpdate = Partial<
  Omit<AdminTaskRow, "id" | "project_id" | "created_by" | "created_at" | "updated_at">
>;

export interface AdminTaskCommentRow {
  id: string;
  task_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
}

export interface AdminTaskCommentInsert {
  task_id: string;
  body: string;
}

export type AdminTaskCommentUpdate = Partial<Pick<AdminTaskCommentRow, "body">>;

export interface SavedViewRow {
  id: string;
  user_id: string;
  name: string;
  emoji: string | null;
  query_json: Record<string, unknown>;
  pinned: boolean;
  scope: string;
  created_at: string;
}

export interface SavedViewInsert {
  user_id: string;
  name: string;
  emoji?: string | null;
  query_json: Record<string, unknown>;
  pinned?: boolean;
  scope?: string;
}

export type SavedViewUpdate = Partial<
  Omit<SavedViewRow, "id" | "user_id" | "created_at">
>;

// US-2982 — the tax profile. One row per seller; the settings the whole Books
// and Taxes epic reads before it computes anything.
//
// There is deliberately no `ein` field. Whether the seller HAS one is all this
// app needs, and holding a nine-digit federal identifier turns the row into a
// breach target for nothing.
// US-2983 — the chart of accounts. `user_id IS NULL` is a seeded SYSTEM row,
// readable by everyone and writable by nobody through RLS; a row with a user_id
// is that seller's own sub-account under a system parent.
//
// The client-side mirror of the seeded rows lives in src/lib/chart-of-accounts.ts
// and is drift-guarded against migration 00684 by a test. Read labels from
// there; read a seller's own sub-accounts from here.
// US-2984 — the canonical record. Single-sided, signed INTEGER CENTS against
// one account; positive increases profit. NOT double-entry: no balance sheet,
// no owner draws, no loans. That limit is deliberate and is written up in
// vault/50-business/books-and-taxes.md rather than left to be discovered.
// US-2986 — a point-in-time inventory valuation for Schedule C Part III lines
// 35 and 41. Per-item costs are COPIED into inventory_snapshot_items, so a
// later edit to acquired_price cannot rewrite a year already filed.
//
// There is no Insert type on purpose: the table has no INSERT policy. Snapshots
// are created only by take_my_inventory_snapshot(), which counts the items
// itself. A record a user can hand-write is not a record.
// US-2987 — which platforms collect and remit sales tax as a marketplace
// facilitator, with effective dates.
//
// A table rather than a constant because facilitator law arrived state by state
// between 2018 and 2021 and platforms change their handling. NO rule for a
// platform on a date means SELLER-COLLECTED, which is the conservative answer:
// it books the tax INTO income rather than out of it, so a mistake overstates
// income rather than understating it.
//
// Reference data with no user_id: readable by everyone, writable by nobody.
// US-2988 — a 1099-K the seller received. One per platform per CALENDAR year;
// a 1099-K never follows a fiscal year.
export interface Form1099kRow {
  id: string;
  user_id: string;
  platform: string;
  tax_year: number;
  gross_cents: number;
  payer_name: string | null;
  // LAST FOUR DIGITS ONLY, enforced by a CHECK constraint. A payer's full TIN
  // is a federal identifier this app has no use for.
  payer_tin_last4: string | null;
  transaction_count: number | null;
  received_on: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
export type Form1099kInsert = Omit<Form1099kRow, "id" | "created_at" | "updated_at"> &
  Partial<Pick<Form1099kRow, "id" | "created_at" | "updated_at">>;
export type Form1099kUpdate = Partial<Form1099kInsert>;

export interface MarketplaceFacilitatorRuleRow {
  id: string;
  platform: string;
  /** NULL means everywhere. No state rule is seeded: `sales` carries no buyer state. */
  state: string | null;
  effective_from: string;
  effective_to: string | null;
  is_facilitator: boolean;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface InventorySnapshotRow {
  id: string;
  user_id: string;
  as_of: string;
  fiscal_label: string;
  total_cost_cents: number;
  item_count: number;
  // Stored beside the total because an unpriced item contributes zero, which
  // understates inventory and overstates the deduction.
  items_without_cost: number;
  reconstructed: boolean;
  created_at: string;
  updated_at: string;
}

export interface InventorySnapshotItemRow {
  id: string;
  snapshot_id: string;
  item_id: string | null;
  title: string | null;
  cost_cents: number | null;
  acquired_on: string | null;
}

export interface LedgerEntryRow {
  id: string;
  user_id: string;
  entry_date: string;
  account_id: string;
  amount_cents: number;
  currency: string;
  memo: string | null;
  source_kind:
    | "sale"
    | "expense"
    | "fee"
    | "shipping"
    | "payout"
    | "adjustment"
    | "cogs";
  // NULL only on a hand-entered adjustment, which is the one entry kind a human
  // authors directly -- and the only kind RLS lets the browser write.
  source_id: string | null;
  source_detail: string;
  created_at: string;
  updated_at: string;
}
export type LedgerEntryInsert = Omit<
  LedgerEntryRow,
  "id" | "created_at" | "updated_at" | "currency" | "source_detail"
> &
  Partial<LedgerEntryRow>;
export type LedgerEntryUpdate = Partial<LedgerEntryInsert>;

export interface LedgerAccountRow {
  id: string;
  user_id: string | null;
  code: string;
  name: string;
  flow: string;
  schedule_c_part: string | null;
  schedule_c_line: string | null;
  schedule_c_label: string | null;
  no_line_reason: string | null;
  parent_id: string | null;
  is_system: boolean;
  sort_order: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
}
export type LedgerAccountInsert = Omit<
  LedgerAccountRow,
  "id" | "created_at" | "updated_at" | "is_system" | "archived" | "sort_order"
> &
  Partial<LedgerAccountRow>;
export type LedgerAccountUpdate = Partial<LedgerAccountInsert>;

export interface TaxProfileRow {
  id: string;
  user_id: string;
  entity_type: string;
  accounting_method: string;
  fiscal_year_start_month: number;
  filing_state: string | null;
  filing_status: string;
  business_started_on: string | null;
  has_ein: boolean;
  other_household_income_cents: number | null;
  created_at: string;
  updated_at: string;
}
export type TaxProfileInsert = Omit<
  TaxProfileRow,
  "id" | "created_at" | "updated_at"
> &
  Partial<Pick<TaxProfileRow, "id" | "created_at" | "updated_at">>;
export type TaxProfileUpdate = Partial<TaxProfileInsert>;

// Append-only. Written by a trigger; there is no INSERT policy, so a user
// cannot author their own history.
export interface TaxProfileChangeRow {
  id: string;
  user_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
}

export interface ExpenseRow {
  id: string;
  user_id: string;
  category: ExpenseCategory;
  description: string | null;
  amount: number;
  spent_on: string;
  created_at: string;
  updated_at: string;
  // US-2228 AC2. `receipt_path` is an object key in the PRIVATE expense-receipts
  // bucket, never a URL — the browser cannot read it directly and must ask the
  // edge for a signed URL, which it only issues after an ownership check.
  receipt_path: string | null;
  receipt_mime: string | null;
  receipt_uploaded_at: string | null;
  // US-2228 AC3. `recurs_monthly` is true on the TEMPLATE only; the entries the
  // cron copies forward carry `recurrence_source_id` pointing back at it and
  // never repeat themselves (the DB refuses that combination outright).
  recurs_monthly: boolean;
  recurrence_source_id: string | null;
  // US-2983. NULL means "use the default account for this category", resolved
  // by CATEGORY_DEFAULT_ACCOUNT / public.default_account_for_category(). It is
  // never backfilled: an unset column and a column set to the default mean
  // different things, and only one of them was a decision the seller made.
  account_id: string | null;
}

export interface ExpenseInsert {
  user_id: string;
  category?: ExpenseCategory;
  description?: string | null;
  amount: number;
  spent_on?: string;
  recurs_monthly?: boolean;
}

export type ExpenseUpdate = Partial<
  Omit<ExpenseRow, "id" | "user_id" | "created_at" | "updated_at">
>;

// A snapshot of one eBay listing, imported from the eBay Active Listings CSV
// report. `custom_label` is eBay's "Custom label (SKU)" field. Backed by the
// flipdesk_ebay_listings table (migration 00020).
export type EbayMatchStatus = "matched" | "unmatched" | "ignored";

export interface EbayListingRow {
  id: string;
  user_id: string;
  ebay_item_id: string;
  custom_label: string | null;
  title: string | null;
  current_price: number | null;
  available_quantity: number | null;
  listing_url: string | null;
  listing_format: string | null;
  start_date: string | null;
  matched_item_id: string | null;
  match_status: EbayMatchStatus;
  raw: Record<string, unknown>;
  imported_at: string;
  created_at: string;
  updated_at: string;
}

export interface EbayListingInsert {
  user_id: string;
  ebay_item_id: string;
  custom_label?: string | null;
  title?: string | null;
  current_price?: number | null;
  available_quantity?: number | null;
  listing_url?: string | null;
  listing_format?: string | null;
  start_date?: string | null;
  matched_item_id?: string | null;
  match_status?: EbayMatchStatus;
  raw?: Record<string, unknown>;
  imported_at?: string;
}

export type EbayListingUpdate = Partial<
  Omit<EbayListingRow, "id" | "user_id" | "ebay_item_id" | "created_at" | "updated_at">
>;

// Per-user FlipDesk behavior settings (US-149, migration 00134). One row per
// user, created lazily on first write; absent row = all defaults.
export interface FlipdeskSettingsRow {
  user_id: string;
  auto_end_cross_listings: boolean;
  // Global default (migration 00145): burn the grade badge onto the hero photo
  // and append the certificate link to the description for graded listings.
  auto_grade_badge: boolean;
  // Global default (US-766, migration 00180): attach the QR-bearing Digital
  // Slab as a supplementary image on graded listings by default.
  auto_slab_image: boolean;
  // US-2721 (migration 00644): which marketplaces this seller cross-posts to.
  // NULL means ALL — the setting narrows what is offered and can never turn
  // cross-posting off. See src/lib/cross-post-channels.ts.
  cross_post_channels: string[] | null;
  // US-2777 (migration 00648): platform -> country-domain KEY, e.g.
  // {"vinted": "vinted.fr"}. NULL or a missing key means that platform's
  // default domain. Never a URL. See src/lib/lister-locales.ts.
  lister_locales: Record<string, string> | null;
  // US-2851 (migration 00666): target return on cost for the sourcing ceiling,
  // as whole percent. NULL means the product default (DECISION_MAYBE_ROI in the
  // edge's scout-decision.ts), which is also the threshold that decides whether
  // Scout calls an item a maybe.
  sourcing_target_roi_pct: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * US-2956 (migration 00678): a seller's standing description line, saved once.
 *
 * A listing's `snippet` block stores only the id, so editing the body here
 * changes what every listing referencing it renders, with no write to any
 * listing row.
 */
export interface ListingSnippetRow {
  id: string;
  user_id: string;
  /** Short label shown in the settings list and on the composer block row. */
  name: string;
  body: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ListingSnippetInsert {
  user_id: string;
  name: string;
  body: string;
  sort_order?: number;
}

export type ListingSnippetUpdate = Partial<
  Omit<ListingSnippetRow, "id" | "user_id" | "created_at" | "updated_at">
>;

export interface FlipdeskSettingsInsert {
  user_id: string;
  auto_end_cross_listings?: boolean;
  auto_grade_badge?: boolean;
  auto_slab_image?: boolean;
  cross_post_channels?: string[] | null;
  lister_locales?: Record<string, string> | null;
  sourcing_target_roi_pct?: number | null;
}

export type FlipdeskSettingsUpdate = Partial<
  Omit<FlipdeskSettingsRow, "user_id" | "created_at" | "updated_at">
>;

export interface FlipdeskGradingSubmissionRow {
  id: string;
  inventory_item_id: string;
  submission_id: string | null;
  gradethread_submission_id: string | null;
  tier: GradingSubmissionTier;
  status: SubmissionStatus;
  cost: number;
  submitted_at: string | null;
  graded_at: string | null;
  webhook_received_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShipmentRow {
  id: string;
  sale_id: string;
  carrier: string;
  tracking_number: string | null;
  shipping_cost: number;
  label_cost: number;
  ship_date: string | null;
  delivery_date: string | null;
  weight_oz: number | null;
  created_at: string;
  updated_at: string;
}

export interface AdminAuditLogRow {
  id: string;
  // Null for SYSTEM-originated entries (e.g. the content scheduler tick);
  // actor_role is 'system' in that case. (US-269)
  admin_user_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

// US-905: anomaly findings raised by the scheduled audit-log scan. Operator
// surface (service-role only); the SPA reads it via /api/admin/audit/anomalies.
export interface AdminAuditAnomalyRow {
  id: string;
  detector: string;
  severity: string;
  dedupe_key: string;
  actor_user_id: string | null;
  event_count: number;
  evidence: Record<string, unknown>;
  alerted: boolean;
  status: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
}

export interface HumanReviewRow {
  id: string;
  grade_report_id: string;
  reviewer_id: string;
  original_score: number;
  adjusted_score: number | null;
  // Optional per-factor corrections — null where the reviewer didn't change a
  // factor. Drives real per-factor accuracy (vs. estimating from overall).
  adjusted_fabric_condition: number | null;
  adjusted_structural_integrity: number | null;
  adjusted_cosmetic_appearance: number | null;
  adjusted_functional_elements: number | null;
  adjusted_odor_cleanliness: number | null;
  // Reviewer flag: AI mistook an intentional design feature for damage.
  intentional_misread: boolean;
  review_notes: string | null;
  reviewed_at: string;
}

export interface AiPromptVersionRow {
  id: string;
  version_name: string;
  prompt_text: string;
  is_active: boolean;
  accuracy_score: number | null;
  total_grades: number;
  // Which grading stage this prompt drives + optional category scope (00050).
  // listing_gen joined the stages for AutoLister listing prompts (US-547).
  stage: "per_image" | "composite" | "listing_gen";
  garment_scope: string | null;
  eval_passed: boolean | null;
  eval_run_id: string | null;
  notes: string | null;
  // US-896: staged rollout / canary %. A non-active, eval-passed challenger can
  // take `rollout_percentage`% of live grading traffic for its (stage, scope)
  // slot, bucketed by a stable per-submission hash, while is_canary is set.
  rollout_percentage: number;
  is_canary: boolean;
  rollout_started_at: string | null;
  created_at: string;
}

export interface GradingEvalCaseRow {
  id: string;
  label: string;
  garment_type: GarmentType;
  garment_category: GarmentCategory;
  brand: string | null;
  description: string | null;
  style_attributes: string[];
  images: Array<{ image_type: string; storage_path: string }>;
  expected_score: number;
  expected_tier: GradeTier;
  tags: string[];
  is_active: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface GradingEvalRunRow {
  id: string;
  prompt_version_id: string | null;
  prompt_version_name: string;
  model: string;
  mean_absolute_error: number;
  agreement_rate: number;
  cases_total: number;
  cases_passed: number;
  passed: boolean;
  per_case: unknown[];
  per_tag: Record<string, unknown>;
  triggered_by: string | null;
  created_at: string;
}

// US-308: Google Search Console search-performance ingestion.
// Admin-only — one row per (date, site_url, page, query, country, device).
export interface GscPerformanceRow {
  id: string;
  date: string;
  site_url: string;
  page: string | null;
  query: string | null;
  country: string | null;
  device: string | null;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  ingested_at: string;
}

export interface GscPerformanceInsert {
  date: string;
  site_url: string;
  page?: string | null;
  query?: string | null;
  country?: string | null;
  device?: string | null;
  impressions?: number;
  clicks?: number;
  ctr?: number;
  position?: number;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  link: string | null;
  is_read: boolean;
  created_at: string;
}

// ─── Insert types ──────────────────────────────────────────────────

export interface UserInsert {
  id: string;
  email: string;
  full_name?: string | null;
  avatar_url?: string | null;
  // US-1442: reseller business + ship-from profile (migration 00325).
  business_name?: string | null;
  // US-2417: NOT writable from a client. 00567 removed both from the users
  // self-update allowlist and only PUT /api/account/shipping-profile writes
  // them, encrypted. They stay on the type because the edge's service-role
  // client uses these shapes too; a browser write now RAISES.
  business_phone?: EncryptedColumn | null;
  ship_from_address?: EncryptedColumn | null;
  /** @deprecated kept for legacy compatibility; new code should not set this. */
  plan?: UserPlan;
  role?: UserRole;
  // US-1796: buyer/seller role flags (migration 00401).
  is_seller?: boolean;
  is_buyer?: boolean;
  stripe_customer_id?: string | null;
  flipdesk_plan?: FlipdeskPlan;
  flipdesk_interval?: BillingInterval | null;
  subscription_status?: SubscriptionStatus;
  flipdesk_subscription_id?: string | null;
  flipdesk_period_end?: string | null;
  flipdesk_pause_until?: string | null;
  flipdesk_cancel_at_period_end?: boolean;
  grade_credit_balance?: number;
  trial_ends_at?: string | null;
  pending_flipdesk_plan?: FlipdeskPlan | null;
  pending_flipdesk_interval?: BillingInterval | null;
  pending_schedule_id?: string | null;
  pending_effective_at?: string | null;
}

export interface SubmissionInsert {
  user_id: string;
  garment_type: GarmentType;
  garment_category: GarmentCategory;
  brand?: string | null;
  title: string;
  description?: string | null;
  style_attributes?: string[];
  verified_capture_opt_in?: boolean;
  authenticity_addon?: boolean;
}

export interface SubmissionImageInsert {
  submission_id: string;
  image_type: ImageType;
  storage_path: string;
  display_order?: number;
  phash?: string | null;
  exif?: ImageExifMetadata | null;
  original_storage_path?: string | null;
}

export interface GradeReportInsert {
  submission_id: string;
  overall_score: number;
  grade_tier: GradeTier;
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
  ai_summary: string;
  detailed_notes?: Record<string, string> | null;
  detected_style_attributes?: DetectedStyleAttribute[];
  per_image_analysis?: unknown[] | null;
  confidence_score: number;
  needs_human_review?: boolean;
  verified_capture?: VerifiedCaptureResult | null;
  original_photos?: OriginalPhotosResult | null;
  authenticity_assessment?: AuthenticityAssessment | null;
  forensic_analysis?: ForensicTamperAssessment | null;
  model_version: string;
  prompt_version?: string | null;
  certificate_id?: string | null;
  content_hash?: string | null;
  content_signature?: string | null;
  integrity_version?: number | null;
  superseded_at?: string | null;
}

export interface DisputeInsert {
  grade_report_id: string;
  user_id: string;
  reason: string;
}

export interface ApiKeyInsert {
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  expires_at?: string | null;
  webhook_url?: string | null;
}

export interface InventoryItemInsert {
  user_id: string;
  title: string;
  brand?: string | null;
  garment_type?: GarmentType | null;
  garment_category?: GarmentCategory | null;
  size?: string | null;
  color?: string | null;
  acquired_price?: number | null;
  acquired_date?: string | null;
  acquired_source?: string | null;
  condition_notes?: string | null;
  status?: ItemStatus;
  submission_id?: string | null;
  grade_report_id?: string | null;
  sku?: string | null;
  item_category?: ItemCategory | null;
  source_id?: string | null;
  target_price?: number | null;
  location_bin?: string | null;
  measurements?: Record<string, number | string> | null;
  material?: string | null;
  grade_value?: number | null;
  grade_label?: string | null;
  certificate_url?: string | null;
  container?: string | null;
  style?: string | null;
  description?: string | null;
  sourced_by?: string | null;
  comp_set?: ItemComp[];
  ai_field_sources?: Record<string, AiFieldSource>;
  ai_enriched_at?: string | null;
  // US-821 canonical attributes (migration 00182)
  attributes?: CanonicalAttributes;
  condition_summary?: string | null;
  ebay_category_query?: string | null;
  ebay_category_id?: string | null;
  ebay_aspects?: Record<string, string[]> | null;
  ebay_aspect_sources?: Record<string, string> | null;
  ai_generated_aspects_at?: string | null;
  exclude_from_automations?: boolean;
}

export interface ListingInsert {
  inventory_item_id: string;
  // Optional: derived from inventory_item_id by the set_listings_tenant trigger
  // when omitted (US-410).
  user_id?: string;
  platform: ListingPlatform;
  platform_listing_id?: string | null;
  listing_url?: string | null;
  listing_price: number;
  listed_at?: string | null;
  is_active?: boolean;
  notes?: string | null;
  listing_title?: string | null;
  listing_description?: string | null;
  description_blocks?: DescriptionBlock[] | null;
  listing_status?: ListingStatus;
  watchers?: number;
  views?: number;
  primary_photo_id?: string | null;
  badge_enabled?: boolean;
  slab_image_mode?: SlabImageMode;
  // eBay handles (migrations 00031, 00034)
  platform_offer_id?: string | null;
  platform_category_id?: string | null;
  // AutoLister (migration 00052)
  batch_id?: string | null;
  // US-1568: composer/bulk-edit save stamps the human review.
  reviewed_at?: string | null;
  scheduled_publish_at?: string | null;
  publish_error?: string | null;
  publish_failed_at?: string | null;
  ebay_condition?: string | null;
  ebay_condition_description?: string | null;
  item_specifics_override?: Record<string, string[]> | null;
  item_specifics_sources?: Record<string, string> | null;
  return_policy_id?: string | null;
  shipping_policy_id?: string | null;
  payment_policy_id?: string | null;
  quantity?: number;
  best_offer_enabled?: boolean;
  best_offer_auto_accept_cents?: number | null;
  best_offer_auto_decline_cents?: number | null;
  synced_to_ebay_at?: string | null;
  price_is_estimated?: boolean;
  // US-542: comp-derived price range + confidence + source.
  price_range_low_cents?: number | null;
  price_range_high_cents?: number | null;
  price_confidence?: number | null;
  price_comp_source?: string | null;
  // US-1077: provenance marker. Omit to accept the DB default ('gradethread');
  // the eBay import/match path stamps 'ebay' explicitly.
  listing_origin?: ListingOrigin;
  // Cross-listing group key (US-149)
  draft_id?: string | null;
  // Promoted Listings (US-150 / US-561). promo_rate_pct = the accepted/adjusted
  // ad rate; promo_opt_out turns promotion off for this listing.
  promo_rate_pct?: number | null;
  promo_opt_out?: boolean;
  // 00432: tri-state per-listing promotion override (null = inherit seller default).
  promote_override?: boolean | null;
  // US-1447: 'cps' | 'cpc' Promoted Listings mode (migration 00330).
  promo_mode?: string;
  // US-568: format + auction terms + variation matrix.
  listing_format?: ListingFormat;
  auction_start_price_cents?: number | null;
  auction_reserve_price_cents?: number | null;
  auction_buy_it_now_price_cents?: number | null;
  auction_duration?: string | null;
  variations?: ListingVariations | null;
}

export interface SaleInsert {
  inventory_item_id: string;
  // Optional: derived from inventory_item_id by the set_sales_tenant trigger when
  // omitted (US-410).
  user_id?: string;
  listing_id?: string | null;
  sale_price: number;
  platform_fees?: number;
  sale_date?: string;
  buyer_username?: string | null;
  buyer_notes?: string | null;
  shipping_collected?: number;
  payment_processing_fees?: number;
  shipping_cost?: number;
  grading_cost?: number;
  other_costs?: number;
  net_profit?: number | null;
  buyer_id?: string | null;
  sold_at?: string | null;
  shipped_at?: string | null;
  tracking_number?: string | null;
  carrier?: string | null;
  delivered_at?: string | null;
  payout_reference?: string | null;
  tax?: number;
  payout_amount?: number | null;
  // Marketplace order identifiers for API sales (US-714) — Depop purchase/parcel.
  platform_order_ref?: Record<string, unknown> | null;
}

// ─── FlipDesk inserts ──────────────────────────────────────────────

export interface SourceInsert {
  user_id: string;
  name: string;
  source_type?: FlipdeskSourceType;
  location?: string | null;
  notes?: string | null;
}

export interface ItemPhotoInsert {
  inventory_item_id: string;
  photo_url: string;
  storage_path?: string | null;
  photo_type?: FlipdeskPhotoType;
  sort_order?: number;
  used_for_grading?: boolean;
  ebay_uploaded?: boolean;
  archived_to_r2?: boolean;
  captured_at?: string | null;
  reconcile_session_id?: string | null;
  // 00339 (US-1539) — photo provenance.
  original_filename?: string | null;
}

export interface MarketplaceConnectionInsert {
  user_id: string;
  marketplace: ListingPlatform;
  access_token_encrypted?: string | null;
  refresh_token_encrypted?: string | null;
  token_expires_at?: string | null;
  account_handle?: string | null;
  scopes?: string[];
  is_active?: boolean;
  merchant_location_key?: string | null;
}

// US-146: Google Sheets connection (migration 00131). The SPA only ever READs
// its own row (status surfacing) — writes go through the service-role edge
// client — but typing Insert/Update keeps the table shape in one place.
export interface GoogleConnectionRow {
  id: string;
  user_id: string;
  google_email: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  sheet_id: string | null;
  sheet_url: string | null;
  last_sync_at: string | null;
  sync_status: string;
  sync_error: string | null;
  is_active: boolean;
  // 00433 "bring your own sheet": per-user column map (NULL = classic generated
  // tabs). Shape validated in edge code (services/edge-functions/src/lib/sheet-map.ts).
  sheet_map: SheetMapConfig | null;
  created_at: string;
  updated_at: string;
}

// Mirror of the edge SheetMap shape (sheet-map.ts) for the mapping UI.
export interface SheetMapConfig {
  tab: string;
  keyColumn: string;
  createFromSheet: boolean;
  columns: Array<{
    header: string;
    field: string;
    table: "inventory_items" | "listings" | "sales";
    role?: "key";
    writable?: boolean;
    kind?: "string" | "number" | "currency" | "date" | "enum";
    enumValues?: string[];
    labelMap?: Record<string, string>;
  }>;
}

export interface GoogleConnectionInsert {
  user_id: string;
  google_email?: string | null;
  access_token_enc?: string | null;
  refresh_token_enc?: string | null;
  token_expires_at?: string | null;
  sheet_id?: string | null;
  sheet_url?: string | null;
  sync_status?: string;
  is_active?: boolean;
}

export interface PayoutImportInsert {
  user_id: string;
  marketplace: ListingPlatform;
  import_method: PayoutImportMethod;
  raw_payload: Record<string, unknown>;
  reconciled?: boolean;
  sale_id?: string | null;
  payout_date?: string | null;
  amount?: number | null;
}

export interface FlipdeskGradingSubmissionInsert {
  inventory_item_id: string;
  submission_id?: string | null;
  gradethread_submission_id?: string | null;
  tier?: GradingSubmissionTier;
  status?: SubmissionStatus;
  cost?: number;
  submitted_at?: string | null;
}

export interface ShipmentInsert {
  sale_id: string;
  carrier: string;
  tracking_number?: string | null;
  shipping_cost: number;
  label_cost?: number;
  ship_date?: string | null;
  delivery_date?: string | null;
  weight_oz?: number | null;
}

export interface AdminAuditLogInsert {
  admin_user_id: string;
  action: string;
  target_type: string;
  target_id?: string | null;
  details?: Record<string, unknown> | null;
}

export interface HumanReviewInsert {
  grade_report_id: string;
  reviewer_id: string;
  original_score: number;
  adjusted_score?: number | null;
  adjusted_fabric_condition?: number | null;
  adjusted_structural_integrity?: number | null;
  adjusted_cosmetic_appearance?: number | null;
  adjusted_functional_elements?: number | null;
  adjusted_odor_cleanliness?: number | null;
  intentional_misread?: boolean;
  review_notes?: string | null;
}

export interface AiPromptVersionInsert {
  version_name: string;
  prompt_text: string;
  is_active?: boolean;
  accuracy_score?: number | null;
  total_grades?: number;
  stage?: "per_image" | "composite" | "listing_gen";
  garment_scope?: string | null;
  eval_passed?: boolean | null;
  eval_run_id?: string | null;
  notes?: string | null;
}

export interface GradingEvalCaseInsert {
  label: string;
  garment_type: GarmentType;
  garment_category: GarmentCategory;
  brand?: string | null;
  description?: string | null;
  style_attributes?: string[];
  images: Array<{ image_type: string; storage_path: string }>;
  expected_score: number;
  expected_tier: GradeTier;
  tags?: string[];
  is_active?: boolean;
  notes?: string | null;
  created_by?: string | null;
}

export interface NotificationInsert {
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string | null;
  is_read?: boolean;
}

// ─── AI enrichment log (US-158) ────────────────────────────────────

export type AiInputKind = "text" | "photo" | "both";

export interface AiEnrichmentLogRow {
  id: string;
  user_id: string;
  inventory_item_id: string | null;
  model: string;
  input_kind: AiInputKind;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  suggested_fields: Record<string, unknown>;
  accepted_fields: Record<string, unknown>;
  created_at: string;
}

export interface AiEnrichmentLogInsert {
  user_id: string;
  inventory_item_id?: string | null;
  model: string;
  input_kind: AiInputKind;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  latency_ms?: number;
  suggested_fields?: Record<string, unknown>;
  accepted_fields?: Record<string, unknown>;
}

export type AiEnrichmentLogUpdate = Partial<
  Pick<AiEnrichmentLogRow, "accepted_fields">
>;

// Grade credit ledger (US-201). Append-only — inserted only by the
// debit_grade_credits / grant_grade_credits SECURITY DEFINER functions.
export interface GradeCreditTransactionRow {
  id: string;
  user_id: string;
  delta: number;
  reason: GradeCreditReason;
  // US-398: NULL for zero-delta audit rows (included_grant / included refund).
  balance_after: number | null;
  submission_id: string | null;
  stripe_payment_intent_id: string | null;
  notes: string | null;
  // US-892: dedupe key for money-moving ops (admin adjust, pack refund). NULL
  // for organic rows; UNIQUE when set.
  idempotency_key: string | null;
  created_at: string;
}

// FlipDesk subscription event log (US-201). Idempotency + audit trail for
// Stripe webhooks. Service-role writes only.
export interface FlipdeskSubscriptionEventRow {
  id: string;
  user_id: string;
  stripe_event_id: string | null;
  event_type: string;
  from_plan: FlipdeskPlan | null;
  to_plan: FlipdeskPlan | null;
  raw_payload: Record<string, unknown> | null;
  created_at: string;
}

export interface FlipdeskSubscriptionEventInsert {
  user_id: string;
  stripe_event_id?: string | null;
  event_type: string;
  from_plan?: FlipdeskPlan | null;
  to_plan?: FlipdeskPlan | null;
  raw_payload?: Record<string, unknown> | null;
}

// US-587: data-driven plan pricing/limits (00166_pricing_plans.sql). Read by the
// SPA (anon SELECT) for pricing display; written only by the audited admin edge
// route. gate_flags mirrors FlipdeskGateFlags in src/lib/constants.ts.
export interface PricingPlanRow {
  key: FlipdeskPlan;
  name: string;
  sort_order: number;
  price_monthly_cents: number;
  price_yearly_cents: number;
  active_listing_cap: number;
  ai_actions_per_month: number;
  marketplaces_cap: number;
  included_standard_grades_per_month: number;
  team_seat_cap: number;
  features: string[];
  gate_flags: Record<string, boolean>;
  stripe_price_monthly: string;
  stripe_price_yearly: string;
  updated_at: string;
  updated_by: string | null;
}

// Closed-loop sale-outcome feedback (US-132). Written via SECURITY DEFINER
// triggers on sales + disputes — never inserted from app code.
export interface GradeOutcomeRow {
  id: string;
  grade_report_id: string;
  inventory_item_id: string | null;
  sale_id: string | null;
  listing_price: number | null;
  sold_price: number | null;
  sold_at: string | null;
  dispute_reported: boolean;
  source: string;
  // US-1812: buyer confirm/dispute columns (00421; null on seller-sale rows).
  buyer_user_id: string | null;
  buyer_purchase_id: string | null;
  seller_user_id: string | null;
  match_status: "confirmed" | "disputed" | null;
  factor_deltas: Record<string, number>;
  overall_delta: number | null;
  dispute_reason: string | null;
  dispute_severity: "cosmetic" | "material" | null;
  prompt_version: string | null;
  guarantee_eligible: boolean;
  human_review_flagged: boolean;
  created_at: string;
  updated_at: string;
}

// US-1812: the buyer-facing projection of their own confirm/dispute verdict.
export interface BuyerGradeOutcomeRow {
  id: string;
  buyer_purchase_id: string | null;
  match_status: "confirmed" | "disputed" | null;
  dispute_reason: string | null;
  dispute_severity: "cosmetic" | "material" | null;
  guarantee_eligible: boolean;
}

// US-1813: buyer reward credit balance (owner-read; service-write via 00422 RPCs).
export interface BuyerRewardCreditsRow {
  user_id: string;
  balance: number;
  lifetime_earned: number;
  lifetime_redeemed: number;
  updated_at: string;
}

export interface BuyerRewardLedgerRow {
  id: string;
  user_id: string;
  entry_type: "earn" | "redeem" | "reversal";
  credits: number;
  reason: string | null;
  meter: string | null;
  reference_id: string;
  created_at: string;
}

// US-1830: 'Graded Wanted' demand board — a buyer's active want + its matches.
export interface BuyerWantRow {
  id: string;
  user_id: string;
  brands: string[];
  categories: string[];
  keywords: string[];
  min_grade: number | null;
  max_price_cents: number | null;
  size: string | null;
  budget_cents: number | null;
  visibility: "public" | "private";
  status: "active" | "expired" | "fulfilled";
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WantMatchRow {
  id: string;
  want_id: string;
  buyer_user_id: string;
  seller_user_id: string | null;
  certificate_id: string;
  created_at: string;
}

// US-1821: buyer purchase-guarantee claim (owner-read; service-write).
export type BuyerGuaranteeClaimStatus =
  | "auto_approved"
  | "approved"
  | "manual_review"
  | "rejected"
  | "paid";

export interface BuyerGuaranteeClaimRow {
  id: string;
  user_id: string;
  purchase_id: string;
  grade_report_id: string | null;
  status: BuyerGuaranteeClaimStatus;
  grade_delta: number | null;
  purchase_price_cents: number | null;
  payout_cap_cents: number | null;
  remedy_cents: number;
  remedy_credits: number;
  auto: boolean;
  decision_reason: string | null;
  // US-1823: anti-fraud signals + admin resolution audit (00426).
  fraud_flags: string[];
  fraud_score: number;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Growth / Promote suite (00102_growth_suite.sql) ───────────────

export type CampaignChannel = "email" | "in_app" | "push";
export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "sending"
  | "sent"
  | "failed"
  | "canceled";
export type CampaignRecipientStatus = "pending" | "sent" | "failed" | "skipped";
export type AnnouncementVariant = "info" | "success" | "warning" | "promo";
export type ReferralRewardStatus = "pending" | "qualified" | "granted" | "void";

/** A single segment condition — field + operator + value, allowlist-validated
 *  server-side in edge lib/segments.ts. */
export interface SegmentCondition {
  field: string;
  op: string;
  value: string | number | boolean | null;
}

/** Rule tree for an audience segment. `match` = AND ('all') / OR ('any'). */
export interface SegmentRules {
  match: "all" | "any";
  conditions: SegmentCondition[];
}

export interface AudienceSegmentRow {
  id: string;
  name: string;
  description: string | null;
  rules: SegmentRules;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
export interface AudienceSegmentInsert {
  name: string;
  description?: string | null;
  rules?: SegmentRules;
  is_active?: boolean;
}
export type AudienceSegmentUpdate = Partial<
  Omit<AudienceSegmentRow, "id" | "created_by" | "created_at" | "updated_at">
>;

export interface GrowthCampaignRow {
  id: string;
  name: string;
  subject: string;
  body: string;
  cta_label: string | null;
  cta_url: string | null;
  channels: CampaignChannel[];
  segment_id: string | null;
  status: CampaignStatus;
  scheduled_for: string | null;
  sent_at: string | null;
  stats: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
export interface GrowthCampaignInsert {
  name: string;
  subject: string;
  body: string;
  cta_label?: string | null;
  cta_url?: string | null;
  channels?: CampaignChannel[];
  segment_id?: string | null;
  status?: CampaignStatus;
  scheduled_for?: string | null;
}
export type GrowthCampaignUpdate = Partial<
  Omit<GrowthCampaignRow, "id" | "created_by" | "created_at" | "updated_at">
>;

export interface CampaignRecipientRow {
  id: string;
  campaign_id: string;
  user_id: string;
  channel: CampaignChannel;
  status: CampaignRecipientStatus;
  error: string | null;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  created_at: string;
}
export interface CampaignRecipientInsert {
  campaign_id: string;
  user_id: string;
  channel: CampaignChannel;
  status?: CampaignRecipientStatus;
  error?: string | null;
  sent_at?: string | null;
}
export type CampaignRecipientUpdate = Partial<
  Omit<CampaignRecipientRow, "id" | "campaign_id" | "user_id" | "channel" | "created_at">
>;

export interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  variant: AnnouncementVariant;
  cta_label: string | null;
  cta_url: string | null;
  segment_id: string | null;
  starts_at: string;
  ends_at: string | null;
  dismissible: boolean;
  priority: number;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
export interface AnnouncementInsert {
  title: string;
  body: string;
  variant?: AnnouncementVariant;
  cta_label?: string | null;
  cta_url?: string | null;
  segment_id?: string | null;
  starts_at?: string;
  ends_at?: string | null;
  dismissible?: boolean;
  priority?: number;
  is_active?: boolean;
}
export type AnnouncementUpdate = Partial<
  Omit<AnnouncementRow, "id" | "created_by" | "created_at" | "updated_at">
>;

export interface AnnouncementDismissalRow {
  id: string;
  announcement_id: string;
  user_id: string;
  dismissed_at: string;
}
export interface AnnouncementDismissalInsert {
  announcement_id: string;
  user_id: string;
}

export interface ReferralCodeRow {
  id: string;
  user_id: string;
  code: string;
  created_at: string;
}
export interface ReferralCodeInsert {
  user_id: string;
  code: string;
}

export interface ReferralEventRow {
  id: string;
  referrer_user_id: string;
  referred_user_id: string;
  code: string;
  reward_status: ReferralRewardStatus;
  referrer_reward_credits: number | null;
  referred_reward_credits: number | null;
  qualified_at: string | null;
  granted_at: string | null;
  /** US-603: 'direct' (typed code) or 'affiliate' (earned-link attribution). */
  attribution_source: string;
  created_at: string;
}
export interface ReferralEventInsert {
  referrer_user_id: string;
  referred_user_id: string;
  code: string;
  reward_status?: ReferralRewardStatus;
  referrer_reward_credits?: number | null;
  referred_reward_credits?: number | null;
  attribution_source?: string;
}
export type ReferralEventUpdate = Partial<
  Omit<ReferralEventRow, "id" | "referrer_user_id" | "referred_user_id" | "created_at">
>;

// US-603: one row per click on a "Graded by GradeThread" earned link / badge.
export interface AffiliateClickRow {
  id: string;
  code: string;
  source: string;
  landing_path: string | null;
  referrer_host: string | null;
  converted_user_id: string | null;
  created_at: string;
}
export interface AffiliateClickInsert {
  code: string;
  source?: string;
  landing_path?: string | null;
  referrer_host?: string | null;
  converted_user_id?: string | null;
}
export type AffiliateClickUpdate = Partial<
  Omit<AffiliateClickRow, "id" | "code" | "created_at">
>;

// ─── Update types ──────────────────────────────────────────────────

export type UserUpdate = Partial<Omit<UserRow, "id" | "created_at" | "updated_at">>;
export type SubmissionUpdate = Partial<Omit<SubmissionRow, "id" | "user_id" | "created_at" | "updated_at">>;
export type GradeReportUpdate = Partial<Omit<GradeReportRow, "id" | "submission_id" | "created_at">>;
export type DisputeUpdate = Partial<Omit<DisputeRow, "id" | "grade_report_id" | "user_id" | "created_at" | "updated_at">>;
export type InventoryItemUpdate = Partial<Omit<InventoryItemRow, "id" | "user_id" | "created_at" | "updated_at">>;
export type ListingUpdate = Partial<Omit<ListingRow, "id" | "created_at" | "updated_at">>;
export type SaleUpdate = Partial<Omit<SaleRow, "id" | "created_at">>;
export type ShipmentUpdate = Partial<Omit<ShipmentRow, "id" | "created_at" | "updated_at">>;
export type HumanReviewUpdate = Partial<Omit<HumanReviewRow, "id" | "grade_report_id" | "reviewer_id">>;
export type AiPromptVersionUpdate = Partial<Omit<AiPromptVersionRow, "id" | "created_at">>;
export type NotificationUpdate = Partial<Omit<NotificationRow, "id" | "user_id" | "created_at">>;
export type SourceUpdate = Partial<Omit<SourceRow, "id" | "user_id" | "created_at" | "updated_at">>;
export type ItemPhotoUpdate = Partial<Omit<ItemPhotoRow, "id" | "inventory_item_id" | "created_at">>;
export type MarketplaceConnectionUpdate = Partial<Omit<MarketplaceConnectionRow, "id" | "user_id" | "created_at" | "updated_at">>;
export type GoogleConnectionUpdate = Partial<Omit<GoogleConnectionRow, "id" | "user_id" | "created_at" | "updated_at">>;
export type PayoutImportUpdate = Partial<Omit<PayoutImportRow, "id" | "user_id" | "created_at" | "updated_at">>;
export type FlipdeskGradingSubmissionUpdate = Partial<Omit<FlipdeskGradingSubmissionRow, "id" | "inventory_item_id" | "created_at" | "updated_at">>;

// ─── Content module (Blog + Social) ────────────────────────────────
// Mirrors the Phase A migration (00041_content_module.sql).

export type ContentSurface = "blog" | "social";
export type ContentProduct = "gradethread" | "flipdesk" | "both";
export type ContentStatus =
  | "draft"
  | "scheduled"
  | "published"
  | "archived"
  | "failed";
export type TopicStatus = "queued" | "assigned" | "used" | "rejected";
export type ContentGeneratedBy = "ai" | "human";
export type ContentTopicSource = "research" | "manual" | "history_derived";
/** Pre-publish safety review state (US-486, migration 00151). */
export type ContentSafetyStatus = "unchecked" | "passed" | "held";

export interface ContentTopicRow {
  id: string;
  surface: ContentSurface;
  product_focus: ContentProduct;
  title: string;
  angle: string | null;
  primary_keyword: string;
  secondary_keywords: string[];
  search_intent: string | null;
  status: TopicStatus;
  used_by_post_id: string | null;
  generated_by: ContentGeneratedBy;
  source: ContentTopicSource;
  notes: string | null;
  created_at: string;
  used_at: string | null;
  updated_at: string;
}
export interface ContentTopicInsert {
  surface: ContentSurface;
  product_focus: ContentProduct;
  title: string;
  primary_keyword: string;
  angle?: string | null;
  secondary_keywords?: string[];
  search_intent?: string | null;
  status?: TopicStatus;
  generated_by?: ContentGeneratedBy;
  source?: ContentTopicSource;
  notes?: string | null;
}
export type ContentTopicUpdate = Partial<
  Omit<ContentTopicRow, "id" | "created_at" | "updated_at">
>;

/** A single on-page FAQ entry (US-304); rendered visibly + as FAQPage JSON-LD. */
export interface BlogFaq {
  q: string;
  a: string;
}
// Per-body-image SEO metadata (US-876) stored on blog_posts.inline_images.
export interface BlogInlineImage {
  src: string;
  alt: string;
  caption: string;
  width: number | null;
  height: number | null;
}

export interface BlogPostRow {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body_html: string;
  body_json: Record<string, unknown>;
  product_focus: ContentProduct;
  status: ContentStatus;
  hero_image_url: string | null;
  hero_image_path: string | null;
  hero_prompt: string | null;
  // Image SEO (US-876): stored hero alt/caption/credit + pixel dimensions, and
  // per-inline-image metadata. Nullable/defaulted → legacy posts unaffected.
  hero_image_alt: string | null;
  hero_image_caption: string | null;
  hero_image_credit: string | null;
  hero_image_width: number | null;
  hero_image_height: number | null;
  inline_images: BlogInlineImage[];
  seo_title: string | null;
  seo_description: string | null;
  primary_keyword: string | null;
  secondary_keywords: string[];
  jsonld: Record<string, unknown> | null;
  reading_time_min: number | null;
  scheduled_for: string | null;
  published_at: string | null;
  topic_id: string | null;
  generated_by: ContentGeneratedBy;
  model_used: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  // Blog GEO / E-E-A-T fields (US-304). Nullable/defaulted → legacy posts OK.
  author: string | null;
  // Linked author entity (US-874). NULL → legacy `author` byline fallback.
  author_id: string | null;
  key_takeaways: string[];
  faqs: BlogFaq[];
  // Pre-publish safety review state (US-486).
  safety_status: ContentSafetyStatus;
  safety_notes: string | null;
  safety_checked_at: string | null;
  // Topic-cluster pillar slug (US-873) — the seo.pillars cluster this post
  // ladders to, set at publish. Null until interlinked.
  pillar: string | null;
  created_at: string;
  updated_at: string;
}
// Author entity (US-874) — named blog authors with bio pages + Person JSON-LD.
export interface ContentAuthorRow {
  id: string;
  slug: string;
  name: string;
  title: string | null;
  bio_md: string | null;
  avatar_url: string | null;
  credentials: string[];
  same_as: string[];
  created_at: string;
  updated_at: string;
}
export interface BlogPostInsert {
  title: string;
  slug: string;
  product_focus?: ContentProduct;
  status?: ContentStatus;
  excerpt?: string | null;
  body_html?: string;
  body_json?: Record<string, unknown>;
  hero_image_url?: string | null;
  primary_keyword?: string | null;
  secondary_keywords?: string[];
  topic_id?: string | null;
  generated_by?: ContentGeneratedBy;
}
export type BlogPostUpdate = Partial<
  Omit<BlogPostRow, "id" | "created_at" | "updated_at">
>;

// Convenience row returned by GET /api/content/blog (list) — tags appended client-side.
export interface BlogPostListRow {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  product_focus: ContentProduct;
  status: ContentStatus;
  hero_image_url: string | null;
  primary_keyword: string | null;
  published_at: string | null;
  scheduled_for: string | null;
  generated_by: ContentGeneratedBy;
  model_used: string | null;
  created_at: string;
  updated_at: string;
}

export interface SocialPostRow {
  id: string;
  product_focus: ContentProduct;
  status: ContentStatus;
  long_body: string;
  short_body: string;
  hashtags: string[];
  cta_url: string | null;
  scheduled_for: string | null;
  published_at: string | null;
  topic_id: string | null;
  asset_image_url: string | null;
  asset_image_path: string | null;
  // Video distribution: a video post carries a public clip URL that fans out to
  // TikTok / Reels / FB video; media_type defaults to 'image' for still posts.
  media_type: "image" | "video";
  video_url: string | null;
  video_path: string | null;
  generated_by: ContentGeneratedBy;
  model_used: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  // Pre-publish safety review state (US-486).
  safety_status: ContentSafetyStatus;
  safety_notes: string | null;
  safety_checked_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface SocialPostInsert {
  product_focus?: ContentProduct;
  status?: ContentStatus;
  long_body?: string;
  short_body?: string;
  hashtags?: string[];
  cta_url?: string | null;
  topic_id?: string | null;
  generated_by?: ContentGeneratedBy;
}
export type SocialPostUpdate = Partial<
  Omit<SocialPostRow, "id" | "created_at" | "updated_at">
>;

// US-870: one tailored social variant per platform, child of social_posts.
export type SocialPlatform =
  | "x"
  | "linkedin"
  | "facebook"
  | "threads"
  | "pinterest"
  | "instagram"
  | "tiktok";

export interface SocialPlatformVariantRow {
  id: string;
  social_post_id: string;
  platform: SocialPlatform;
  body: string;
  hashtags: string[];
  image_field: string | null;
  char_limit: number | null;
  created_at: string;
  updated_at: string;
}

export interface ContentKnowledgeRow {
  id: string;
  key: string;
  title: string;
  body_md: string;
  token_count_est: number;
  created_at: string;
  updated_at: string;
}
export interface ContentKnowledgeListRow {
  id: string;
  key: string;
  title: string;
  token_count_est: number;
  updated_at: string;
}

export interface ContentSettingsRow {
  id: number;
  make_webhook_blog: string | null;
  make_webhook_social_long: string | null;
  make_webhook_social_short: string | null;
  // US-870: single platform-router webhook + per-platform enable list.
  make_webhook_social: string | null;
  social_platforms: SocialPlatform[];
  auto_publish_blog: boolean;
  auto_publish_social: boolean;
  default_blog_model: string;
  default_social_model: string;
  default_research_model: string;
  default_image_model: string;
  min_topics_in_bank: number;
  topics_refill_batch: number;
  post_cadence_per_day_blog: number;
  post_cadence_per_day_social: number;
  public_site_url: string;
  // US-486: kill-switch + weekly auto-publish ceiling.
  publishing_paused: boolean;
  max_auto_publishes_per_week: number;
  created_at: string;
  updated_at: string;
}

// ─── Garment Passport (US-1089, migration 00256) ───────────────────
// Client reads are RLS-scoped to created_by = auth.uid(); all writes are
// service-role only (no client INSERT/UPDATE policy exists).

export interface GarmentRow {
  id: string;
  public_passport_slug: string;
  sku_class: Record<string, unknown>;
  current_owner_node_id: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// US-1777: buyer body-profile store (sensitive PII; RLS auth.uid() = user_id).
export interface BodyProfileRow {
  id: string;
  user_id: string;
  name: string;
  /** Sparse body-measurement map (key → inches). */
  measurements: Record<string, number>;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}
export type BodyProfileInsert = Omit<BodyProfileRow, "id" | "created_at" | "updated_at"> & {
  id?: string;
};
export type BodyProfileUpdate = Partial<Omit<BodyProfileRow, "id" | "user_id" | "created_at">>;

// US-1797/1798: buyer shopping preferences (one row per buyer). Owner-managed
// from the SPA via RLS; read by alerts/fit/recommendations (edge, scoped).
export interface BuyerPreferencesRow {
  user_id: string;
  followed_brands: string[];
  categories: string[];
  /** Sizes per garment group, e.g. { tops: ["M","L"], footwear: ["10"] }. */
  sizes: Record<string, string[]>;
  price_min_cents: number | null;
  price_max_cents: number | null;
  /** Minimum acceptable condition grade (1.0–10.0), null = no floor. */
  condition_floor: number | null;
  unit_preference: "in" | "cm";
  notify_email: boolean;
  notify_push: boolean;
  // US-1803: delivery cadence + quiet hours for the buyer notification layer.
  digest_frequency: "immediate" | "daily" | "weekly";
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
}
export type BuyerPreferencesInsert =
  & Omit<BuyerPreferencesRow, "created_at" | "updated_at" | "onboarding_completed_at">
  & { onboarding_completed_at?: string | null };
export type BuyerPreferencesUpdate = Partial<Omit<BuyerPreferencesRow, "user_id" | "created_at">>;

// US-1806: condition-based alerts model. Owner-managed from the SPA via RLS;
// read by the matching engine (US-1807, edge, scoped by user_id) and the
// delivery/management UI (US-1809).

/** A buyer's standing search criteria. Criteria default from buyer_preferences
 *  (US-1798) at create time, then are individually editable. */
export interface SavedSearchRow {
  id: string;
  user_id: string;
  label: string;
  brands: string[];
  categories: string[];
  /** Sizes per garment group, e.g. { tops: ["M","L"], footwear: ["10"] }. */
  sizes: Record<string, string[]>;
  keywords: string[];
  /** Minimum acceptable condition grade (1.0–10.0), null = no floor. */
  min_grade: number | null;
  max_price_cents: number | null;
  is_active: boolean;
  notify_email: boolean;
  notify_push: boolean;
  last_matched_at: string | null;
  created_at: string;
  updated_at: string;
}
export type SavedSearchInsert =
  & { user_id: string }
  & Partial<Omit<SavedSearchRow, "id" | "user_id" | "created_at" | "updated_at" | "last_matched_at">>;
export type SavedSearchUpdate = Partial<
  Omit<SavedSearchRow, "id" | "user_id" | "created_at" | "updated_at">
>;

/** A specific certificate / listing / passport / ingested marketplace listing a
 *  buyer is watching. `ingested_listing` (US-1808, migration 00535) points at an
 *  `ingested_listings.id` — an item the buyer browsed that isn't on GradeThread. */
export interface WatchlistItemRow {
  id: string;
  user_id: string;
  target_type: "certificate" | "listing" | "passport" | "ingested_listing";
  target_id: string;
  label: string | null;
  brand: string | null;
  created_at: string;
}
export type WatchlistItemInsert =
  & { user_id: string; target_type: WatchlistItemRow["target_type"]; target_id: string }
  & Partial<Pick<WatchlistItemRow, "label" | "brand">>;

// US-1808: a marketplace listing the buyer was browsing, handed to GradeThread
// by the extension, graded, and evaluated against their saved searches. Written
// ONLY by the edge (service role, scoped by user_id); the buyer may read and
// delete their own rows but never insert or edit one — the grade on it is
// GradeThread's objective read, not a value the client can set.
export interface IngestedListingRow {
  id: string;
  user_id: string;
  marketplace: string;
  /** Canonical URL (query + fragment stripped); the per-buyer dedupe key. */
  listing_url: string;
  title: string | null;
  brand: string | null;
  claimed_condition: string | null;
  price_cents: number | null;
  thumb_url: string | null;
  images_analyzed: number;
  overall_score: number | null;
  grade_tier: string | null;
  confidence: number | null;
  factor_scores: Record<string, number> | null;
  /** The seller's claim expressed on the 1–10 scale (null when unreadable). */
  claimed_grade: number | null;
  discrepancy: Record<string, unknown> | null;
  matched_search_ids: string[];
  created_at: string;
  updated_at: string;
}

// US-1816: buyer Trust Score. reputation_events is the append-only authority;
// buyer_trust_scores is the derived cache. Both owner-READ only (service writes);
// the deterministic scorer lives in the edge (lib/buyer-trust-score.ts).
export type ReputationEventType =
  | "verified_purchase"
  | "grade_confirmed"
  | "dispute_upheld"
  | "dispute_overturned"
  | "chargeback_penalty"
  | "tenure";
export interface ReputationEventRow {
  id: string;
  user_id: string;
  event_type: ReputationEventType;
  /** Anti-gaming: only verified events score. */
  verified: boolean;
  magnitude: number | null;
  source: string;
  reference_id: string;
  metadata: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}
export type ReputationEventInsert =
  & { user_id: string; event_type: ReputationEventType }
  & Partial<Omit<ReputationEventRow, "id" | "user_id" | "event_type" | "created_at">>;

export interface BuyerTrustScoreRow {
  user_id: string;
  score: number;
  level: number;
  level_label: string;
  event_count: number;
  computed_at: string;
  updated_at: string;
}
export type BuyerTrustScoreInsert =
  & { user_id: string }
  & Partial<Omit<BuyerTrustScoreRow, "user_id" | "updated_at">>;

// US-1811: buyer rewards — purchase-link + arrival captures (owner-read; the
// edge writes both after verifying the cert / hardening the upload).
export interface BuyerPurchaseRow {
  id: string;
  user_id: string;
  grade_report_id: string;
  certificate_id: string;
  purchase_price_cents: number | null;
  marketplace: string | null;
  purchased_at: string | null;
  brand: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
}
export type ArrivalImageType = "front" | "back" | "label" | "detail";
export interface PurchaseArrivalCaptureRow {
  id: string;
  user_id: string;
  purchase_id: string;
  image_type: ArrivalImageType;
  storage_path: string;
  created_at: string;
}

// US-1825: wardrobe portfolio — a closet item (owner-read; edge verifies + writes).
export interface ClosetItemRow {
  id: string;
  user_id: string;
  source: "certificate" | "passport" | "manual";
  certificate_id: string | null;
  garment_id: string | null;
  brand: string | null;
  garment_type: string | null;
  size: string | null;
  condition_grade: number | null;
  title: string | null;
  notes: string | null;
  // US-1828: the inventory_items id if this closet item was promoted to FlipDesk.
  promoted_item_id: string | null;
  created_at: string;
  updated_at: string;
}

// US-1820: insured purchase-guarantee coverage snapshot (one per purchase).
export interface PurchaseCoverageRow {
  id: string;
  user_id: string;
  purchase_id: string;
  eligible: boolean;
  ineligible_reason: string | null;
  plan_at_purchase: string | null;
  level_at_purchase: number;
  window_days: number;
  payout_cap_cents: number;
  grade_delta_threshold: number;
  covered_until: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Database schema type (for Supabase client) ────────────────────

export interface Database {
  public: {
    Tables: {
      users: {
        Row: UserRow;
        Insert: UserInsert;
        Update: UserUpdate;
      };
      body_profiles: {
        Row: BodyProfileRow;
        Insert: BodyProfileInsert;
        Update: BodyProfileUpdate;
      };
      buyer_preferences: {
        Row: BuyerPreferencesRow;
        Insert: BuyerPreferencesInsert;
        Update: BuyerPreferencesUpdate;
      };
      // US-1806: condition-based alerts — saved searches + watchlist.
      saved_searches: {
        Row: SavedSearchRow;
        Insert: SavedSearchInsert;
        Update: SavedSearchUpdate;
      };
      watchlist_items: {
        Row: WatchlistItemRow;
        Insert: WatchlistItemInsert;
        Update: Partial<Pick<WatchlistItemRow, "label" | "brand">>;
      };
      // US-1808: extension-ingested marketplace listings. Owner READ + DELETE
      // only under RLS — writes are the edge's (see IngestedListingRow), so the
      // Insert/Update shapes are deliberately `never`.
      ingested_listings: {
        Row: IngestedListingRow;
        Insert: never;
        Update: never;
      };
      // US-1816: buyer Trust Score — event log + derived score (owner-read).
      reputation_events: {
        Row: ReputationEventRow;
        Insert: ReputationEventInsert;
        Update: Partial<Omit<ReputationEventRow, "id" | "user_id" | "created_at">>;
      };
      buyer_purchases: {
        Row: BuyerPurchaseRow;
        Insert: { user_id: string } & Partial<Omit<BuyerPurchaseRow, "id" | "created_at" | "updated_at">>;
        Update: Partial<Omit<BuyerPurchaseRow, "id" | "user_id" | "created_at">>;
      };
      purchase_arrival_captures: {
        Row: PurchaseArrivalCaptureRow;
        Insert: { user_id: string; purchase_id: string; image_type: ArrivalImageType; storage_path: string };
        Update: Partial<Pick<PurchaseArrivalCaptureRow, "storage_path">>;
      };
      purchase_coverage: {
        Row: PurchaseCoverageRow;
        Insert: { user_id: string; purchase_id: string } & Partial<Omit<PurchaseCoverageRow, "id" | "user_id" | "purchase_id" | "created_at" | "updated_at">>;
        Update: Partial<Omit<PurchaseCoverageRow, "id" | "user_id" | "purchase_id" | "created_at">>;
      };
      // US-1813: buyer reward ledger + balance (owner-read; service-write RPCs).
      buyer_reward_credits: {
        Row: BuyerRewardCreditsRow;
        Insert: { user_id: string } & Partial<Omit<BuyerRewardCreditsRow, "user_id" | "updated_at">>;
        Update: Partial<Omit<BuyerRewardCreditsRow, "user_id">>;
      };
      buyer_reward_ledger: {
        Row: BuyerRewardLedgerRow;
        Insert: Partial<Omit<BuyerRewardLedgerRow, "id" | "created_at">> & { user_id: string; entry_type: BuyerRewardLedgerRow["entry_type"]; credits: number };
        Update: Partial<Omit<BuyerRewardLedgerRow, "id" | "user_id" | "created_at">>;
      };
      // US-1821: buyer purchase-guarantee claims (owner-read; service-write).
      buyer_guarantee_claims: {
        Row: BuyerGuaranteeClaimRow;
        Insert: { user_id: string; purchase_id: string } & Partial<Omit<BuyerGuaranteeClaimRow, "id" | "user_id" | "purchase_id" | "created_at" | "updated_at">>;
        Update: Partial<Omit<BuyerGuaranteeClaimRow, "id" | "user_id" | "purchase_id" | "created_at">>;
      };
      closet_items: {
        Row: ClosetItemRow;
        Insert: { user_id: string; source: ClosetItemRow["source"] } & Partial<Omit<ClosetItemRow, "id" | "user_id" | "source" | "created_at" | "updated_at">>;
        Update: Partial<Omit<ClosetItemRow, "id" | "user_id" | "created_at">>;
      };
      buyer_trust_scores: {
        Row: BuyerTrustScoreRow;
        Insert: BuyerTrustScoreInsert;
        Update: Partial<Omit<BuyerTrustScoreRow, "user_id" | "created_at">>;
      };
      // US-1792: B2B API overage credit wallet (owner-read; service-role writes).
      api_credit_wallet: {
        Row: { user_id: string; balance: number; updated_at: string };
        Insert: { user_id: string; balance?: number };
        Update: { balance?: number };
      };
      submissions: {
        Row: SubmissionRow;
        Insert: SubmissionInsert;
        Update: SubmissionUpdate;
      };
      submission_images: {
        Row: SubmissionImageRow;
        Insert: SubmissionImageInsert;
        Update: Partial<Omit<SubmissionImageRow, "id" | "created_at">>;
      };
      grade_reports: {
        Row: GradeReportRow;
        Insert: GradeReportInsert;
        Update: GradeReportUpdate;
      };
      garments: {
        Row: GarmentRow;
        Insert: Partial<GarmentRow>;
        Update: Partial<GarmentRow>;
      };
      disputes: {
        Row: DisputeRow;
        Insert: DisputeInsert;
        Update: DisputeUpdate;
      };
      api_keys: {
        Row: ApiKeyRow;
        Insert: ApiKeyInsert;
        Update: Partial<Omit<ApiKeyRow, "id" | "user_id" | "created_at">>;
      };
      inventory_items: {
        Row: InventoryItemRow;
        Insert: InventoryItemInsert;
        Update: InventoryItemUpdate;
      };
      listings: {
        Row: ListingRow;
        Insert: ListingInsert;
        Update: ListingUpdate;
      };
      sales: {
        Row: SaleRow;
        Insert: SaleInsert;
        Update: SaleUpdate;
      };
      shipments: {
        Row: ShipmentRow;
        Insert: ShipmentInsert;
        Update: ShipmentUpdate;
      };
      admin_audit_log: {
        Row: AdminAuditLogRow;
        Insert: AdminAuditLogInsert;
        Update: Partial<Omit<AdminAuditLogRow, "id" | "created_at">>;
      };
      admin_audit_anomalies: {
        Row: AdminAuditAnomalyRow;
        Insert: Partial<AdminAuditAnomalyRow> & {
          detector: string;
          dedupe_key: string;
        };
        Update: Partial<Omit<AdminAuditAnomalyRow, "id" | "created_at">>;
      };
      human_reviews: {
        Row: HumanReviewRow;
        Insert: HumanReviewInsert;
        Update: HumanReviewUpdate;
      };
      ai_prompt_versions: {
        Row: AiPromptVersionRow;
        Insert: AiPromptVersionInsert;
        Update: AiPromptVersionUpdate;
      };
      grading_eval_cases: {
        Row: GradingEvalCaseRow;
        Insert: GradingEvalCaseInsert;
        Update: Partial<Omit<GradingEvalCaseRow, "id" | "created_at" | "updated_at">>;
      };
      grading_eval_runs: {
        Row: GradingEvalRunRow;
        Insert: Omit<GradingEvalRunRow, "id" | "created_at">;
        Update: Partial<Omit<GradingEvalRunRow, "id" | "created_at">>;
      };
      gsc_performance: {
        Row: GscPerformanceRow;
        Insert: GscPerformanceInsert;
        Update: Partial<GscPerformanceInsert>;
      };
      notifications: {
        Row: NotificationRow;
        Insert: NotificationInsert;
        Update: NotificationUpdate;
      };
      sources: {
        Row: SourceRow;
        Insert: SourceInsert;
        Update: SourceUpdate;
      };
      consignors: {
        Row: ConsignorRow;
        Insert: ConsignorInsert;
        Update: ConsignorUpdate;
      };
      consignor_payouts: {
        Row: ConsignorPayoutRow;
        Insert: ConsignorPayoutInsert;
        Update: ConsignorPayoutUpdate;
      };
      consignor_pnl: {
        // Read-only security-invoker view (US-600).
        Row: ConsignorPnlRow;
        Insert: never;
        Update: never;
      };
      item_photos: {
        Row: ItemPhotoRow;
        Insert: ItemPhotoInsert;
        Update: ItemPhotoUpdate;
      };
      content_moderation_flags: {
        Row: ContentModerationFlagRow;
        Insert: Omit<ContentModerationFlagRow, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<ContentModerationFlagRow, "id" | "created_at" | "updated_at">>;
      };
      marketplace_connections: {
        Row: MarketplaceConnectionRow;
        Insert: MarketplaceConnectionInsert;
        Update: MarketplaceConnectionUpdate;
      };
      google_connections: {
        Row: GoogleConnectionRow;
        Insert: GoogleConnectionInsert;
        Update: GoogleConnectionUpdate;
      };
      flipdesk_reconcile_sessions: {
        Row: ReconcileSessionRow;
        Insert: ReconcileSessionInsert;
        Update: ReconcileSessionUpdate;
      };
      listing_generation_batches: {
        Row: ListingGenerationBatchRow;
        Insert: ListingGenerationBatchInsert;
        Update: ListingGenerationBatchUpdate;
      };
      listing_generation_jobs: {
        Row: ListingGenerationJobRow;
        Insert: ListingGenerationJobInsert;
        Update: ListingGenerationJobUpdate;
      };
      business_policies: {
        Row: BusinessPolicyRow;
        Insert: BusinessPolicyInsert;
        Update: BusinessPolicyUpdate;
      };
      payout_imports: {
        Row: PayoutImportRow;
        Insert: PayoutImportInsert;
        Update: PayoutImportUpdate;
      };
      flipdesk_grading_submissions: {
        Row: FlipdeskGradingSubmissionRow;
        Insert: FlipdeskGradingSubmissionInsert;
        Update: FlipdeskGradingSubmissionUpdate;
      };
      flipdesk_saved_views: {
        Row: SavedViewRow;
        Insert: SavedViewInsert;
        Update: SavedViewUpdate;
      };
      admin_task_projects: {
        Row: AdminTaskProjectRow;
        Insert: AdminTaskProjectInsert;
        Update: AdminTaskProjectUpdate;
      };
      admin_tasks: {
        Row: AdminTaskRow;
        Insert: AdminTaskInsert;
        Update: AdminTaskUpdate;
      };
      admin_task_comments: {
        Row: AdminTaskCommentRow;
        Insert: AdminTaskCommentInsert;
        Update: AdminTaskCommentUpdate;
      };
      flipdesk_expenses: {
        Row: ExpenseRow;
        Insert: ExpenseInsert;
        Update: ExpenseUpdate;
      };
      form_1099k: {
        Row: Form1099kRow;
        Insert: Form1099kInsert;
        Update: Form1099kUpdate;
      };
      marketplace_facilitator_rules: {
        Row: MarketplaceFacilitatorRuleRow;
        Insert: never;
        Update: never;
      };
      inventory_snapshots: {
        Row: InventorySnapshotRow;
        Insert: never;
        Update: Partial<Pick<InventorySnapshotRow, "fiscal_label">>;
      };
      inventory_snapshot_items: {
        Row: InventorySnapshotItemRow;
        Insert: never;
        Update: never;
      };
      ledger_entries: {
        Row: LedgerEntryRow;
        Insert: LedgerEntryInsert;
        Update: LedgerEntryUpdate;
      };
      ledger_accounts: {
        Row: LedgerAccountRow;
        Insert: LedgerAccountInsert;
        Update: LedgerAccountUpdate;
      };
      tax_profiles: {
        Row: TaxProfileRow;
        Insert: TaxProfileInsert;
        Update: TaxProfileUpdate;
      };
      tax_profile_changes: {
        Row: TaxProfileChangeRow;
        Insert: TaxProfileChangeRow;
        Update: Partial<TaxProfileChangeRow>;
      };
      flipdesk_ebay_listings: {
        Row: EbayListingRow;
        Insert: EbayListingInsert;
        Update: EbayListingUpdate;
      };
      flipdesk_settings: {
        Row: FlipdeskSettingsRow;
        Insert: FlipdeskSettingsInsert;
        Update: FlipdeskSettingsUpdate;
      };
      listing_snippets: {
        Row: ListingSnippetRow;
        Insert: ListingSnippetInsert;
        Update: ListingSnippetUpdate;
      };
      ai_enrichment_log: {
        Row: AiEnrichmentLogRow;
        Insert: AiEnrichmentLogInsert;
        Update: AiEnrichmentLogUpdate;
      };
      grade_outcomes: {
        Row: GradeOutcomeRow;
        Insert: Partial<Omit<GradeOutcomeRow, "id" | "created_at" | "updated_at">>;
        Update: Partial<Omit<GradeOutcomeRow, "id" | "created_at" | "updated_at">>;
      };
      grade_credit_transactions: {
        Row: GradeCreditTransactionRow;
        // Service-role only — clients should call debit_grade_credits /
        // grant_grade_credits RPCs, not insert directly.
        Insert: Partial<Omit<GradeCreditTransactionRow, "id" | "created_at">>;
        Update: never;
      };
      flipdesk_subscription_events: {
        Row: FlipdeskSubscriptionEventRow;
        Insert: FlipdeskSubscriptionEventInsert;
        Update: never;
      };
      pricing_plans: {
        Row: PricingPlanRow;
        // Service-role only (audited admin edge route) — clients read but never write.
        Insert: never;
        Update: never;
      };
      content_topics: {
        Row: ContentTopicRow;
        Insert: ContentTopicInsert;
        Update: ContentTopicUpdate;
      };
      blog_posts: {
        Row: BlogPostRow;
        Insert: BlogPostInsert;
        Update: BlogPostUpdate;
      };
      social_posts: {
        Row: SocialPostRow;
        Insert: SocialPostInsert;
        Update: SocialPostUpdate;
      };
      social_platform_variants: {
        Row: SocialPlatformVariantRow;
        Insert: Omit<SocialPlatformVariantRow, "id" | "created_at" | "updated_at">;
        Update: Partial<
          Omit<SocialPlatformVariantRow, "id" | "social_post_id" | "created_at" | "updated_at">
        >;
      };
      content_knowledge: {
        Row: ContentKnowledgeRow;
        Insert: Pick<ContentKnowledgeRow, "key" | "title" | "body_md"> & {
          token_count_est?: number;
        };
        Update: Partial<Pick<ContentKnowledgeRow, "title" | "body_md" | "token_count_est">>;
      };
      content_settings: {
        Row: ContentSettingsRow;
        Insert: Partial<ContentSettingsRow> & { id: number };
        Update: Partial<Omit<ContentSettingsRow, "id" | "created_at" | "updated_at">>;
      };
      workspace_members: {
        Row: WorkspaceMemberRow;
        Insert: WorkspaceMemberInsert;
        Update: WorkspaceMemberUpdate;
      };
      workspace_invitations: {
        Row: WorkspaceInvitationRow;
        Insert: WorkspaceInvitationInsert;
        Update: WorkspaceInvitationUpdate;
      };
      mfa_recovery_codes: {
        Row: MfaRecoveryCodeRow;
        Insert: Pick<MfaRecoveryCodeRow, "user_id" | "code_hash"> &
          Partial<Pick<MfaRecoveryCodeRow, "used_at">>;
        Update: Partial<Pick<MfaRecoveryCodeRow, "used_at">>;
      };
      legal_acceptances: {
        Row: LegalAcceptanceRow;
        Insert: Pick<LegalAcceptanceRow, "user_id" | "tos_version" | "privacy_version" | "method"> &
          Partial<Pick<LegalAcceptanceRow, "user_agent" | "ip_address" | "accepted_at">>;
        Update: never;
      };
      // Growth / Promote suite (00102)
      audience_segments: {
        Row: AudienceSegmentRow;
        Insert: AudienceSegmentInsert;
        Update: AudienceSegmentUpdate;
      };
      growth_campaigns: {
        Row: GrowthCampaignRow;
        Insert: GrowthCampaignInsert;
        Update: GrowthCampaignUpdate;
      };
      campaign_recipients: {
        Row: CampaignRecipientRow;
        Insert: CampaignRecipientInsert;
        Update: CampaignRecipientUpdate;
      };
      announcements: {
        Row: AnnouncementRow;
        Insert: AnnouncementInsert;
        Update: AnnouncementUpdate;
      };
      announcement_dismissals: {
        Row: AnnouncementDismissalRow;
        Insert: AnnouncementDismissalInsert;
        Update: never;
      };
      referral_codes: {
        Row: ReferralCodeRow;
        Insert: ReferralCodeInsert;
        Update: never;
      };
      referral_events: {
        Row: ReferralEventRow;
        Insert: ReferralEventInsert;
        Update: ReferralEventUpdate;
      };
      affiliate_clicks: {
        Row: AffiliateClickRow;
        Insert: AffiliateClickInsert;
        Update: AffiliateClickUpdate;
      };
    };
    Views: {
      // US-348: column-restricted public certificate projection.
      public_grade_reports: {
        Row: PublicGradeReportRow;
      };
      // US-1091: PII-free map from a public certificate_id to its Garment
      // Passport slug (migration 00257).
      public_passport_links: {
        Row: { certificate_id: string; passport_slug: string };
      };
    };
    Enums: {
      user_plan: UserPlan;
      flipdesk_plan: FlipdeskPlan;
      subscription_status: SubscriptionStatus;
      garment_type: GarmentType;
      garment_category: GarmentCategory;
      submission_status: SubmissionStatus;
      grade_tier: GradeTier;
      image_type: ImageType;
      dispute_status: DisputeStatus;
      item_status: ItemStatus;
      listing_platform: ListingPlatform;
      user_role: UserRole;
      notification_type: NotificationType;
      flipdesk_source_type: FlipdeskSourceType;
      item_category: ItemCategory;
      flipdesk_photo_type: FlipdeskPhotoType;
      listing_status: ListingStatus;
      grading_submission_tier: GradingSubmissionTier;
      payout_import_method: PayoutImportMethod;
      content_surface: ContentSurface;
      content_product: ContentProduct;
      content_status: ContentStatus;
      topic_status: TopicStatus;
      content_generated_by: ContentGeneratedBy;
      content_topic_source: ContentTopicSource;
      workspace_role: WorkspaceRole;
      campaign_channel: CampaignChannel;
      campaign_status: CampaignStatus;
      campaign_recipient_status: CampaignRecipientStatus;
      announcement_variant: AnnouncementVariant;
      referral_reward_status: ReferralRewardStatus;
    };
  };
}
