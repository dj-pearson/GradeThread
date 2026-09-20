#!/usr/bin/env node
// US-3356: which notification reaches which surface, as a table rather than a
// sentence.
//
// THE PROBLEM THIS ANSWERS. A category can be live, opt-outable and firing,
// while an operator reading the admin catalog concludes it does not exist and a
// seller on a native app never gets it. Nothing on either surface says anything
// is missing, so "this surface needs no category" is indistinguishable from
// "this surface was forgotten".
//
// TWO VOCABULARIES, AND CONFLATING THEM IS THE FIRST MISTAKE.
//
//   PREFERENCE KEYS are the jsonb keys on users.notification_preferences
//   (grade_complete, offers, extension_queue_reminders, ...). They are what the
//   web settings screen shows and what gates delivery. Adding one needs no
//   migration, which is exactly why one can exist that nothing else knows about.
//
//   PUSH CATEGORIES are the dotted ids the edge stamps on an APNs/FCM payload
//   (sale.created, dispute.opened, ...). iOS and Android each declare their own
//   list, and a payload naming one they do not declare still arrives -- it just
//   lands somewhere nobody chose.
//
// They do not map one-to-one and there is no table that joins them, so this
// prints them as two matrices and says so, rather than inventing a join.
//
// Usage:  node scripts/notification-surface-matrix.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const SRC = {
  prefs: "src/lib/notification-preferences.ts",
  notify: "services/edge-functions/src/lib/notify.ts",
  push: "services/edge-functions/src/lib/transactional-push.ts",
  ios: "ios/GradeThread/Notifications/NotificationCategories.swift",
  android: "android/app/src/main/java/com/gradethread/app/platform/push/PushCategory.kt",
};

// ── the preference vocabulary ───────────────────────────────────────────────

/** Every pref key the web settings screen renders, with the channels it claims. */
export function webPrefKeys(text = read(SRC.prefs)) {
  // NOTIFICATION_TYPES entries: `key: "x"` ... `channels: ["email", ...]`
  const from = text.indexOf("export const NOTIFICATION_TYPES");
  if (from < 0) return [];
  const body = text.slice(from);
  const out = [];
  const re = /key:\s*"([a-z_]+)"[\s\S]*?channels:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(body))) {
    out.push({
      key: m[1],
      channels: [...m[2].matchAll(/"([a-z_]+)"/g)].map((c) => c[1]),
    });
  }
  return out;
}

/** notification_type -> pref key, from the edge's own PREF_KEY map. */
export function prefKeyByType(text = read(SRC.notify)) {
  const from = text.indexOf("export const PREF_KEY");
  if (from < 0) return {};
  const end = text.indexOf("\n};", from);
  const body = text.slice(from, end < 0 ? undefined : end);
  const out = {};
  for (const m of body.matchAll(/^\s*([a-z_]+):\s*(?:"([a-z_]+)"|null)\s*,/gm)) {
    out[m[1]] = m[2] ?? null;
  }
  return out;
}

/** Pref keys the admin Notification Catalog can show, i.e. enum-backed ones. */
export function catalogPrefKeys(text = read(SRC.prefs)) {
  const from = text.indexOf("export const NOTIFICATION_EVENT_CATALOG");
  if (from < 0) return new Set();
  const body = text.slice(from);
  return new Set([...body.matchAll(/prefKey:\s*(?:"([a-z_]+)"|null)/g)].map((m) => m[1] ?? null));
}

// ── the push-category vocabulary ────────────────────────────────────────────

/** Dotted categories the edge actually stamps on a device push. */
export const emittedCategories = (text = read(SRC.push)) =>
  [...new Set([...text.matchAll(/category:\s*"([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1]))].sort();

/** Categories the iOS app declares. */
export const iosCategories = (text = read(SRC.ios)) =>
  [...new Set([...text.matchAll(/=\s*"([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1]))].sort();

/** Categories the Android app declares. */
export const androidCategories = (text = read(SRC.android)) =>
  [...new Set([...text.matchAll(/\(\s*"([a-z_]+\.[a-z_]+)"\s*\)/g)].map((m) => m[1]))].sort();

/**
 * A push category the edge sends that a client does not declare.
 *
 * It is NOT dropped, which is the part worth knowing: Android's
 * `PushCategory.of` returns null, `PushMessage.channel` falls back to the
 * low-importance UPDATES channel, and `actions` comes back empty. So the notice
 * arrives with no inline action, on the channel a seller mutes first.
 */
export function categoryGaps({
  emitted = emittedCategories(),
  ios = iosCategories(),
  android = androidCategories(),
} = {}) {
  return {
    ios: emitted.filter((c) => !ios.includes(c)),
    android: emitted.filter((c) => !android.includes(c)),
    /** Declared by a client but never sent. Dead weight, not a delivery hole. */
    iosUnused: ios.filter((c) => !emitted.includes(c)),
    androidUnused: android.filter((c) => !emitted.includes(c)),
  };
}

/**
 * Pref keys that can push but reach browser web push ONLY: no notification_type
 * gates on them, so there is no in-app row and no admin-catalog entry either.
 */
export function webPushOnly({
  keys = webPrefKeys(),
  byType = prefKeyByType(),
  catalog = catalogPrefKeys(),
} = {}) {
  const backed = new Set(Object.values(byType).filter(Boolean));
  return keys
    .filter((k) => k.channels.includes("push"))
    .filter((k) => !backed.has(k.key) && !catalog.has(k.key))
    .map((k) => k.key)
    .sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keys = webPrefKeys();
  const byType = prefKeyByType();
  const catalog = catalogPrefKeys();
  const emitted = emittedCategories();
  const ios = iosCategories();
  const android = androidCategories();
  const gaps = categoryGaps({ emitted, ios, android });
  const only = webPushOnly({ keys, byType, catalog });

  const backed = new Set(Object.values(byType).filter(Boolean));
  console.log("PREFERENCE KEYS — what the web settings screen offers\n");
  console.log("key                        email in_app push  in-app feed  admin catalog");
  for (const k of keys) {
    const has = (c) => (k.channels.includes(c) ? " yes " : "  -  ");
    console.log(
      k.key.padEnd(26) +
        has("email") + " " + has("in_app") + " " + has("push") + "  " +
        (backed.has(k.key) ? "yes        " : "NO         ") + "  " +
        (catalog.has(k.key) ? "yes" : "NO"),
    );
  }
  console.log(
    `\n${only.length} of ${keys.filter((k) => k.channels.includes("push")).length} push-capable ` +
      `key(s) reach browser web push only: ${only.join(", ") || "none"}`,
  );

  console.log("\n\nPUSH CATEGORIES — what a phone is sent, and what each app knows\n");
  console.log("category                 edge sends  iOS  Android");
  for (const c of [...new Set([...emitted, ...ios, ...android])].sort()) {
    console.log(
      c.padEnd(24) +
        (emitted.includes(c) ? "   yes    " : "    -     ") + "  " +
        (ios.includes(c) ? "yes" : "NO ") + "  " +
        (android.includes(c) ? "yes" : "NO"),
    );
  }
  console.log(
    `\nedge sends ${emitted.length}; iOS declares ${ios.length}; Android declares ${android.length}`,
  );
  if (gaps.ios.length) console.log(`iOS is missing ${gaps.ios.length}: ${gaps.ios.join(", ")}`);
  if (gaps.android.length) {
    console.log(`Android is missing ${gaps.android.length}: ${gaps.android.join(", ")}`);
  }
  if (gaps.iosUnused.length) console.log(`iOS declares but is never sent: ${gaps.iosUnused.join(", ")}`);
  if (gaps.androidUnused.length) {
    console.log(`Android declares but is never sent: ${gaps.androidUnused.join(", ")}`);
  }
}
