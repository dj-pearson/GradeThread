// Mark US-170 passed (Auth: email/password + Sign in with Apple + Google).
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-170": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Auth/{LoginView,AuthStore,KeychainLocalStorage,SignInWithAppleCoordinator,SafariView}.swift implements the full surface. LoginView toggles between Sign in / Sign up modes with shared chrome, exposes the system SignInWithAppleButton (tap routed through SignInWithAppleCoordinator so we can drive the nonce handshake), Continue with Google via supabase.auth.signInWithOAuth (SDK handles ASWebAuthenticationSession), Forgot-password sheet opening SFSafariViewController at https://gradethread.com/auth/reset-password. SignInWithAppleCoordinator generates a SecRandomCopyBytes nonce, SHA-256-hashes it for the Apple request, passes the unhashed value through to supabase.auth.signInWithIdToken(provider:.apple, idToken:, nonce:), and stores the first-grant fullName as user_metadata. KeychainLocalStorage conforms to AuthLocalStorage with kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly accessibility; upsert pattern (try update → fall back to add); removeAll() called by signOut() as belt-and-suspenders cleanup. AuthStore is @Observable (iOS 17 Observation), tails supabase.auth.authStateChanges, drives the .loading/.signedOut/.signedIn(User) phase enum. ProtectedRouteShell + MainTabView (renamed from ContentView body) gate the rest of the app — sign-out button in the Settings placeholder calls AuthStore.signOut(). Apple SIWA entitlement in GradeThread.entitlements; CFBundleURLTypes registers com.gradethread.app:// for the OAuth redirect handler. Nonce hashing covered by SignInWithAppleTests against the SHA-256('abc') known vector. SDK's auto-refresh handles token rotation. CI verification via xcodebuild test on the macOS runner.",
  },
};

const prd = JSON.parse(fs.readFileSync(PRD, "utf8"));
let touched = 0;
for (const story of prd.userStories) {
  const u = updates[story.id];
  if (!u) continue;
  story.passes = u.passes;
  story.notes = u.notes;
  touched++;
}

fs.writeFileSync(PRD, JSON.stringify(prd, null, 2) + "\n", "utf8");
console.log(`Updated ${touched} stories in prd.json`);
