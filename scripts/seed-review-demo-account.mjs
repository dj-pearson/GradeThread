// US-786: create the App Review demo account so Apple reviewers can sign in.
//
// This is an OPERATOR script - it needs the PRODUCTION Supabase service-role key,
// which only the operator holds. It creates (or password-resets) the review auth
// user idempotently, and that is ALL it does.
//
// US-3393: it used to also write the live password into
// `ios/fastlane/metadata/review_information/demo_password.txt`. That file is
// TRACKED BY GIT and is not gitignored, so the next `git add -A` would have
// committed a live production credential, and the script said nothing about it.
// Nothing leaked - the tracked copy was still the placeholder - but the write was
// also redundant: US-1206 added the Fastfile's `inject_review_credentials` lane,
// which injects the same two values from the environment immediately before
// `deliver` runs. So the fix is to delete the write, not to relocate it. The
// credential now exists in exactly two places: prod auth, and your secret store.
//
// Run:
//   SUPABASE_URL=https://api.gradethread.com \
//   SUPABASE_SERVICE_ROLE_KEY=<prod service-role key> \
//   REVIEW_DEMO_EMAIL=appreview@gradethread.com \
//   REVIEW_DEMO_PASSWORD='<a strong password>' \
//   node scripts/seed-review-demo-account.mjs
//
// AFTER running:
//   1. Store REVIEW_DEMO_EMAIL and REVIEW_DEMO_PASSWORD in Infisical (prod, /).
//      The `fastlane release` lane reads them from there and writes them into the
//      review_information files on the CI runner, seconds before it submits.
//      Nothing else needs a copy.
//   2. SIGN IN as this user in the app and create a little seeded data the
//      reviewer can see - 2-3 inventory items + 1 graded submission with a
//      certificate. (Doing it through the app guarantees schema-correct rows;
//      that's why this script doesn't bulk-insert them.)
//   3. Put a REAL, reachable contact number in
//      ios/fastlane/metadata/review_information/phone_number.txt.
//   4. Re-run the ungated-print guard and proceed with submission. That is
//      `npx vitest run src/test/ios-ungated-print.test.ts` on any machine - it
//      used to say `python3 ios/Scripts/no-ungated-print.py`, which cannot run
//      on the Windows dev box at all, so the check this step asks for was being
//      skipped rather than performed.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_INFO_DIR = join(root, "ios", "fastlane", "metadata", "review_information");

// The placeholder values the repo is allowed to hold. Kept in lockstep with
// ios/fastlane/Fastfile (REVIEW_DEMO_*_PLACEHOLDER) and with the
// `gradethread-appreview-demo-credential` rule in .gitleaks.toml.
// src/test/review-demo-credentials.test.ts fails if the three drift apart.
const TRACKED_PLACEHOLDERS = {
  "demo_user.txt": "REVIEW_DEMO_EMAIL_PLACEHOLDER@gradethread.com",
  "demo_password.txt": "REVIEW_DEMO_PASSWORD_PLACEHOLDER",
};

/** True if git tracks `absPath`. Used to decide, mechanically, whether a path is committable. */
function isTrackedByGit(absPath) {
  const rel = relative(root, absPath).split("\\").join("/");
  const res = spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], {
    cwd: root,
    encoding: "utf8",
  });
  // Exit 0 means git knows the path. If git itself is missing, fail closed:
  // treat the path as tracked so the guard below refuses rather than proceeds.
  if (res.error) return true;
  return res.status === 0;
}

/**
 * Refuse to touch production while a live credential is sitting in the working
 * tree. This is the mechanical half of US-3393: the script no longer writes to
 * these files, but `fastlane release` still does, and a local release run leaves
 * the real password behind in a TRACKED file. Checking before any side effect
 * means the operator finds out while nothing has happened yet.
 */
function assertTrackedPlaceholdersIntact() {
  const dirty = [];
  for (const [name, placeholder] of Object.entries(TRACKED_PLACEHOLDERS)) {
    const abs = join(REVIEW_INFO_DIR, name);
    if (!existsSync(abs)) continue;
    if (!isTrackedByGit(abs)) continue;
    const actual = readFileSync(abs, "utf8").trim();
    if (actual !== placeholder) dirty.push(name);
  }
  if (dirty.length === 0) return;

  console.error(
    [
      "",
      "REFUSING TO RUN: a git-TRACKED file already holds a non-placeholder value.",
      "",
      `  ios/fastlane/metadata/review_information/{${dirty.join(", ")}}`,
      "",
      "That is almost certainly a live App Review credential left behind by a local",
      "`fastlane release` run (the Fastfile's inject_review_credentials lane writes",
      "these files just before deliver). They are tracked and not gitignored, so the",
      "next `git add -A` would commit it.",
      "",
      "Restore the placeholders, then re-run:",
      "  git checkout -- ios/fastlane/metadata/review_information/",
      "",
      "Values are not printed here on purpose.",
    ].join("\n"),
  );
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.REVIEW_DEMO_EMAIL;
const password = process.env.REVIEW_DEMO_PASSWORD;

if (!url || !key || !email || !password) {
  console.error(
    "Missing env. Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, " +
      "REVIEW_DEMO_EMAIL, REVIEW_DEMO_PASSWORD",
  );
  process.exit(1);
}

assertTrackedPlaceholdersIntact();

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findExistingUser(targetEmail) {
  // Paginate the admin user list (no get-by-email endpoint).
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === targetEmail.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

async function main() {
  let user = await findExistingUser(email);
  if (user) {
    console.log(`Demo user already exists: ${user.id} (${email})`);
    // Reset the password so the value in your env is authoritative.
    const { error } = await supabase.auth.admin.updateUserById(user.id, { password });
    if (error) throw new Error(`password reset failed: ${error.message}`);
    console.log("Password reset to the value of REVIEW_DEMO_PASSWORD.");
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "App Review Demo" },
    });
    if (error) throw new Error(`createUser failed: ${error.message}`);
    user = data.user;
    console.log(`Created demo user: ${user.id} (${email})`);
  }

  // AC4: say exactly where the credential went, and whether that place is
  // tracked. An operator reading "Wrote demo_user.txt + demo_password.txt." had
  // no reason to suspect the destination was committable, which is how this sat
  // here from US-786 until an audit found it.
  const passwordFile = join(REVIEW_INFO_DIR, "demo_password.txt");
  const trackedNote = isTrackedByGit(passwordFile)
    ? "TRACKED BY GIT (committable)"
    : "untracked";

  console.log(
    [
      "",
      "WHERE THE PASSWORD WENT",
      "  Written to disk by this script:  NOTHING. No file was created or modified.",
      "  It now lives in: (a) prod Supabase auth, as this user's password hash, and",
      "                   (b) your REVIEW_DEMO_PASSWORD environment variable.",
      "",
      `  ios/fastlane/metadata/review_information/demo_password.txt is ${trackedNote}`,
      "  and still holds its placeholder. This script deliberately does not write it",
      "  (US-3393). The Fastfile's inject_review_credentials lane fills it from",
      "  REVIEW_DEMO_EMAIL / REVIEW_DEMO_PASSWORD on the CI runner just before",
      "  deliver submits, so deliver still gets real credentials.",
      "",
      "NEXT (operator)",
      "  1. Put REVIEW_DEMO_EMAIL / REVIEW_DEMO_PASSWORD in Infisical (prod, /).",
      "     That is the only copy the release lane needs.",
      "  2. Sign in as this user in the app and create 2-3 inventory items + 1",
      "     graded submission with a certificate.",
      "  3. Put a real number in phone_number.txt.",
      "  See the header of this script.",
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
