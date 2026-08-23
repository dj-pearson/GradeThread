#!/usr/bin/env node
// The third client. iOS had three unreachable features and src/ had one dead
// module; this asks Android the same question, and the answer includes a
// sign-in path.
//
// Kotlin behaves like Swift here and not like TypeScript: files in the same
// module need no import, so a composable or an object that nothing calls still
// compiles, still passes detekt, still gets linted, and is invisible to every
// import-graph check there is. The only signal left is how many times the whole
// app mentions its name.
//
// WHAT IT FOUND FIRST RUN, and the shape is worth keeping because it is not
// "dead code" in the usual sense:
//
//   OAuthSignIn        US-1311 built Google and Apple sign-in through Chrome
//                      Custom Tabs. The RETURN leg is fully wired -
//                      AuthCallbackActivity is in the manifest as an App Link
//                      and completes the PKCE exchange. The DEPARTURE leg is
//                      not: nothing calls OAuthSignIn.launch(), and AuthScreen
//                      renders email fields and no provider button. Half a
//                      feature, and the half that shipped is the half nobody
//                      looks at.
//
// THREE KINDS OF DECLARATION ARE EXCLUDED BY MECHANISM, NOT BY NAME, because
// on Android most things nothing calls are called by something that is not code:
//
//   @Preview            the IDE renders it; no app code ever will.
//   @Module / @Binds…   Hilt generates the caller at build time.
//   the manifest        Services, Activities and Receivers are named in
//                       AndroidManifest.xml and started by the system.
//
// Matching on a "Preview" SUFFIX instead would be the wrong rule twice over: it
// excuses anything an author happens to name that way, and it misses a preview
// named otherwise.
//
//   node scripts/check-android-orphans.mjs
//   node scripts/check-android-orphans.mjs --list   # print, never fail

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANDROID = join(ROOT, "android");
const rel = (f) => relative(ROOT, f).split(sep).join("/");

/**
 * Declarations the app never mentions again, and why each is allowed to be one.
 * Shrink-only: an entry that stops matching fails, so wiring one up forces the
 * reason out with it.
 */
const ALLOWED = {
  OAuthSignIn:
    "UNREACHABLE (US-2792). Google and Apple sign-in through Custom Tabs. The " +
    "callback half is wired and in the manifest; nothing calls launch(), and " +
    "AuthScreen offers no provider button, so neither can be started.",
  Moment:
    "UNREACHABLE (US-2792). PushPermission.Moment carries three hand-written " +
    "rationales for asking at the right time - first sale, first grade, eBay " +
    "connected. No function takes one. Its only other mention in the repo is a " +
    "test iterating entries, which proves the strings exist rather than that " +
    "anything asks.",
};

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "build" || entry === ".gradle" || entry === ".idea") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".kt")) out.push(p);
  }
  return out;
}

const files = walk(ANDROID);
if (files.length === 0) {
  console.log("[android-orphans] no android/ tree — skipped.");
  process.exit(0);
}

const isTest = (f) => /\/(test|androidTest)\//.test(rel(f));
// ⚠ CRLF FIRST. Without it this does NOTHING on a Windows checkout: `.` never
// matches `\r`, so `//.*$` cannot reach the end of a CRLF line and the replace
// is a no-op — comments survive and prose counts as a reference. The iOS twin
// of this function shipped without it and was green here while CI was red.
const strip = (s) =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

const app = files.filter((f) => !isTest(f)).map((f) => [f, strip(readFileSync(f, "utf8"))]);

// Everything the SYSTEM starts rather than our code: manifest components.
const manifests = walk(join(ANDROID, "app", "src")).length ? [] : [];
let manifestText = "";
for (const m of ["app/src/main/AndroidManifest.xml", "app/src/debug/AndroidManifest.xml"]) {
  const p = join(ANDROID, m);
  if (existsSync(p)) manifestText += readFileSync(p, "utf8");
}
void manifests;

// A declaration, with whatever annotations precede it, so the annotation can
// decide whether it counts.
const DECL =
  /((?:@\w+(?:\([^)]*\))?\s*)*)(?:public\s+|internal\s+|private\s+)?(?:data\s+|sealed\s+|abstract\s+|open\s+|final\s+)*(?:class|object|interface)\s+([A-Z]\w+)/gm;
const FUN = /((?:@\w+(?:\([^)]*\))?\s*)*)(?:public\s+|internal\s+|private\s+)?fun\s+([A-Z]\w+)/gm;

const EXCUSED_ANNOTATION = /@(Preview|Module|InstallIn|HiltAndroidApp|AndroidEntryPoint|HiltWorker)\b/;

const found = [];
for (const [file, src] of app) {
  const seen = new Set();
  for (const re of [DECL, FUN]) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const [, annotations, name] = m;
      if (seen.has(name)) continue;
      seen.add(name);
      if (EXCUSED_ANNOTATION.test(annotations ?? "")) continue;
      if (new RegExp(`["\\.]${name}\\b`).test(manifestText)) continue;
      let mentions = 0;
      for (const [, other] of app) {
        mentions += (other.match(new RegExp("\\b" + name + "\\b", "g")) ?? []).length;
      }
      if (mentions <= 1) found.push({ name, file: rel(file) });
    }
  }
}

if (process.argv.includes("--list")) {
  console.log(`\n${found.length} declaration(s) the app never mentions again:\n`);
  for (const f of found) {
    console.log(`  ${f.name.padEnd(26)} ${f.file}`);
    if (ALLOWED[f.name]) console.log(`      allowed: ${ALLOWED[f.name]}`);
  }
  process.exit(0);
}

const unexplained = found.filter((f) => !ALLOWED[f.name]);
const stale = Object.keys(ALLOWED).filter((n) => !found.some((f) => f.name === n));

if (unexplained.length === 0 && stale.length === 0) {
  console.log(
    `[android-orphans] OK  ${found.length} unreachable declaration(s), all accounted for.`,
  );
  process.exit(0);
}

if (unexplained.length > 0) {
  console.error("\n[android-orphans] declaration(s) the app never mentions again:\n");
  for (const f of unexplained) console.error(`    ${f.file}  ->  ${f.name}`);
  console.error(
    "\n  It compiles, detekt passes, lint sees the file, and no user can reach it.\n" +
      "  Decide which this is:\n\n" +
      "    STARTED BY THE SYSTEM  manifest, Hilt or @Preview -> it should already be\n" +
      "                           excused by mechanism; if not, fix the rule\n" +
      "    UNREACHABLE            a feature with no entry point -> a bug; file it\n" +
      "    SUPERSEDED             something replaced it -> delete it\n\n" +
      "  Then add it to ALLOWED with that verdict, or act on it.\n",
  );
}

if (stale.length > 0) {
  console.error("\n[android-orphans] ALLOWED entr(ies) that no longer match:\n");
  for (const n of stale) console.error(`    ${n}`);
  console.error("\n  Delete the entry. The list only shrinks.\n");
}

process.exit(1);
