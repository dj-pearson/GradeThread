import { useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { track } from "@/lib/analytics";
import { useAuthStore } from "@/stores/auth-store";
import {
  appendSnapHistory,
  readSnapHistory,
  type SnapHistoryEntry,
  type SnapHistoryWrite,
} from "@/lib/snap-history";

// Snap-to-Value (US-612/614): upload a photo, get an instant condition grade
// estimate plus a condition-adjusted resale value range. Signup-gated and
// monthly-capped.

export interface SnapValue {
  lowCents: number | null;
  medianCents: number | null;
  highCents: number | null;
  sampleSize: number;
  confidence: number;
  sufficient: boolean;
  currency: string;
  /** SNAP-09: the eBay category the comps were drawn from, when resolved. */
  category_name?: string | null;
}

export interface SnapUsage {
  used: number;
  cap: number | null;
  resets_at: string;
}

export interface SnapResult {
  grade: {
    overall_score: number;
    grade_tier: string;
    confidence: number;
    factor_scores: Record<string, number>;
    /** SNAP-09: the grade fell under the human-review bar or had a cap applied. */
    needs_review?: boolean;
    /** SNAP-09: which confidence caps fired (codes only). */
    caps_applied?: string[];
    /** SNAP-09 / US-1836: the photo looks like a screenshot (boolean only). */
    screenshot_detected?: boolean;
  };
  value: SnapValue | null;
  /** SNAP-09: the owner's monthly snap usage after this one. cap null = unlimited. */
  usage?: SnapUsage | null;
  // US-952: best-effort AI-detected garment type/category from the snap photo,
  // used to prefill the certified-grade form on upgrade. null when undetected.
  garment?: { type: string | null; category: string | null } | null;
  estimate: true;
  disclaimer: string;
}

// US-952: the snap -> certified-grade bridge payload, passed as React Router
// navigation state from snap.tsx to new-submission.tsx. All fields optional so
// new-submission degrades gracefully when any signal is missing.
export interface SnapBridgeState {
  /** The original snap photo as a base64 data URI, re-staged into the Front slot. */
  imageDataUri?: string | null;
  brand?: string;
  title?: string;
  garmentType?: string;
  garmentCategory?: string;
}

export interface SnapInput {
  imageDataUri: string; // data:image/...;base64,...
  brand?: string;
  keyword?: string;
}

/**
 * SNAP-07: what the page should do about a failure.
 *  - limit: the monthly or per-network allowance is spent (upgrade card)
 *  - rate: the per-minute burst limit (countdown)
 *  - unavailable: paused, over budget or at capacity (calm, check not used)
 *  - network: never reached the server (retry, photo kept)
 *  - auth: signed out
 *  - invalid: a 200 whose body is not an estimate
 *  - failed: everything else, including a client timeout
 */
export type SnapErrorKind =
  | "limit"
  | "rate"
  | "unavailable"
  | "network"
  | "auth"
  | "invalid"
  | "failed";

export interface SnapError extends Error {
  code?: string;
  action?: string;
  status?: number;
  retryAfterSec?: number;
  kind: SnapErrorKind;
}

const LIMIT_CODES = new Set(["SNAP_LIMIT_REACHED", "SNAP_IP_LIMIT_REACHED"]);
const UNAVAILABLE_CODES = new Set([
  "FEATURE_DISABLED",
  "AI_BUDGET_EXCEEDED",
  "SNAP_UNAVAILABLE",
  "AI_AT_CAPACITY",
]);

export function classifySnapError(status: number, code?: string): SnapErrorKind {
  if (code && LIMIT_CODES.has(code)) return "limit";
  if (code && UNAVAILABLE_CODES.has(code)) return "unavailable";
  if (status === 429) return "rate";
  if (status === 503) return "unavailable";
  if (status === 401) return "auth";
  return "failed";
}

function makeError(
  message: string,
  kind: SnapErrorKind,
  extra: Partial<Omit<SnapError, "kind" | "message" | "name">> = {},
): SnapError {
  const err = new Error(message) as SnapError;
  err.kind = kind;
  Object.assign(err, extra);
  return err;
}

function parseRetryAfter(header: string | null, bodyValue: unknown): number | undefined {
  const fromBody = typeof bodyValue === "number" && Number.isFinite(bodyValue) ? bodyValue : undefined;
  const fromHeader = header != null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : undefined;
  const v = fromHeader ?? fromBody;
  return v != null && v > 0 ? Math.min(Math.ceil(v), 3600) : undefined;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * SNAP-07: a 200 must be an estimate before the card dereferences it. A body
 * that failed to parse used to come back as `{}` and crash at
 * `overall_score.toFixed`. Returns null when the grade itself is unusable;
 * value and garment are coerced rather than trusted.
 */
export function parseSnapResult(body: unknown): SnapResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const g = b.grade as Record<string, unknown> | null | undefined;
  if (!g || typeof g !== "object") return null;
  if (typeof g.overall_score !== "number" || !Number.isFinite(g.overall_score)) return null;
  if (typeof g.grade_tier !== "string") return null;

  let value: SnapValue | null = null;
  const v = b.value as Record<string, unknown> | null | undefined;
  if (v && typeof v === "object") {
    const low = finiteOrNull(v.lowCents);
    const high = finiteOrNull(v.highCents);
    value = {
      lowCents: low,
      medianCents: finiteOrNull(v.medianCents),
      highCents: high,
      sampleSize: finiteOrNull(v.sampleSize) ?? 0,
      confidence: finiteOrNull(v.confidence) ?? 0,
      // A range with no ends is not a price, whatever the flag says.
      sufficient: v.sufficient === true && low != null && high != null,
      currency: typeof v.currency === "string" && v.currency ? v.currency : "USD",
      category_name: typeof v.category_name === "string" ? v.category_name : null,
    };
  }

  const gar = b.garment as Record<string, unknown> | null | undefined;
  const garment = gar && typeof gar === "object"
    ? {
        type: typeof gar.type === "string" ? gar.type : null,
        category: typeof gar.category === "string" ? gar.category : null,
      }
    : null;

  const u = b.usage as Record<string, unknown> | null | undefined;
  const usage = u && typeof u === "object" && finiteOrNull(u.used) != null
    ? {
        used: finiteOrNull(u.used)!,
        cap: finiteOrNull(u.cap),
        resets_at: typeof u.resets_at === "string" ? u.resets_at : "",
      }
    : null;

  const factors = g.factor_scores && typeof g.factor_scores === "object"
    ? Object.fromEntries(
        Object.entries(g.factor_scores as Record<string, unknown>).filter(
          (e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]),
        ),
      )
    : {};

  return {
    grade: {
      overall_score: g.overall_score,
      grade_tier: g.grade_tier,
      confidence: finiteOrNull(g.confidence) ?? 0,
      factor_scores: factors,
      needs_review: g.needs_review === true,
      caps_applied: Array.isArray(g.caps_applied)
        ? g.caps_applied.filter((c): c is string => typeof c === "string")
        : [],
      screenshot_detected: g.screenshot_detected === true,
    },
    value,
    usage,
    garment,
    estimate: true,
    disclaimer: typeof b.disclaimer === "string" ? b.disclaimer : "",
  };
}

/** How long a snap may take before the page stops waiting. */
export const SNAP_TIMEOUT_MS = 45_000;

export interface UseSnapOptions {
  /** The list the page is showing, so the append builds on it. */
  getHistory?: () => SnapHistoryEntry[];
  /** Called with the history write after a successful snap. */
  onHistory?: (write: SnapHistoryWrite) => void;
}

export function useSnap(opts: UseSnapOptions = {}) {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  return useMutation<SnapResult, SnapError, SnapInput>({
    mutationFn: async (input) => {
      let res: Response;
      try {
        // SNAP-07: no silentGate. It never suppressed a snap 429 (the credit
        // dialog needs can_top_up) and it did switch off the workspace-2FA and
        // waitlist 403 handling this call should get.
        res = await edgeFetch("/api/grade/snap", {
          method: "POST",
          json: { image: input.imageDataUri, brand: input.brand, keyword: input.keyword },
          timeoutMs: SNAP_TIMEOUT_MS,
        });
      } catch (e) {
        // DOMException is not an Error subclass in every runtime.
        const name = e && typeof e === "object" && "name" in e ? String(e.name) : "";
        if (name === "TimeoutError" || name === "AbortError") {
          throw makeError(
            "This is taking too long, so we stopped waiting. If it finished on our side it counts as one check. Try again.",
            "failed",
          );
        }
        if (e instanceof Error && e.message === "You must be signed in.") {
          throw makeError("You were signed out. Sign in again to value this photo.", "auth");
        }
        if (e instanceof TypeError) {
          throw makeError(
            "No connection. Your photo is still here; try again when you have signal.",
            "network",
          );
        }
        throw makeError("Couldn't value that photo. Try again.", "failed");
      }
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        const code = typeof data?.code === "string" ? data.code : undefined;
        throw makeError(
          typeof data?.error === "string" ? data.error : "Couldn't value that photo",
          classifySnapError(res.status, code),
          {
            code,
            action: typeof data?.action === "string" ? data.action : undefined,
            status: res.status,
            retryAfterSec: parseRetryAfter(res.headers.get("Retry-After"), data?.retry_after),
          },
        );
      }
      const parsed = parseSnapResult(data);
      if (!parsed) {
        throw makeError("We got an answer we couldn't read. Try again.", "invalid", {
          status: res.status,
        });
      }
      return parsed;
    },
    // Hook-level, so the history write lands even if the page's observer has
    // detached (navigated away mid-grade). A failed snap has nothing to
    // revisit, and a refusal is not an estimate: success only.
    onSuccess: (data, input) => {
      const o = optsRef.current;
      const current = o.getHistory?.() ?? readSnapHistory(userId);
      const write = appendSnapHistory(userId, current, data, {
        brand: input.brand,
        keyword: input.keyword,
      });
      o.onHistory?.(write);
      track("snap.completed", {
        hasValue: data.value != null,
        sufficient: data.value?.sufficient === true,
        tier: data.grade.grade_tier,
      });
    },
    onError: (err) => {
      track("snap.failed", { kind: err.kind, code: err.code ?? null, status: err.status ?? null });
    },
  });
}
