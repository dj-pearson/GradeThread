import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FILE = path.join(ROOT, "progress.txt");

const note = `

## Session Notes (2026-05-28) — iOS account deletion (US-194 PARTIAL)
Shipped only the App Store-required account-deletion slice of US-194.
US-194 stays OPEN — the rest is coupled to the in-flight pricing rework.

What landed:
- supabase/migrations/00043_delete_account_rpc.sql — SECURITY DEFINER
  delete_account() RPC scoped to auth.uid(). Refuses NULL/anon callers,
  pins search_path, deletes the caller's auth.users row which cascades
  all data via the existing ON DELETE CASCADE chain. REVOKE from
  public/anon, GRANT EXECUTE to authenticated.
- AuthStore.deleteAccount() calls the RPC then signs out + clears the
  Keychain. Throws (not fire-and-forget) so the sheet can keep the user
  on-screen if it fails.
- ios/GradeThread/Settings/DeleteAccountSheet.swift — typed 'delete'
  confirmation (pure DeleteAccountSheet.canDelete gate: case-insensitive,
  whitespace-trimmed). Destructive button disabled until it matches.
- 'Delete account' destructive row wired into the Settings Account
  section (ContentView) next to Sign out.
- Tests in DeleteAccountTests cover the gate branches + phrase constant.

Why US-194 stays open (deferred to after pricing rework lands):
- AI Item Assistant usage meter's monthly limit is defined by the
  flipdesk_plan tiers being reworked in US-200-225.
- Plan/billing status display reads subscription_status/flipdesk_plan
  (in-flux migration fields).
- notification_preferences server sync needs a shared web-type schema
  change (iOS push categories don't match the web prefs shape).

Note: this slice makes US-197's App Store submission path Apple-compliant
(Guideline 5.1.1(v) requires account deletion for apps with sign-up).
`;

fs.appendFileSync(FILE, note);
console.log(`appended ${note.length} chars`);
