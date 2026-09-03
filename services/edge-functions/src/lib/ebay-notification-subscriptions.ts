// eBay Notification API subscription + destination management (US-1964).
//
// ↳ The destination-mapping CORRECTNESS constraint (an account-deletion event
//   sent to the general receiver is silently dropped) is carried in
//   vault/30-platform/ebay-condition-and-policies.md.
//
// Everything inbound from eBay (sales, payouts, returns, account deletion) is
// delivered by the Notification API to a *destination* we register, for each
// *topic* we subscribe. Before this module those were configured BY HAND in the
// developer portal, per environment, with no way to see from inside the app
// whether a topic was actually subscribed — so a topic nobody ever enabled (or
// one eBay disabled after delivery failures) silently stopped a seller's
// revenue sync with no signal anywhere. This module makes that state readable
// and repairable from the edge service.
//
// Auth: the Notification API's destination/subscription surface is
// APPLICATION-scoped (one config per app + environment), not per-seller, so
// every call here uses the client-credentials app token — NOT a user token.
// That is also why health is reported "per environment" (sandbox vs production
// are entirely separate configs; getEbayEnv() picks which one we're talking to).
//
// Topic names: eBay renames/extends topics over time (ITEM_SOLD,
// FIXED_PRICE_TRANSACTION, ORDER_*, RETURN_*, CANCEL_*, ...), so we do NOT hard
// code a topic allow-list. We read eBay's own topic catalog and classify each
// entry through the SAME substring router the inbound receiver uses
// (classifyEbayTopic) — so a topic eBay adds tomorrow is picked up here and
// handled by the receiver without a code change, and the two can never drift.
//
// Two destinations, deliberately:
//   • general  → EBAY_NOTIFICATION_ENDPOINT_URL (the order/payout/return
//     receiver, POST /api/flipdesk/webhooks/ebay)
//   • deletion → EBAY_DELETION_ENDPOINT_URL (the dedicated compliance handler,
//     POST /api/flipdesk/webhooks/ebay/account-deletion)
// They are NOT interchangeable: the general receiver classifies an
// account-deletion event as an unhandled topic and DROPS it. Pointing the
// account-deletion topic at the general destination would therefore turn a
// compliance obligation into a silent no-op — so the bucket→destination mapping
// below is a correctness constraint, not a preference.
//
// Both endpoints answer eBay's GET challenge handshake with the same
// EBAY_VERIFICATION_TOKEN; eBay validates a destination by calling it, so a
// destination create/update fails if the endpoint can't answer.

import {
  apiHost,
  ebayResilientFetch,
  getAppAccessToken,
  getEbayEnv,
  type EbayEnv,
} from "./ebay-client.ts";
import { classifyEbayTopic, type EbayTopicBucket } from "./ebay-webhook-topics.ts";

// The lifecycle buckets inbound sync depends on. `unhandled` is, by definition,
// not required — it's the router's "we don't act on this" sink.
export type RequiredBucket = Exclude<EbayTopicBucket, "unhandled">;

export const REQUIRED_BUCKETS: readonly RequiredBucket[] = [
  "order",
  "payout",
  "return",
  // US-2656. Adding it here is what actually subscribes eBay's listing-lifecycle
  // topics: the reconcile below walks eBay's own catalog and keeps every topic
  // classifyEbayTopic puts in a required bucket, so a bucket that is not listed
  // here is a bucket whose topics are never subscribed and never delivered.
  "listing",
  "account_deletion",
];

/** Which destination a bucket's notifications must be delivered to. */
export type DestinationKind = "general" | "deletion";

export function destinationKindForBucket(bucket: RequiredBucket): DestinationKind {
  return bucket === "account_deletion" ? "deletion" : "general";
}

export function notificationEndpointUrl(): string {
  return (
    Deno.env.get("EBAY_NOTIFICATION_ENDPOINT_URL")?.trim() ||
    "https://functions.gradethread.com/api/flipdesk/webhooks/ebay"
  );
}

export function deletionEndpointUrl(): string {
  return (
    Deno.env.get("EBAY_DELETION_ENDPOINT_URL")?.trim() ||
    "https://functions.gradethread.com/api/flipdesk/webhooks/ebay/account-deletion"
  );
}

export function endpointUrlFor(kind: DestinationKind): string {
  return kind === "deletion" ? deletionEndpointUrl() : notificationEndpointUrl();
}

// Destination names are per-app identifiers we own; scoping them by env keeps a
// sandbox destination from ever being mistaken for (or overwritten by) prod.
export function destinationNameFor(kind: DestinationKind, env: EbayEnv): string {
  return `gradethread-${kind}-${env}`;
}

// ── Wire types (only the fields we use) ────────────────────────────────

// ⚠ Every field is `unknown` ON PURPOSE. These are eBay's words, not ours, and
// the optimistic `format?: string` here is what crashed the reconcile cron with
// "(p.format ?? "").toUpperCase is not a function" — eBay sent something that
// was not a string and TypeScript, which only checks OUR code, had no say.
// Read them through `tokens()` below, never directly.
export interface TopicPayload {
  format?: unknown;
  schemaVersion?: unknown;
  deliveryProtocol?: unknown;
}

export interface EbayNotificationTopic {
  topicId: string;
  status: string | null;
  // The schemaVersion of this topic's HTTPS+JSON payload — required when
  // creating the subscription. Null when the topic offers no such payload.
  schemaVersion: string | null;
}

export interface EbaySubscription {
  subscriptionId: string;
  topicId: string;
  status: string | null;
  destinationId: string | null;
}

export interface EbayDestination {
  destinationId: string;
  name: string | null;
  status: string | null;
  endpoint: string | null;
}

// ── Pure helpers (unit-tested without a live eBay) ─────────────────────

/**
 * Pick the schemaVersion of a topic's HTTPS + JSON payload — the only delivery
 * shape our receiver speaks. Returns null when the topic advertises none, which
 * makes the topic unsubscribable by us (we skip it rather than guess a version:
 * eBay rejects a create with an unsupported schemaVersion).
 */
export function pickHttpsJsonSchemaVersion(
  payloads: TopicPayload[] | undefined,
): string | null {
  for (const p of payloads ?? []) {
    if (!p || typeof p !== "object") continue;
    const proto = tokens(p.deliveryProtocol);
    const format = tokens(p.format);
    const version = scalar(p.schemaVersion);
    if (proto.includes("HTTPS") && format.includes("JSON") && version) {
      return version;
    }
  }
  return null;
}

/**
 * Upper-case every string eBay might have hidden in a field that our types say
 * is a scalar. Accepts the scalar itself, an array of them (eBay documents
 * `deliveryProtocols` plural on some topics), or an object wrapping one under
 * `value`/`format`/`protocol`. Anything else yields no tokens, which reads as
 * "this payload is not HTTPS+JSON" — the safe answer, because an unsubscribable
 * topic is skipped rather than created with a version eBay would reject.
 */
function tokens(value: unknown): string[] {
  if (typeof value === "string") return [value.trim().toUpperCase()];
  if (Array.isArray(value)) return value.flatMap(tokens);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return tokens(o.value ?? o.format ?? o.protocol ?? o.name);
  }
  return [];
}

/** The scalar form of a field we hand back to eBay verbatim (schemaVersion). */
function scalar(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = scalar(v);
      if (s) return s;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return scalar(o.value ?? o.schemaVersion ?? o.version);
  }
  return null;
}

const isEnabled = (status: string | null | undefined): boolean =>
  tokens(status).includes("ENABLED");

/** Group eBay's topic catalog by the lifecycle bucket our router assigns it. */
export function topicsByBucket(
  topics: EbayNotificationTopic[],
): Map<RequiredBucket, EbayNotificationTopic[]> {
  const byBucket = new Map<RequiredBucket, EbayNotificationTopic[]>();
  for (const topic of topics) {
    const bucket = classifyEbayTopic(topic.topicId);
    if (bucket === "unhandled") continue;
    const list = byBucket.get(bucket);
    if (list) list.push(topic);
    else byBucket.set(bucket, [topic]);
  }
  return byBucket;
}

export interface TopicHealth {
  topicId: string;
  subscribed: boolean;
  status: string | null;
  destinationId: string | null;
  // True when an ENABLED subscription exists but delivers somewhere OTHER than
  // the destination this bucket must use — i.e. eBay thinks it's fine, but the
  // events never reach us. Invisible without this check.
  misrouted: boolean;
}

export interface BucketHealth {
  bucket: RequiredBucket;
  destination: DestinationKind;
  endpoint: string;
  /** At least one enabled, correctly-routed subscription exists for this bucket. */
  healthy: boolean;
  topics: TopicHealth[];
}

export interface NotificationHealth {
  env: EbayEnv;
  destinations: Array<{
    kind: DestinationKind;
    endpoint: string;
    destinationId: string | null;
    status: string | null;
  }>;
  buckets: BucketHealth[];
  missingBuckets: RequiredBucket[];
  ok: boolean;
}

export interface HealthInput {
  env: EbayEnv;
  topics: EbayNotificationTopic[];
  subscriptions: EbaySubscription[];
  /** Our destination ids, by kind; null when that destination doesn't exist yet. */
  destinationIds: Record<DestinationKind, string | null>;
  destinationStatus?: Partial<Record<DestinationKind, string | null>>;
}

/**
 * Fold eBay's topic catalog + our subscriptions into a per-bucket health
 * report. A bucket is healthy only when some topic in it has an ENABLED
 * subscription pointing at the destination that bucket must use — being
 * "subscribed" to a destination we don't own delivers nothing to us.
 *
 * A bucket eBay's catalog has NO topic for is reported with an empty topic list
 * and healthy:false, so a router/catalog drift surfaces as a missing bucket
 * rather than silently passing.
 */
export function summarizeNotificationHealth(input: HealthInput): NotificationHealth {
  const { env, topics, subscriptions, destinationIds } = input;
  const byBucket = topicsByBucket(topics);
  const subsByTopic = new Map<string, EbaySubscription>();
  for (const sub of subscriptions) {
    // Prefer an enabled subscription when a topic somehow has several.
    const existing = subsByTopic.get(sub.topicId);
    if (!existing || (!isEnabled(existing.status) && isEnabled(sub.status))) {
      subsByTopic.set(sub.topicId, sub);
    }
  }

  const buckets: BucketHealth[] = REQUIRED_BUCKETS.map((bucket) => {
    const kind = destinationKindForBucket(bucket);
    const wantDestination = destinationIds[kind];
    const topicHealth: TopicHealth[] = (byBucket.get(bucket) ?? []).map((topic) => {
      const sub = subsByTopic.get(topic.topicId) ?? null;
      const enabled = !!sub && isEnabled(sub.status);
      const routed = !!sub && !!wantDestination && sub.destinationId === wantDestination;
      return {
        topicId: topic.topicId,
        subscribed: !!sub,
        status: sub?.status ?? null,
        destinationId: sub?.destinationId ?? null,
        misrouted: enabled && !routed,
      };
    });
    return {
      bucket,
      destination: kind,
      endpoint: endpointUrlFor(kind),
      healthy: topicHealth.some((t) => t.subscribed && isEnabled(t.status) && !t.misrouted),
      topics: topicHealth,
    };
  });

  const missingBuckets = buckets.filter((b) => !b.healthy).map((b) => b.bucket);
  return {
    env,
    destinations: (["general", "deletion"] as DestinationKind[]).map((kind) => ({
      kind,
      endpoint: endpointUrlFor(kind),
      destinationId: destinationIds[kind],
      status: input.destinationStatus?.[kind] ?? null,
    })),
    buckets,
    missingBuckets,
    ok: missingBuckets.length === 0,
  };
}

export interface SubscriptionAction {
  topicId: string;
  bucket: RequiredBucket;
  destinationId: string;
  schemaVersion: string;
}

export interface SubscriptionPlan {
  /** Topics with no subscription at all → POST a new one. */
  create: SubscriptionAction[];
  /** Existing but DISABLED subscriptions → enable in place (never duplicate). */
  enable: Array<{ subscriptionId: string; topicId: string; bucket: RequiredBucket }>;
  /** Enabled but pointing at the wrong destination → PUT to re-point. */
  repoint: Array<SubscriptionAction & { subscriptionId: string }>;
  /** Topics we can't act on, with why (no HTTPS+JSON payload, missing destination). */
  skipped: Array<{ topicId: string; reason: string }>;
}

/**
 * Decide the minimal set of writes that brings eBay's subscription state in
 * line with what inbound sync needs.
 *
 * IDEMPOTENCY (AC3) lives here: an already-ENABLED, correctly-routed
 * subscription produces NO action, so re-running the reconcile is a no-op and
 * can never duplicate a destination or subscription. eBay allows exactly one
 * subscription per (app, topic) — hence "enable"/"repoint" the existing row
 * rather than creating a second one, which eBay would reject anyway.
 *
 * `onlyBuckets` narrows the plan (the reconcile cron passes nothing; a caller
 * that wants to leave account-deletion alone passes the other three).
 */
export function planSubscriptionActions(args: {
  topics: EbayNotificationTopic[];
  subscriptions: EbaySubscription[];
  destinationIds: Record<DestinationKind, string | null>;
  onlyBuckets?: readonly RequiredBucket[];
}): SubscriptionPlan {
  const { topics, subscriptions, destinationIds } = args;
  const wanted = args.onlyBuckets ?? REQUIRED_BUCKETS;
  const byBucket = topicsByBucket(topics);
  const subsByTopic = new Map<string, EbaySubscription>();
  for (const sub of subscriptions) {
    const existing = subsByTopic.get(sub.topicId);
    if (!existing || (!isEnabled(existing.status) && isEnabled(sub.status))) {
      subsByTopic.set(sub.topicId, sub);
    }
  }

  const plan: SubscriptionPlan = { create: [], enable: [], repoint: [], skipped: [] };

  for (const bucket of wanted) {
    const kind = destinationKindForBucket(bucket);
    const destinationId = destinationIds[kind];
    for (const topic of byBucket.get(bucket) ?? []) {
      // Only ENABLED topics can carry a subscription; eBay rejects the rest.
      if (topic.status && !isEnabled(topic.status)) {
        plan.skipped.push({
          topicId: topic.topicId,
          reason: `topic status ${topic.status}`,
        });
        continue;
      }
      if (!destinationId) {
        plan.skipped.push({
          topicId: topic.topicId,
          reason: `no ${kind} destination`,
        });
        continue;
      }
      if (!topic.schemaVersion) {
        plan.skipped.push({
          topicId: topic.topicId,
          reason: "no HTTPS+JSON payload advertised",
        });
        continue;
      }
      const sub = subsByTopic.get(topic.topicId);
      const action: SubscriptionAction = {
        topicId: topic.topicId,
        bucket,
        destinationId,
        schemaVersion: topic.schemaVersion,
      };
      if (!sub) {
        plan.create.push(action);
        continue;
      }
      if (sub.destinationId && sub.destinationId !== destinationId) {
        plan.repoint.push({ ...action, subscriptionId: sub.subscriptionId });
        continue;
      }
      if (!isEnabled(sub.status)) {
        plan.enable.push({
          subscriptionId: sub.subscriptionId,
          topicId: topic.topicId,
          bucket,
        });
      }
      // Enabled + correctly routed → no action (the idempotent steady state).
    }
  }
  return plan;
}

// ── Notification API calls ─────────────────────────────────────────────

const NOTIFICATION_BASE = "/commerce/notification/v1";

async function notificationFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAppAccessToken();
  return await ebayResilientFetch(
    `${apiHost()}${NOTIFICATION_BASE}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    },
    { label: `notification ${init.method ?? "GET"} ${path}` },
  );
}

async function notificationJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await notificationFetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(
      `eBay Notification API ${init?.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 400)}`,
    ) as Error & { status: number; body: string };
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const body = await res.text();
  return (body ? JSON.parse(body) : {}) as T;
}

// eBay paginates topics/subscriptions with an opaque continuation token. Bound
// the walk so a pathological response can't spin the cron forever.
const PAGE_CEILING = 20;
const PAGE_LIMIT = 100;

async function listPaged<TWire, TOut>(
  path: string,
  key: string,
  map: (row: TWire) => TOut | null,
): Promise<TOut[]> {
  const out: TOut[] = [];
  let continuation: string | null = null;
  for (let i = 0; i < PAGE_CEILING; i++) {
    const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (continuation) qs.set("continuation_token", continuation);
    const payload = await notificationJson<
      Record<string, unknown> & { continuationToken?: string }
    >(`${path}?${qs.toString()}`);
    const rows = (payload[key] as TWire[] | undefined) ?? [];
    for (const row of rows) {
      const mapped = map(row);
      if (mapped) out.push(mapped);
    }
    continuation = payload.continuationToken ?? null;
    if (!continuation) break;
  }
  return out;
}

export async function listNotificationTopics(): Promise<EbayNotificationTopic[]> {
  return await listPaged<
    {
      topicId?: string;
      status?: unknown;
      supportedPayloads?: TopicPayload[];
    },
    EbayNotificationTopic
  >("/topic", "topics", (row) =>
    row.topicId
      ? {
          topicId: row.topicId,
          status: scalar(row.status),
          schemaVersion: pickHttpsJsonSchemaVersion(row.supportedPayloads),
        }
      : null);
}

export async function listSubscriptions(): Promise<EbaySubscription[]> {
  return await listPaged<
    {
      subscriptionId?: string;
      topicId?: string;
      status?: unknown;
      destinationId?: string;
    },
    EbaySubscription
  >("/subscription", "subscriptions", (row) =>
    row.subscriptionId && row.topicId
      ? {
          subscriptionId: row.subscriptionId,
          topicId: row.topicId,
          status: scalar(row.status),
          destinationId: row.destinationId ?? null,
        }
      : null);
}

export async function listDestinations(): Promise<EbayDestination[]> {
  return await listPaged<
    {
      destinationId?: string;
      name?: unknown;
      status?: unknown;
      deliveryConfig?: { endpoint?: unknown };
    },
    EbayDestination
  >("/destination", "destinations", (row) =>
    row.destinationId
      ? {
          destinationId: row.destinationId,
          name: scalar(row.name),
          status: scalar(row.status),
          endpoint: scalar(row.deliveryConfig?.endpoint),
        }
      : null);
}

/** eBay returns the new id in the Location header: .../destination/{id} */
export function idFromLocation(location: string | null): string | null {
  if (!location) return null;
  const trimmed = location.split("?")[0].replace(/\/+$/, "");
  const id = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return id || null;
}

/**
 * Find-or-create our destination for `kind`, updating it in place when the
 * registered endpoint has drifted from config.
 *
 * Matching is by our own env-scoped NAME, not by endpoint, so a config change
 * (endpoint moved) updates the SAME destination instead of creating a second
 * one — the duplicate-destination trap AC3 calls out. Returns null when eBay
 * refuses the destination (e.g. it couldn't validate our challenge handshake);
 * the caller reports it rather than throwing the whole reconcile away.
 */
export async function ensureDestination(
  kind: DestinationKind,
  existing: EbayDestination[],
  verificationToken: string,
): Promise<EbayDestination | null> {
  const env = getEbayEnv();
  const name = destinationNameFor(kind, env);
  const endpoint = endpointUrlFor(kind);
  const body = {
    name,
    status: "ENABLED",
    deliveryConfig: { endpoint, verificationToken },
  };

  const match = existing.find((d) => d.name === name);
  if (match) {
    // Already correct → no write at all (idempotent steady state).
    if (match.endpoint === endpoint && isEnabled(match.status)) return match;
    await notificationJson(`/destination/${encodeURIComponent(match.destinationId)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return { ...match, endpoint, status: "ENABLED" };
  }

  const res = await notificationFetch("/destination", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(
      `[ebay-notify] could not create ${kind} destination (${res.status}): ${text.slice(0, 300)}`,
    );
    return null;
  }
  const destinationId = idFromLocation(res.headers.get("location"));
  if (!destinationId) {
    // Some eBay responses carry the body instead of a Location header.
    const text = await res.text().catch(() => "");
    try {
      const parsed = JSON.parse(text) as { destinationId?: string };
      if (parsed.destinationId) {
        return { destinationId: parsed.destinationId, name, status: "ENABLED", endpoint };
      }
    } catch {
      // fall through
    }
    console.warn(`[ebay-notify] ${kind} destination created but no id returned`);
    return null;
  }
  return { destinationId, name, status: "ENABLED", endpoint };
}

// eBay's "you already have this" responses. The account-deletion topic in
// particular is usually ALREADY subscribed via the developer portal (AC3), so a
// create that collides is the DESIRED state, not a failure — we treat it as a
// success and let the post-reconcile health read report the real state.
function isAlreadyExistsError(err: unknown): boolean {
  const e = err as { status?: number; body?: string };
  if (e?.status === 409) return true;
  const body = (e?.body ?? "").toLowerCase();
  return (
    body.includes("already exist") ||
    body.includes("already subscribed") ||
    body.includes("already in use") ||
    body.includes("duplicate")
  );
}

export interface ReconcileResult {
  env: EbayEnv;
  created: string[];
  enabled: string[];
  repointed: string[];
  alreadyCurrent: number;
  skipped: Array<{ topicId: string; reason: string }>;
  errors: Array<{ topicId: string; message: string }>;
  health: NotificationHealth;
}

/**
 * Bring eBay's destination + subscription config in line with what inbound sync
 * requires, then report health.
 *
 * Safe to run repeatedly and concurrently: every step is find-or-create keyed on
 * a stable name/topic, so the steady state performs zero writes. Per-topic
 * errors are collected rather than thrown so one bad topic can't abort the rest
 * of the reconcile — the returned health still tells the truth about what
 * landed.
 */
export async function reconcileNotifications(opts: {
  verificationToken: string;
  onlyBuckets?: readonly RequiredBucket[];
}): Promise<ReconcileResult> {
  const env = getEbayEnv();
  const [topics, destinations] = await Promise.all([
    listNotificationTopics(),
    listDestinations(),
  ]);

  const general = await ensureDestination("general", destinations, opts.verificationToken);
  const deletion = await ensureDestination("deletion", destinations, opts.verificationToken);
  const destinationIds: Record<DestinationKind, string | null> = {
    general: general?.destinationId ?? null,
    deletion: deletion?.destinationId ?? null,
  };

  const subscriptions = await listSubscriptions();
  const plan = planSubscriptionActions({
    topics,
    subscriptions,
    destinationIds,
    onlyBuckets: opts.onlyBuckets,
  });

  const result: Omit<ReconcileResult, "health"> = {
    env,
    created: [],
    enabled: [],
    repointed: [],
    alreadyCurrent: 0,
    skipped: plan.skipped,
    errors: [],
  };

  for (const action of plan.create) {
    try {
      await notificationJson("/subscription", {
        method: "POST",
        body: JSON.stringify({
          topicId: action.topicId,
          status: "ENABLED",
          destinationId: action.destinationId,
          payload: {
            format: "JSON",
            schemaVersion: action.schemaVersion,
            deliveryProtocol: "HTTPS",
          },
        }),
      });
      result.created.push(action.topicId);
    } catch (err) {
      if (isAlreadyExistsError(err)) {
        result.alreadyCurrent++;
        continue;
      }
      result.errors.push({
        topicId: action.topicId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const action of plan.repoint) {
    try {
      await notificationJson(`/subscription/${encodeURIComponent(action.subscriptionId)}`, {
        method: "PUT",
        body: JSON.stringify({
          topicId: action.topicId,
          status: "ENABLED",
          destinationId: action.destinationId,
          payload: {
            format: "JSON",
            schemaVersion: action.schemaVersion,
            deliveryProtocol: "HTTPS",
          },
        }),
      });
      result.repointed.push(action.topicId);
    } catch (err) {
      result.errors.push({
        topicId: action.topicId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const action of plan.enable) {
    try {
      await notificationJson(
        `/subscription/${encodeURIComponent(action.subscriptionId)}/enable`,
        { method: "POST" },
      );
      result.enabled.push(action.topicId);
    } catch (err) {
      result.errors.push({
        topicId: action.topicId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Re-read so health reflects what eBay actually accepted, not what we hoped.
  const finalSubs = await listSubscriptions();
  const health = summarizeNotificationHealth({
    env,
    topics,
    subscriptions: finalSubs,
    destinationIds,
    destinationStatus: { general: general?.status ?? null, deletion: deletion?.status ?? null },
  });
  return { ...result, health };
}

/** Read-only health probe — no writes, safe for a dashboard GET. */
export async function getNotificationHealth(): Promise<NotificationHealth> {
  const env = getEbayEnv();
  const [topics, destinations, subscriptions] = await Promise.all([
    listNotificationTopics(),
    listDestinations(),
    listSubscriptions(),
  ]);
  const find = (kind: DestinationKind) =>
    destinations.find((d) => d.name === destinationNameFor(kind, env)) ?? null;
  const general = find("general");
  const deletion = find("deletion");
  return summarizeNotificationHealth({
    env,
    topics,
    subscriptions,
    destinationIds: {
      general: general?.destinationId ?? null,
      deletion: deletion?.destinationId ?? null,
    },
    destinationStatus: { general: general?.status ?? null, deletion: deletion?.status ?? null },
  });
}

/**
 * The AC4 warning line. Shared by the reconcile cron and the admin probe so the
 * wording (and the decision of what counts as "unsubscribed") can't drift.
 */
export function warnOnMissingTopics(health: NotificationHealth, source: string): void {
  if (health.ok) return;
  console.warn(
    `[ebay-notify] ${source}: eBay notification topics NOT subscribed for env=${health.env}: ` +
      `${health.missingBuckets.join(", ")} — inbound sync for these depends on the order-sync backstop until fixed`,
  );
}
