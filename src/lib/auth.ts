import { supabase } from "./supabase";
import { LEGAL_VERSIONS } from "./constants";
import type { UserUseCase } from "@/types/database";

// US-368: `captchaToken` is the Cloudflare Turnstile token from the auth pages.
// GoTrue requires it on signup/login/reset once captcha is enabled; it's
// undefined (and ignored) when VITE_TURNSTILE_SITE_KEY is unset.
//
// US-377: the affirmative ToS/Privacy clickwrap version + timestamp ride along
// in options.data (raw_user_meta_data). The handle_new_user trigger reads them
// to stamp the user's accepted versions and append an audit row at account
// creation — recording consent server-side for email signups.
//
// US-1122: an optional `useCase` (the persona the user picked on the signup
// form) rides along the same way so handle_new_user can stamp users.use_case at
// account creation — letting the dashboard personalize on first paint.
export async function signUpWithEmail(
  email: string,
  password: string,
  fullName: string,
  captchaToken?: string,
  useCase?: UserUseCase,
) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName,
        tos_version: LEGAL_VERSIONS.tos,
        privacy_version: LEGAL_VERSIONS.privacy,
        legal_accepted_at: new Date().toISOString(),
        ...(useCase ? { use_case: useCase } : {}),
      },
      emailRedirectTo: `${window.location.origin}/auth/callback`,
      captchaToken,
    },
  });
  if (error) throw error;
  return data;
}

export async function signInWithEmail(email: string, password: string, captchaToken?: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
    options: { captchaToken },
  });
  if (error) throw error;
  return data;
}

export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
    },
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// US-375: revoke EVERY session for this user (all devices), not just the local
// one. Used by the "Sign out of all devices" control and after a password
// change.
export async function signOutEverywhere() {
  const { error } = await supabase.auth.signOut({ scope: "global" });
  if (error) throw error;
}

// US-375: revoke OTHER sessions while keeping the current one — used after a
// password change so the active session continues but stolen sessions die.
export async function signOutOtherSessions() {
  const { error } = await supabase.auth.signOut({ scope: "others" });
  if (error) throw error;
}

export async function resetPassword(email: string, captchaToken?: string) {
  const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/auth/reset-password`,
    captchaToken,
  });
  if (error) throw error;
  return data;
}

export async function updatePassword(newPassword: string) {
  const { data, error } = await supabase.auth.updateUser({
    password: newPassword,
  });
  if (error) throw error;
  return data;
}

// US-366: re-send the signup confirmation email for an unverified account.
export async function resendConfirmationEmail(email: string) {
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
  });
  if (error) throw error;
}
