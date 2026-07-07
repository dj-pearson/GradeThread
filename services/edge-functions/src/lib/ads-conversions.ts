// US-1700: conversion & value wiring — click-id normalization + the GradeThread
// event → conversion-definition map + the attribution upsert.
//
// Conversion definitions (which events count, and their value) live in the
// system_settings registry so they're tunable without a deploy; the code default
// below is the fallback. Click ids are opaque Google/Apple identifiers (NOT PII).
// The pure helpers are unit-tested; the DB write takes an injected client.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSetting } from "./system-settings.ts";

export const ADS_CONVERSION_SETTING_KEY = "ads_conversion_definitions";

/** A GradeThread event that counts as a conversion, with its optimization value. */
export interface ConversionDefinition {
  event: string;
  name: string;
  value: number;
}

/** Code-default definitions (overridable via the system_settings row). */
export const DEFAULT_CONVERSION_DEFINITIONS: ConversionDefinition[] = [
  { event: "account_created", name: "Account created", value: 1 },
  { event: "subscription_started", name: "Subscription started", value: 30 },
  { event: "grade_purchased", name: "Paid grade", value: 5 },
  { event: "flipdesk_activated", name: "FlipDesk activated", value: 10 },
];

/** Resolve the (tunable) conversion definitions; falls back to the code default. */
export async function getConversionDefinitions(): Promise<ConversionDefinition[]> {
  const defs = await getSetting<ConversionDefinition[]>(
    ADS_CONVERSION_SETTING_KEY,
    DEFAULT_CONVERSION_DEFINITIONS,
  );
  return Array.isArray(defs) && defs.length > 0 ? defs : DEFAULT_CONVERSION_DEFINITIONS;
}

/** Map a GradeThread event name to its conversion definition, or null if it isn't one. */
export function mapEventToConversion(
  event: string,
  definitions: readonly ConversionDefinition[] = DEFAULT_CONVERSION_DEFINITIONS,
): ConversionDefinition | null {
  const key = event.trim().toLowerCase();
  return definitions.find((d) => d.event.toLowerCase() === key) ?? null;
}

/** URL param names we capture, mapped to the ad platform they belong to. */
export const CLICK_ID_PARAMS: Record<string, string> = {
  gclid: "google_ads",
  gbraid: "google_ads",
  wbraid: "google_ads",
};

/** The ad platform a click-id type belongs to ("gclid" → "google_ads"). */
export function platformForClickIdType(type: string): string | null {
  return CLICK_ID_PARAMS[type.toLowerCase()] ?? null;
}

/** Trim + bound a click id; returns null when empty or implausibly long. */
export function normalizeClickId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > 512) return null;
  return v;
}

export interface AttributionInput {
  clickId: string;
  clickIdType: string;
  /** The converted / signed-in user, when known. */
  ownerUserId?: string | null;
  /** Present when this write records a downstream conversion (not just a landing). */
  conversion?: { type: string; value: number } | null;
  /** Landing timestamp (ISO); defaults to now server-side when omitted. */
  landingAt?: string;
}

/**
 * Idempotent upsert of a click-id attribution (keyed on click_id). A landing
 * write sets the click id + platform (+ user if known); a conversion write adds
 * converted_at / type / value. Returns false when the click id is invalid.
 */
export async function recordAttribution(
  supabase: SupabaseClient,
  input: AttributionInput,
): Promise<boolean> {
  const clickId = normalizeClickId(input.clickId);
  const platform = platformForClickIdType(input.clickIdType);
  if (!clickId || !platform) return false;

  const row: Record<string, unknown> = {
    click_id: clickId,
    click_id_type: input.clickIdType.toLowerCase(),
    platform,
  };
  if (input.landingAt) row.landing_at = input.landingAt;
  if (input.ownerUserId) row.owner_user_id = input.ownerUserId;
  if (input.conversion) {
    row.conversion_type = input.conversion.type;
    row.value = input.conversion.value;
    row.converted_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from("ad_click_attributions")
    .upsert(row, { onConflict: "click_id", ignoreDuplicates: false });
  return !error;
}
