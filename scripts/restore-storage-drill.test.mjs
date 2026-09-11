// The storage restore path is the one this repo went longest without: a backup
// script, no restore, no drill, and nobody noticing because the backup kept
// exiting 0. The sibling of scripts/restore-drill.test.mjs, and for the same
// reason - these are source-scanned properties, not a run. Running the drill
// needs rclone on PATH, which CI does not have; running it is a manual step
// recorded in vault/10-ops/backups.md's drill log.
//
// Executed for real on 2026-09-11 (7/7 checks, 8/8 files byte-identical), which
// is what produced the two cases at the bottom: both guards were sabotaged and
// both went red.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const OPS = resolve(import.meta.dirname, "..", "scripts/ops");
const DRILL = readFileSync(resolve(OPS, "restore-storage-drill.sh"), "utf8");
const RESTORE = readFileSync(resolve(OPS, "restore-storage.sh"), "utf8");
const BACKUP = readFileSync(resolve(OPS, "backup-storage.sh"), "utf8");

describe("restore-storage.sh does not trust rclone's exit code", () => {
  it("refuses a restore that produced zero files", () => {
    // rclone exits 0 on a copy that moved nothing, so an existing-but-empty
    // prefix reads as a clean restore. Measured: exit 1 on an empty prefix.
    expect(RESTORE).toMatch(/if \[ "\$RESTORED" -eq 0 \]/);
    expect(RESTORE).toMatch(/restore produced ZERO files/);
  });

  it("refuses a source remote that is not type crypt", () => {
    // Checked against rclone's config, not the remote's NAME, because a remote
    // called r2crypt that is not of type crypt would otherwise read as safe.
    // Same check, same reason, as the backup side.
    expect(RESTORE).toMatch(/rclone config show "\$REMOTE_NAME"/);
    expect(RESTORE).toMatch(/\[ "\$REMOTE_TYPE" != "crypt" \]/);
    expect(BACKUP).toMatch(/\[ "\$REMOTE_TYPE" != "crypt" \]/);
  });

  it("refuses a non-empty target unless told otherwise", () => {
    expect(RESTORE).toMatch(/RESTORE_ALLOW_NONEMPTY/);
  });

  it("verifies CONTENT, and refuses to report success on an empty sample", () => {
    // This is the check the whole script turns on, so it gets two assertions.
    // --download re-reads both sides; without it rclone compares size and
    // modtime, which is exactly what let the impostor through.
    expect(RESTORE).toMatch(/rclone check "\$TARGET_DIR" "\$SRC"/);
    expect(RESTORE).toMatch(/--download/);
    // Zero files compared is zero differences found, which prints like a pass.
    expect(RESTORE).toMatch(/SAMPLE_COUNT/);
    expect(RESTORE).toMatch(/EMPTY verification list/);
  });

  it("keeps the default the full rebuild and says why", () => {
    // AC5. The default is the more destructive operation, which is only
    // defensible because the non-empty refusal stands in front of it. If the
    // default ever moves, the reasoning has to move with it.
    expect(RESTORE).toMatch(/RESTORE_PREFIX:-storage/);
    expect(RESTORE).toMatch(/SINGLE-OBJECT RECOVERY/);
    expect(RESTORE).toMatch(/storage-deleted/);
  });

  it("does not claim the sample check is what proves the crypt password", () => {
    // It is not. rclone crypt is authenticated, so a wrong password fails the
    // transfer on its own. The old comment said otherwise, and a check with a
    // made-up justification is one nobody defends when it gets in the way.
    expect(RESTORE).not.toMatch(/proves the crypt password/);
    expect(RESTORE).toMatch(/failed to authenticate decrypted block/);
  });
});

describe("the storage drill counts what it compared", () => {
  it("refuses to run against an empty source volume", () => {
    // Every check downstream passes over zero files. Sabotage-verified.
    expect(DRILL).toMatch(/if \[ "\$SOURCE_COUNT" -lt 8 \]/);
  });

  it("fails unless the hash loop covered every source file", () => {
    // Emptying the loop used to report "0 mismatches" and PASS. With this it
    // reports: compared 0 file(s) but the source has 8.
    expect(DRILL).toMatch(/COMPARED=\$\(\(COMPARED \+ 1\)\)/);
    expect(DRILL).toMatch(/\[ "\$COMPARED" -ne "\$SOURCE_COUNT" \]/);
  });

  it("exercises the skipped-impostor case, not just a happy round trip", () => {
    // The case rclone does not catch by itself, and therefore the only case
    // that justifies the --download check existing at all. With
    // RESTORE_SAMPLE=0 the restore exits 0 with the wrong bytes in place.
    expect(DRILL).toMatch(/impostor/i);
    expect(DRILL).toMatch(/contents differ/);
  });

  it("calls the real scripts rather than reimplementing them", () => {
    // A drill that reimplements the procedure measures the reimplementation.
    expect(DRILL).toMatch(/bash scripts\/ops\/backup-storage\.sh/);
    expect(DRILL).toMatch(/bash scripts\/ops\/restore-storage\.sh/);
  });

  it("never reads or writes the real rclone config", () => {
    // It builds a throwaway config and an ephemeral crypt remote over a local
    // directory, so the drill cannot touch production or need a credential.
    expect(DRILL).toMatch(/RCLONE_CONFIG="\$WORK_DIR\/rclone\.conf"/);
    expect(DRILL).toMatch(/export RCLONE_CONFIG/);
    expect(DRILL).not.toMatch(/r2crypt|gradethread-backups/);
  });

  it("says on every PASS what it did not prove", () => {
    // A green drill is exactly when people stop asking whether the real crypt
    // password exists anywhere but the host. AC3/AC6 are still open.
    const passBlock = DRILL.slice(DRILL.indexOf("STORAGE RESTORE DRILL: PASS"));
    expect(passBlock).toMatch(/did NOT prove/);
    expect(passBlock).toMatch(/key-rotation\.md/);
  });
});

describe("the ops shell scripts stay LF and ASCII", () => {
  // .gitattributes pins these to LF because a CRLF shebang breaks
  // Git-for-Windows `sh`, and a look-alike character in a shell string is a
  // runtime failure that survives review.
  for (const [name, body] of [
    ["restore-storage.sh", RESTORE],
    ["restore-storage-drill.sh", DRILL],
  ]) {
    it(`${name} has no CR bytes and no non-ASCII`, () => {
      expect(body.includes("\r")).toBe(false);
      const offenders = body.match(/[^\x00-\x7F]/g) ?? [];
      expect(offenders).toEqual([]);
    });
  }
});
