#!/usr/bin/env node
// US-2892 -- prove the shipped artifact actually carries its configuration.
//
//   node android/scripts/check-release-config.mjs <app.aab | app.apk>
//   node android/scripts/check-release-config.mjs --self-test
//
// WHY THIS EXISTS, because the failure it catches is invisible until users see
// it. `android-release.yml` asserted five secrets, all of them about SIGNING
// and UPLOADING: the keystore, its password, its alias, its key password, and
// the Play service account. Not one was about whether the app WORKS.
//
// Meanwhile `GradeThreadApp.onCreate` calls `AppConfig.validateAtStartup()`,
// which calls `ConfigValidation.requireNonBlank("SUPABASE_ANON_KEY", ...)`,
// which throws on an empty value -- and `secret()` in build.gradle.kts defaults
// that key to an empty string. So a release built without SUPABASE_ANON_KEY in
// the environment produces a correctly signed, correctly versioned,
// under-budget AAB that CRASHES ON LAUNCH FOR EVERY USER, and every gate in the
// lane passes: the signing check passes, the ABI budget passes, fastlane
// uploads it. The crash arrives as a one-star review.
//
// An env-var check alone cannot catch that, which is the whole point of reading
// the BINARY. The env can be right while the value fails to reach the artifact:
// a buildConfigField renamed, a `secret()` lookup misspelled, a variant that
// does not inherit the field, a Gradle cache serving a stale BuildConfig. This
// reads the dex the device will run.
//
// SECRETS ARE NEVER PRINTED. Values are read from the environment, searched for
// as literal bytes in the dex, and reported only as a name plus present/absent.
// Nothing here writes a value to stdout, to a file, or to a job summary.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync, deflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";

// ── the contract ────────────────────────────────────────────────────────────
//
// REQUIRED: AppConfig throws at startup when any of these is blank, so a build
// missing one is a build that cannot start. Sourced from
// app/build.gradle.kts's buildConfigField block and AppConfig.validateAtStartup.
//
// OPTIONAL: AppConfig treats blank as ABSENT and the feature disables silently.
// That is the right RUNTIME behaviour and the wrong RELEASE behaviour -- a
// build shipped without the FIREBASE_* four has no push at all, and the first
// symptom is sellers not being told they sold something. So: warn, loudly,
// naming what ships dead. Never fail; a fork or a PR build legitimately has
// none of these.
const REQUIRED = [
  ["SUPABASE_URL", "every Supabase call"],
  ["SUPABASE_ANON_KEY", "sign-in, and AppConfig throws at startup without it"],
  ["EDGE_API_URL", "every /api call: grading, payments, eBay, FlipDesk"],
];

const OPTIONAL = [
  ["SENTRY_DSN", "crash reporting ships DISABLED -- no crash reaches Sentry"],
  ["POSTHOG_API_KEY", "product analytics ships DISABLED"],
  ["POSTHOG_HOST", "analytics falls back to the default host"],
  ["TURNSTILE_SITE_KEY", "the sign-up captcha ships DISABLED"],
  ["FIREBASE_PROJECT_ID", "push ships DEAD (all four FIREBASE_* are needed)"],
  ["FIREBASE_APP_ID", "push ships DEAD (all four FIREBASE_* are needed)"],
  ["FIREBASE_API_KEY", "push ships DEAD (all four FIREBASE_* are needed)"],
  ["FIREBASE_SENDER_ID", "push ships DEAD (all four FIREBASE_* are needed)"],
];

// ── a zip reader, in node core only ─────────────────────────────────────────
//
// No dependency on the `unzip` binary (absent on a plain Windows checkout) and
// none on an npm package. A gate that can be disarmed by someone else's
// dependency tree is not a gate. ~60 lines of central-directory parsing is the
// cheaper of the two costs.
function zipEntries(buf) {
  // The End Of Central Directory record is last, but a zip comment can follow
  // it, so scan backwards for the signature rather than assuming the offset.
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out.push({ name, method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf, e) {
  // The local header repeats the name and extra fields, and its extra length
  // routinely DIFFERS from the central directory's -- reading the central
  // directory's value here is the classic way to land mid-payload.
  if (buf.readUInt32LE(e.localOff) !== 0x04034b50) {
    throw new Error(`bad local header for ${e.name}`);
  }
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported compression method ${e.method} for ${e.name}`);
}

/** Every dex in the artifact, concatenated. APK: classes*.dex. AAB: base/dex/. */
export function dexBytes(buf) {
  const dex = zipEntries(buf).filter((e) => /(^|\/)classes\d*\.dex$/.test(e.name));
  if (!dex.length) throw new Error("no classes*.dex found -- is this an APK or AAB?");
  return Buffer.concat(dex.map((e) => readEntry(buf, e)));
}

/**
 * Is `value` present in the dex as a literal?
 *
 * A dex string is length-prefixed MUTF-8 with no terminator, so a plain byte
 * search over the whole file is both correct and the only thing that stays
 * correct across dex format revisions. Values here are ASCII (URLs, JWTs,
 * base64-ish keys), so no MUTF-8 escaping applies.
 */
export function dexContains(dex, value) {
  return dex.includes(Buffer.from(value, "utf8"));
}

// ── the check ───────────────────────────────────────────────────────────────

export function checkConfig(dex, env) {
  const failures = [];
  const warnings = [];
  const ok = [];

  for (const [name, why] of REQUIRED) {
    const value = (env[name] ?? "").trim();
    if (!value) {
      failures.push(`${name} is not set in the environment. Needed for: ${why}.`);
    } else if (!dexContains(dex, value)) {
      // The env was right and the artifact is still wrong. This is the case an
      // env-only check cannot see, and the reason this script reads the binary.
      failures.push(
        `${name} is set in the environment but its value is NOT in the built artifact. ` +
          "The build did not pick it up -- check the buildConfigField in app/build.gradle.kts " +
          "and that the release variant was built with this environment.",
      );
    } else {
      ok.push(name);
    }
  }

  for (const [name, consequence] of OPTIONAL) {
    const value = (env[name] ?? "").trim();
    if (!value) warnings.push(`${name} absent -- ${consequence}.`);
    else if (!dexContains(dex, value)) {
      warnings.push(`${name} is set in the environment but NOT in the artifact -- ${consequence}.`);
    } else ok.push(name);
  }

  return { failures, warnings, ok };
}

// ── self-test ───────────────────────────────────────────────────────────────
//
// A gate that has never been seen to FAIL is a gate nobody should trust. This
// builds a real zip with a real deflated fake-dex and proves all four
// behaviours: present-and-required passes, missing-from-env fails,
// set-but-not-in-binary fails, and missing-optional only warns.
function zipOf(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const body = deflateRawSync(content);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(content.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function selfTest() {
  // Not JWT-shaped on purpose: a realistic-looking key here trips the
  // pre-commit gitleaks scan on entropy, and the search below is a literal
  // byte match, so the shape proves nothing either way.
  const KEY = "selftest-anon-key-not-a-real-credential";
  const URL = "https://api.example.invalid";
  const EDGE = "https://functions.example.invalid";
  const DSN = "https://selftest@sentry.example.invalid/1";
  const fakeDex = Buffer.concat([
    Buffer.from("dex\n035\0"),
    Buffer.from(` ${URL} ${KEY} ${EDGE} ${DSN} `, "utf8"),
  ]);
  const aab = zipOf([["base/dex/classes.dex", fakeDex], ["base/manifest/AndroidManifest.xml", Buffer.from("x")]]);
  const dex = dexBytes(aab);

  const cases = [];
  const check = (label, cond) => cases.push([label, cond]);

  // 1. Everything present -> clean.
  let r = checkConfig(dex, { SUPABASE_URL: URL, SUPABASE_ANON_KEY: KEY, EDGE_API_URL: EDGE, SENTRY_DSN: DSN });
  check("all present -> no failures", r.failures.length === 0);
  check("all present -> sentry not warned", !r.warnings.some((w) => w.startsWith("SENTRY_DSN")));

  // 2. The exact bug this exists for: env blank.
  r = checkConfig(dex, { SUPABASE_URL: URL, SUPABASE_ANON_KEY: "", EDGE_API_URL: EDGE });
  check("blank anon key -> fails", r.failures.some((f) => f.startsWith("SUPABASE_ANON_KEY is not set")));

  // 3. Whitespace is blank. `secret()` treats "  " as a value; AppConfig does not.
  r = checkConfig(dex, { SUPABASE_URL: URL, SUPABASE_ANON_KEY: "   ", EDGE_API_URL: EDGE });
  check("whitespace-only anon key -> fails", r.failures.some((f) => f.startsWith("SUPABASE_ANON_KEY is not set")));

  // 4. The case an env-only check cannot see: set, but never reached the dex.
  r = checkConfig(dex, { SUPABASE_URL: URL, SUPABASE_ANON_KEY: "a-key-that-was-never-compiled-in", EDGE_API_URL: EDGE });
  check("env set but absent from artifact -> fails", r.failures.some((f) => f.includes("NOT in the built artifact")));

  // 5. Optional absent warns, never fails.
  r = checkConfig(dex, { SUPABASE_URL: URL, SUPABASE_ANON_KEY: KEY, EDGE_API_URL: EDGE });
  check("optional absent -> warns", r.warnings.some((w) => w.startsWith("FIREBASE_APP_ID")));
  check("optional absent -> does not fail", r.failures.length === 0);

  // 6. A value that is NOT in the dex must not be reported as present -- the
  //    search has to be able to say no, or every run is a false pass.
  check("dexContains says no for an absent string", !dexContains(dex, "this-string-is-not-in-the-dex"));

  const failed = cases.filter(([, pass]) => !pass);
  for (const [label, pass] of cases) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
  if (failed.length) {
    console.error(`\ncheck-release-config: SELF-TEST FAILED (${failed.length}/${cases.length})`);
    process.exit(1);
  }
  console.log(`check-release-config: self-test OK (${cases.length} cases)`);
}

// ── entry point ─────────────────────────────────────────────────────────────
//
// Guarded, so `import { checkConfig } from …` in a test does NOT run the CLI.
// Without this the first line of any importing test is a usage error and an
// exit(1), which reads as the test failing rather than the module misbehaving.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();

function main() {
const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const artifact = args[0];
if (!artifact) {
  console.error("usage: check-release-config.mjs <app.aab | app.apk> | --self-test");
  process.exit(1);
}
if (!existsSync(artifact)) {
  console.error(`check-release-config: no such artifact: ${artifact}`);
  process.exit(1);
}

const { failures, warnings, ok } = checkConfig(dexBytes(readFileSync(artifact)), process.env);

console.log(`check-release-config: ${artifact}`);
for (const name of ok) console.log(`  ok    ${name} present in the artifact`);
for (const w of warnings) console.log(`  WARN  ${w}`);
for (const f of failures) console.error(`  FAIL  ${f}`);

if (warnings.length && process.env.GITHUB_STEP_SUMMARY) {
  // Into the job summary, not just the log: a warning nobody scrolls to is a
  // warning that does not exist. Names only -- never a value.
  writeFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `\n### Android release config\n\n${warnings.map((w) => `- ${w}`).join("\n")}\n`,
    { flag: "a" },
  );
}

if (failures.length) {
  console.error(
    "\ncheck-release-config: this artifact would install and then crash on launch. " +
      "Set the missing values in Infisical `prod /` and re-run.",
  );
  process.exit(1);
}
console.log(`check-release-config: OK (${ok.length} present, ${warnings.length} warning(s))`);
}

