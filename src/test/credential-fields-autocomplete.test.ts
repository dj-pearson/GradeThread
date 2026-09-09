import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-3225.
//
// `autocomplete` on a credential field is not a nicety — it is the instruction
// a password manager reads. Without `new-password`, Chrome, Safari/iCloud
// Keychain and 1Password are all far less likely to offer to generate or SAVE
// the password a user just created, so the account exists and the credential
// does not. Without it on a RESET form, the manager has no reason to update
// what it already stored, so it keeps autofilling the old password and the
// user resets again.
//
// login.tsx had `email` and `current-password` from the start. signup.tsx,
// reset-password.tsx and the settings change-password card had nothing at all,
// which meant the two forms where a password is CREATED were the two the
// manager was least likely to record.
//
// Source scan, so the self-check below fails if the extractor stops finding
// the fields it is asserting about.

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/** Every field id that must carry an explicit autocomplete token. */
const REQUIRED: { file: string; id: string; token: string }[] = [
  { file: "src/pages/login.tsx", id: "email", token: "email" },
  { file: "src/pages/login.tsx", id: "password", token: "current-password" },

  { file: "src/pages/signup.tsx", id: "name", token: "name" },
  { file: "src/pages/signup.tsx", id: "email", token: "email" },
  { file: "src/pages/signup.tsx", id: "password", token: "new-password" },

  { file: "src/pages/reset-password.tsx", id: "email", token: "email" },
  { file: "src/pages/reset-password.tsx", id: "password", token: "new-password" },
  { file: "src/pages/reset-password.tsx", id: "confirm", token: "new-password" },

  { file: "src/pages/settings.tsx", id: "currentPassword", token: "current-password" },
  { file: "src/pages/settings.tsx", id: "newPassword", token: "new-password" },
  { file: "src/pages/settings.tsx", id: "confirmPassword", token: "new-password" },
];

/**
 * The props of the element carrying `id="<id>"`, from that id up to the tag's
 * closing `/>`. Good enough for these hand-written forms and, unlike a
 * whole-file grep, it cannot be satisfied by an autocomplete on a DIFFERENT
 * field in the same file — which is exactly how this defect would come back.
 */
function propsOfFieldWithId(src: string, id: string): string | null {
  const at = src.indexOf(`id="${id}"`);
  if (at === -1) return null;
  const close = src.indexOf("/>", at);
  return close === -1 ? null : src.slice(at, close);
}

describe("credential fields tell the password manager what they are (US-3225)", () => {
  it("finds every field it checks (self-check)", () => {
    // A renamed id must fail loudly rather than drop out of the assertion.
    const missing = REQUIRED.filter(
      ({ file, id }) => propsOfFieldWithId(read(file), id) === null,
    ).map(({ file, id }) => `${file} #${id}`);
    expect(missing, `these ids no longer exist:\n  ${missing.join("\n  ")}`).toEqual([]);
    expect(REQUIRED.length).toBeGreaterThan(8);
  });

  it("every credential field carries the right autocomplete token", () => {
    const wrong: string[] = [];
    for (const { file, id, token } of REQUIRED) {
      const props = propsOfFieldWithId(read(file), id);
      if (props === null) continue; // reported by the self-check above
      if (!props.includes(`autoComplete="${token}"`)) {
        wrong.push(`${file} #${id} — expected autoComplete="${token}"`);
      }
    }
    expect(
      wrong,
      "a password field with no autocomplete token is one a password " +
        "manager will not reliably save or update, so the account outlives " +
        "the credential:\n  " + wrong.join("\n  "),
    ).toEqual([]);
  });
});
