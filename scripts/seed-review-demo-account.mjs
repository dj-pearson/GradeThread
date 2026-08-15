// US-786: create the App Review demo account so Apple reviewers can sign in.
//
// This is an OPERATOR script — it needs the PRODUCTION Supabase service-role key,
// which only the operator holds. It creates the review auth user (idempotently)
// and writes the credentials into the fastlane review-information files so the
// next `fastlane deliver` ships working demo creds instead of placeholders.
//
// Run:
//   SUPABASE_URL=https://api.gradethread.com \
//   SUPABASE_SERVICE_ROLE_KEY=<prod service-role key> \
//   REVIEW_DEMO_EMAIL=appreview@gradethread.com \
//   REVIEW_DEMO_PASSWORD='<a strong password>' \
//   node scripts/seed-review-demo-account.mjs
//
// AFTER running:
//   1. SIGN IN as this user in the app and create a little seeded data the
//      reviewer can see — 2–3 inventory items + 1 graded submission with a
//      certificate. (Doing it through the app guarantees schema-correct rows;
//      that's why this script doesn't bulk-insert them.)
//   2. Put a REAL, reachable contact number in
//      ios/fastlane/metadata/review_information/phone_number.txt.
//   3. Re-run the ungated-print guard and proceed with submission. That is
//      `npx vitest run src/test/ios-ungated-print.test.ts` on any machine — it
//      used to say `python3 ios/Scripts/no-ungated-print.py`, which cannot run
//      on the Windows dev box at all, so the check this step asks for was being
//      skipped rather than performed.

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
    // Reset the password so the credentials below are authoritative.
    const { error } = await supabase.auth.admin.updateUserById(user.id, { password });
    if (error) throw new Error(`password reset failed: ${error.message}`);
    console.log("Password reset to the provided value.");
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

  // Write the fastlane review-information files so deliver ships real creds.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = join(root, "ios", "fastlane", "metadata", "review_information");
  writeFileSync(join(dir, "demo_user.txt"), email, "utf8");
  writeFileSync(join(dir, "demo_password.txt"), password, "utf8");
  console.log("Wrote demo_user.txt + demo_password.txt.");

  console.log(
    "\nNEXT (operator): sign in as this user in the app and create 2–3 inventory " +
      "items + 1 graded submission with a certificate; then put a real number in " +
      "phone_number.txt. See the header of this script.",
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
