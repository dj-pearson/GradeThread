import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { passwordStrength, checkPassword } from "@/lib/password-policy";

// US-2530. Four password inputs, no way to see what you typed. On a phone a
// mistyped character is invisible and comes back as "wrong password", so the
// user retypes the same wrong thing. Signup and reset also rejected a weak
// password only after submit, leaving the user to guess which rule they broke.
// And the sign-in failure was a toast: gone in four seconds, which is exactly
// how long it takes to look away and open a password manager.

const FIELD = "src/components/auth/password-field.tsx";
const PAGES = [
  "src/pages/login.tsx",
  "src/pages/signup.tsx",
  "src/pages/reset-password.tsx",
];

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("every password field can be revealed (US-2530)", () => {
  it("no page renders a raw password input any more", () => {
    for (const rel of PAGES) {
      const src = read(rel);
      expect(src, `${rel} still has a bare password input`).not.toMatch(
        /<Input[\s\S]{0,200}?type="password"/,
      );
      expect(src, `${rel} does not use the shared field`).toContain(
        "<PasswordField",
      );
    }
  });

  it("all four fields are accounted for", () => {
    // login 1, signup 1, reset 2 (new + confirm).
    const total = PAGES.reduce(
      (n, rel) => n + (read(rel).match(/<PasswordField/g) ?? []).length,
      0,
    );
    expect(total).toBe(4);
  });

  it("the toggle's label states what pressing it will do", () => {
    const src = read(FIELD);
    expect(src).toMatch(/aria-label=\{revealed \? "Hide password" : "Show password"\}/);
    expect(src).toMatch(/aria-pressed=\{revealed\}/);
    // And it is a button, not a div with a click handler.
    expect(src).toMatch(/<button\s+type="button"/);
  });
});

describe("strength is shown while typing, not after submit (US-2530)", () => {
  it("signup and reset ask for the meter; sign-in does not", () => {
    // Sign-in scores an EXISTING password, where a meter would be noise and a
    // "weak" label on a password you cannot change here is worse than nothing.
    expect(read("src/pages/signup.tsx")).toMatch(/showStrength/);
    expect(read("src/pages/reset-password.tsx")).toMatch(/showStrength/);
    expect(read("src/pages/login.tsx")).not.toMatch(/showStrength/);
  });

  it("the meter names the rule that is still unmet", () => {
    const src = read(FIELD);
    expect(src).toMatch(/checkPassword\(text\)\.reason/);
    expect(src).toMatch(/aria-live="polite"/);
  });

  it("the score and the rule agree about what passes", () => {
    // A password the policy accepts must not read as the weakest score, or the
    // meter is arguing with the submit button.
    const good = "Abcdefghij1";
    expect(checkPassword(good).ok).toBe(true);
    expect(passwordStrength(good)).toBeGreaterThanOrEqual(2);
    // And one it rejects must not read as strong.
    expect(checkPassword("abc").ok).toBe(false);
    expect(passwordStrength("abc")).toBeLessThanOrEqual(1);
  });
});

describe("a failed sign-in stays on screen (US-2530)", () => {
  it("the message is held in state and rendered as an alert", () => {
    const src = read("src/pages/login.tsx");
    expect(src).toMatch(/const \[signInError, setSignInError\]/);
    expect(src).toMatch(/role="alert"/);
    expect(src).toMatch(/\{signInError\}/);
  });

  it("it clears on the next attempt rather than stacking", () => {
    const src = read("src/pages/login.tsx");
    const submitAt = src.indexOf("async function handleSubmit");
    const clearAt = src.indexOf("setSignInError(null)");
    expect(clearAt).toBeGreaterThan(submitAt);
    // Cleared BEFORE the request, not after it fails.
    expect(clearAt).toBeLessThan(src.indexOf("await signInWithEmail"));
  });

  it("the enumeration-safe messages are unchanged", () => {
    // US-369: the same text for a wrong password, an unknown email and an
    // unconfirmed one. Moving it from a toast to a panel must not have made it
    // more specific.
    const src = read("src/pages/login.tsx");
    expect(src).toContain("SIGN_IN_FAILED_MESSAGE");
    expect(src).toContain("AUTH_RATE_LIMIT_MESSAGE");
    expect(src).toContain("AUTH_NETWORK_ERROR_MESSAGE");
  });
});
