// US-194 PARTIAL — account-deletion slice only. Does NOT flip passes.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const note =
  "PARTIAL (2026-05-28): account-deletion slice shipped — the App Store-required piece (Guideline 5.1.1(v)) that unblocks US-197's submission path. supabase/migrations/00043_delete_account_rpc.sql adds a SECURITY DEFINER delete_account() RPC scoped to auth.uid() (refuses NULL/anon callers, pins search_path) that deletes the caller's auth.users row + cascades all data via the existing ON DELETE CASCADE chain rooted at public.users.id->auth.users.id; REVOKE from public/anon, GRANT EXECUTE to authenticated. AuthStore.deleteAccount() calls the RPC then tears down the local session (signOut + KeychainLocalStorage.removeAll); it throws (unlike the fire-and-forget auth actions) so the sheet keeps the user on-screen on failure. ios/GradeThread/Settings/DeleteAccountSheet.swift requires typing 'delete' (case-insensitive, whitespace-trimmed via the pure DeleteAccountSheet.canDelete gate) before the destructive button enables; on success it haptic-confirms + dismisses and the auth-state stream flips ProtectedRouteShell to LoginView. Wired a destructive 'Delete account' row into the Settings Account section (ContentView SettingsPlaceholder) next to Sign out. Tests in DeleteAccountTests cover the gate (exact/case-insensitive/trim pass; empty/partial/wrong-word/inner-whitespace fail; phrase constant pinned). STILL OPEN — the rest of US-194 (full profile section, AI Item Assistant toggle+usage meter wired to the users row, notification_preferences server sync, plan/billing status display + 'Manage on web' Safari link) is deferred because the AI monthly-limit + plan/billing pieces are coupled to the in-flight pricing rework (US-200-225, flipdesk_plan tiers + subscription_status) and the notification-prefs sync needs a shared web-type schema change. Resume after pricing settles.";

const prd = JSON.parse(fs.readFileSync(PRD, "utf8"));
let touched = 0;
for (const story of prd.userStories) {
  if (story.id !== "US-194") continue;
  story.notes = note;        // passes intentionally left false
  touched++;
}
fs.writeFileSync(PRD, JSON.stringify(prd, null, 2) + "\n", "utf8");
console.log(`Annotated ${touched} story (passes left unchanged: ${prd.userStories.find(s => s.id === "US-194").passes})`);
