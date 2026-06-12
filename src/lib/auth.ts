import { supabase } from "./supabase";

// US-368: `captchaToken` is the Cloudflare Turnstile token from the auth pages.
// GoTrue requires it on signup/login/reset once captcha is enabled; it's
// undefined (and ignored) when VITE_TURNSTILE_SITE_KEY is unset.
export async function signUpWithEmail(
  email: string,
  password: string,
  fullName: string,
  captchaToken?: string,
) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
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
