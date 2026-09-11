// The storage drill's encryption claim used to be made over an empty directory
// (US-2659).
//
// rclone on this box is a NATIVE WINDOWS binary, so it read the drill's MSYS
// path "/tmp/drill.X/remote" as "C:\tmp\drill.X\remote" and wrote the whole
// mirror there. The shell's $REMOTE_DIR pointed somewhere else, so step 3's
// `grep -r "label photo bytes" "$REMOTE_DIR"` scanned a directory with nothing
// in it, found no plaintext, and printed PASS. Every other step goes through
// rclone, which knows where it really wrote, so nothing else noticed: the drill
// was green, 8 of 8 files round-tripped, and the ONE claim about the mirror
// being encrypted had inspected zero bytes. Measured 2026-09-11, along with 15
// abandoned remote trees outside the work dir the cleanup trap deletes.
//
// The fix is two parts and this file pins both, because the first is a path
// conversion that is easy to drop and the second is what makes dropping it
// loud. Sibling of scripts/restore-storage-drill.test.mjs, which owns the
// script's other properties; this file is here rather than beside it because
// src/test/ is the lane that runs in verify:web and in CI, and because the
// drill itself needs rclone and runs by hand.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DRILL_PATH = resolve(process.cwd(), "scripts/ops/restore-storage-drill.sh");
const DRILL = readFileSync(DRILL_PATH, "utf8");

describe("the drill's remote directory is one the shell can see", () => {
  it("hands rclone a converted path, not the MSYS one", () => {
    // cygpath -w turns /tmp/x into C:\Users\...\Temp\x, which is the same
    // directory from both sides. Without it rclone invents C:\tmp\x.
    expect(DRILL).toMatch(/cygpath -w "\$REMOTE_DIR"/);
    expect(DRILL).toMatch(/remote "drillbase:\$REMOTE_DIR_RCLONE"/);
  });

  it("still works where cygpath does not exist", () => {
    // Linux and macOS have no cygpath and need no conversion. A drill that
    // required it would run nowhere but here.
    expect(DRILL).toMatch(/command -v cygpath/);
    expect(DRILL).toMatch(/REMOTE_DIR_RCLONE="\$REMOTE_DIR"/);
  });
});

describe("step 3 counts the objects before believing the plaintext scan", () => {
  it("compares the remote object count against the source count", () => {
    expect(DRILL).toMatch(/REMOTE_OBJECTS=/);
    expect(DRILL).toMatch(/\[ "\$REMOTE_OBJECTS" -lt "\$SOURCE_COUNT" \]/);
  });

  it("counts BEFORE it greps, so an empty remote cannot read as encrypted", () => {
    // Ordering is the property, not presence: a count printed after the scan
    // would decorate the same vacuous pass.
    const countAt = DRILL.indexOf('REMOTE_OBJECTS="$(find');
    const grepAt = DRILL.indexOf('grep -rqs "label photo bytes"');
    expect(countAt).toBeGreaterThan(-1);
    expect(grepAt).toBeGreaterThan(-1);
    expect(countAt).toBeLessThan(grepAt);
  });

  it("puts the object count in the PASS line", () => {
    // A pass that says "no plaintext across 8 encrypted object(s)" cannot be
    // printed by a run that looked at nothing. "no plaintext in the remote
    // directory" could, and was.
    expect(DRILL).toMatch(/no plaintext across \$REMOTE_OBJECTS encrypted object/);
  });
});

describe("step 8 proves a rotten object stops the restore", () => {
  it("corrupts an object on the REMOTE, which is the other direction from step 7", () => {
    // Step 7 is a wrong-byte file in the target. This is a wrong-byte object in
    // the bucket: bit rot, a truncated multipart upload, a partial overwrite.
    expect(DRILL).toMatch(/ROTTEN=/);
    expect(DRILL).toMatch(/ROTTEN_SIZE - 8/);
  });

  it("fails if the corruption did not take", () => {
    // An unchanged object restores cleanly, and "the restore worked" would then
    // be reported as step 8 passing. Measured: making the truncation a no-op
    // gives "failed to corrupt the remote object (still 87 bytes)".
    expect(DRILL).toMatch(/\[ "\$ROTTEN_NOW" -ge "\$ROTTEN_SIZE" \]/);
    expect(DRILL).toMatch(/step 8 proved nothing/);
  });

  it("requires the authentication error, not merely a non-zero exit", () => {
    // rclone crypt is authenticated, so the tail of a damaged block fails to
    // verify. Any other non-zero exit would mean something else went wrong.
    expect(DRILL).toMatch(/ROT_CODE" -ne 0/);
    expect(DRILL).toMatch(/grep -q "failed to authenticate decrypted block"/);
  });

  it("records that this message is indistinguishable from a lost password", () => {
    // The operational half: one object failing is a rotten object, every object
    // failing is the wrong key. An operator who reads "bad password?" off a
    // single file and concludes the key is gone gives up on a recoverable
    // mirror. Written up in vault/10-ops/backups.md.
    expect(DRILL).toMatch(/ONE object failing is a rotten object/);
  });
});
