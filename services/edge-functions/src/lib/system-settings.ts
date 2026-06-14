// DB-backed system settings registry — read helpers + validation (US-884).
//
// `system_settings` (migration 00207 + 00208) is a typed key→jsonb registry of
// operational constants (review confidence threshold, rate-limit caps, health
// thresholds, …) that operators tune WITHOUT a code deploy. This module is the
// single read path the rest of the edge service uses so the value is:
//   • served from a short-TTL in-process cache (one DB hit per key per window,
//     not per request — the grading hot path and the rate limiter both call it);
//   • busted immediately on an admin write (bustSettingCache) so an edit takes
//     effect on the next request instead of after the TTL;
//   • safe under failure — on a DB error we serve the last cached value if we
//     have one, else the caller's fallback (never throw on the hot path).
//
// Service-role only: every read goes through supabaseAdmin, and the table has no
// anon/authenticated RLS policy (deny-all), so it is never exposed to clients.

import { supabaseAdmin } from "./supabase.ts";

export type SettingValueType = "number" | "bool" | "string" | "json";
export const SETTING_VALUE_TYPES: readonly SettingValueType[] = [
  "number",
  "bool",
  "string",
  "json",
];

export function isSettingValueType(v: unknown): v is SettingValueType {
  return typeof v === "string" &&
    (SETTING_VALUE_TYPES as readonly string[]).includes(v);
}

export interface SystemSettingRow {
  key: string;
  value: unknown;
  value_type: SettingValueType;
  default_value: unknown;
  description: string | null;
  category: string;
  updated_at: string;
  updated_by: string | null;
}

// Short TTL: long enough to spare the DB on bursty hot paths, short enough that
// an edit lands quickly even if a write on another replica didn't bust THIS
// replica's cache (each replica busts only its own in-process map).
const TTL_MS = 30_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

// Async read-through. Returns the typed value or `fallback` when the key is
// absent. The stored jsonb already deserializes to the right JS type (a number
// stays a number, a bool a bool, an object an object), so the generic <T> the
// caller asks for matches the column's value_type.
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  try {
    const { data, error } = await supabaseAdmin
      .from("system_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    const value = data ? (data as { value: unknown }).value as T : fallback;
    cache.set(key, { value, expiresAt: now + TTL_MS });
    return value;
  } catch (err) {
    // Serve a stale-but-known value over the fallback when we have one; never
    // throw on a read path. Don't cache the failure.
    console.error(
      `[system-settings] read failed for "${key}":`,
      err instanceof Error ? err.message : String(err),
    );
    return hit ? (hit.value as T) : fallback;
  }
}

// Synchronous read for hot paths that can't await (e.g. the rate-limiter's
// per-request limit resolver). Returns the last cached value, falling back to
// `fallback` when the cache is cold, and fires a background refresh whenever the
// entry is missing or stale so the cache warms without blocking the request.
export function getSettingSync<T>(key: string, fallback: T): T {
  const hit = cache.get(key);
  if (!hit || hit.expiresAt <= Date.now()) {
    void getSetting(key, fallback);
  }
  return hit ? (hit.value as T) : fallback;
}

// Drop a cached entry (or the whole cache) so the next read re-fetches. Called
// by the admin PUT handler right after a successful write.
export function bustSettingCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

// Validate + normalize a raw value against a declared value_type. Pure +
// exported so the admin PUT handler and its tests share one source of truth.
// Returns the coerced value on success, or an error string on failure.
export function coerceSettingValue(
  valueType: SettingValueType,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (valueType) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (typeof raw === "boolean" || !Number.isFinite(n)) {
        return { ok: false, error: "Value must be a finite number." };
      }
      return { ok: true, value: n };
    }
    case "bool": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false, error: "Value must be a boolean." };
    }
    case "string": {
      if (typeof raw !== "string") {
        return { ok: false, error: "Value must be a string." };
      }
      return { ok: true, value: raw };
    }
    case "json": {
      // Already-parsed object/array/scalar is accepted as-is; a string is parsed
      // so the editor can submit raw JSON text.
      if (typeof raw === "string") {
        try {
          return { ok: true, value: JSON.parse(raw) };
        } catch {
          return { ok: false, error: "Value must be valid JSON." };
        }
      }
      if (raw === undefined) {
        return { ok: false, error: "Value is required." };
      }
      return { ok: true, value: raw };
    }
  }
}
