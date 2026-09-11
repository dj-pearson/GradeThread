// US-3398: the deletion RECORD has to survive a purge that did not finish.
//
// THE DEFECT THIS FILE REPRODUCES. routes/account.ts and
// routes/admin-compliance.ts both inserted `storage_purged: true` into
// account_deletion_log as a literal, on every path, whatever the sweep above it
// did. US-3391 had just routed every list refusal, truncation and depth-skip to
// a sink that prints INCOMPLETE ERASURE -- into the container log, and nowhere
// near the row a regulator or a customer is shown.
//
// SO ASSERTING THAT THE FLAG IS WRITTEN PROVES NOTHING. It was always written.
// Every test below DRIVES A FAILING PURGE through the real collector or the
// real remove path, and then asserts the row does NOT claim success.
//
// The last three tests read the two route files. The claim they pin is a
// property of the arrangement of a file -- that no route reintroduces a literal
// -- and that is only checkable at the source, the same idiom
// account-erasure-order_test.ts uses one directory over.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  collectOwnedStorageObjects,
  createPurgeRecorder,
  MAX_RECORDED_FAILURES,
  type PurgeDb,
  type PurgeListEntry,
  REMOVE_CHUNK_SIZE,
  removeInChunks,
} from "../lib/account-storage-purge.ts";

const USER = "33333333-3333-4333-8333-333333333333";

// ── A storage + row fake, same shape as staging-orphan-erasure_test.ts ───────

interface FakeBucket {
  objects: Set<string>;
  failOn?: (prefix: string) => string | null;
}

function bucket(paths: string[], failOn?: (prefix: string) => string | null): FakeBucket {
  return { objects: new Set(paths), failOn };
}

function fakeDb(buckets: Record<string, FakeBucket>): PurgeDb {
  return {
    from(_table: string) {
      return {
        select(_columns: string) {
          return {
            eq: () => Promise.resolve({ data: [] as Record<string, unknown>[] }),
            in: () => Promise.resolve({ data: [] as Record<string, unknown>[] }),
          };
        },
      };
    },
    storage: {
      from(name: string) {
        const b = buckets[name] ?? { objects: new Set<string>() };
        return {
          list(prefix: string, opts?: { limit?: number; offset?: number }) {
            const failure = b.failOn?.(prefix) ?? null;
            if (failure) return Promise.resolve({ data: null, error: { message: failure } });
            const head = prefix === "" ? "" : `${prefix}/`;
            const children = new Map<string, boolean>();
            for (const path of b.objects) {
              if (!path.startsWith(head)) continue;
              const rest = path.slice(head.length);
              if (rest.length === 0) continue;
              const cut = rest.indexOf("/");
              if (cut === -1) children.set(rest, false);
              else children.set(rest.slice(0, cut), true);
            }
            const all: PurgeListEntry[] = [...children.entries()]
              .sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0))
              .map(([name, isFolder]) => ({ name, id: isFolder ? null : `id-${name}` }));
            const offset = opts?.offset ?? 0;
            const limit = opts?.limit ?? 100;
            return Promise.resolve({ data: all.slice(offset, offset + limit), error: null });
          },
        };
      },
    },
  } as unknown as PurgeDb;
}

// ── AC1 + AC2: a purge that fails must not produce a row that says it worked ──

Deno.test("US-3398: a refused LISTING makes the log row say incomplete, not purged", async () => {
  // item-photos is the public bucket and the one with a staging tree. A refusal
  // there means stranded objects stayed on guessable public URLs -- the exact
  // case US-3391 found -- and the old code recorded that as a clean purge.
  const rec = createPurgeRecorder(USER, () => {});
  await collectOwnedStorageObjects(
    fakeDb({ "item-photos": bucket([], () => "storage backend unavailable") }),
    USER,
    { onListFailure: rec.onListFailure },
  );

  const row = rec.logFields();
  assertEquals(
    row.storage_purged,
    false,
    "the boolean must not say true when a listing was refused: the objects we " +
      "did not see are objects we did not delete",
  );
  assertEquals(row.storage_purge_status, "incomplete");
  assertEquals(row.storage_purge_failures?.count, 1);
  assertEquals(row.storage_purge_failures?.notes[0]?.bucket, "item-photos");
  assertEquals(row.storage_purge_failures?.notes[0]?.phase, "list");
  assert(
    /storage backend unavailable/.test(row.storage_purge_failures?.notes[0]?.reason ?? ""),
    "the reason the storage gave has to reach the row, or the operator is back " +
      "to grepping a rotated container log",
  );
});

Deno.test("US-3398: a failing remove() makes the log row say incomplete, not purged", async () => {
  const rec = createPurgeRecorder(USER, () => {});
  await removeInChunks(
    "submission-images",
    [`${USER}/s1/front.jpg`, `${USER}/s1/label.jpg`],
    () => Promise.resolve({ error: { message: "bucket is read-only" } }),
    rec,
  );

  const row = rec.logFields();
  assertEquals(row.storage_purged, false);
  assertEquals(row.storage_purge_status, "incomplete");
  assertEquals(row.storage_objects_removed, 0, "nothing was removed, so nothing is counted");
  assertEquals(row.storage_purge_failures?.notes[0]?.phase, "remove");
  assert(/2 object\(s\)/.test(row.storage_purge_failures?.notes[0]?.reason ?? ""));
});

Deno.test("US-3398: one refused bucket out of five is INCOMPLETE, not false and not true", async () => {
  // The shape a boolean cannot hold. avatars and expense-receipts list fine and
  // their objects really are gone; item-photos refused. "false" alone would say
  // the purge did nothing, "true" would say it finished. Neither is what
  // happened, which is why the status column exists.
  const rec = createPurgeRecorder(USER, () => {});
  await collectOwnedStorageObjects(
    fakeDb({
      avatars: bucket([`${USER}/me.jpg`]),
      "item-photos": bucket([`${USER}/_staging/a/x.jpg`], (p) => p.endsWith("_staging") ? "nope" : null),
    }),
    USER,
    { onListFailure: rec.onListFailure },
  );
  await removeInChunks("avatars", [`${USER}/me.jpg`], () => Promise.resolve({ error: null }), rec);

  const row = rec.logFields();
  assertEquals(row.storage_purge_status, "incomplete");
  assertEquals(row.storage_purged, false);
  assertEquals(
    row.storage_objects_removed,
    1,
    "the partial success is recorded as well as the failure, or an operator " +
      "cannot tell a refused listing from a purge that never ran",
  );
});

Deno.test("US-3398: a purge with nothing to remove is complete, not incomplete", async () => {
  // The other half of AC1. An account that owns no objects is fully erased, and
  // a status column that cried wolf on every empty account would be ignored
  // inside a month.
  const rec = createPurgeRecorder(USER, () => {});
  await collectOwnedStorageObjects(fakeDb({}), USER, { onListFailure: rec.onListFailure });

  const row = rec.logFields();
  assertEquals(row.storage_purged, true);
  assertEquals(row.storage_purge_status, "complete");
  assertEquals(row.storage_objects_removed, 0);
  assertEquals(row.storage_purge_failures, null);
});

Deno.test("US-3398: a clean sweep counts every object across chunk boundaries", async () => {
  const rec = createPurgeRecorder(USER, () => {});
  const many = Array.from({ length: REMOVE_CHUNK_SIZE * 2 + 7 }, (_, i) => `${USER}/i/${i}.jpg`);
  const seen: number[] = [];
  await removeInChunks("item-photos", many, (slice) => {
    seen.push(slice.length);
    return Promise.resolve({ error: null });
  }, rec);

  assertEquals(seen, [REMOVE_CHUNK_SIZE, REMOVE_CHUNK_SIZE, 7]);
  assertEquals(rec.logFields().storage_objects_removed, many.length);
  assertEquals(rec.logFields().storage_purged, true);
});

Deno.test("US-3398: one failed chunk does not stop the sweep, and is still recorded", async () => {
  // Best-effort stays best-effort. Refusing to continue would leave a person
  // half-erased, which is worse than an honest partial record.
  const rec = createPurgeRecorder(USER, () => {});
  const many = Array.from({ length: REMOVE_CHUNK_SIZE + 5 }, (_, i) => `${USER}/i/${i}.jpg`);
  let call = 0;
  await removeInChunks("item-photos", many, () => {
    call++;
    return Promise.resolve({ error: call === 1 ? { message: "timeout" } : null });
  }, rec);

  assertEquals(call, 2, "the second chunk must still be attempted");
  const row = rec.logFields();
  assertEquals(row.storage_objects_removed, 5);
  assertEquals(row.storage_purge_status, "incomplete");
});

// ── The record must not become a PII leak or an unbounded blob ───────────────

Deno.test("US-3398: recorded paths are relative, so the row keeps holding no PII", async () => {
  // 00064 is explicit that this table holds no email, name or address. The user
  // id is already in deleted_user_id on the same row, so repeating it inside a
  // failure note buys nothing and starts an argument.
  const rec = createPurgeRecorder(USER, () => {});
  await collectOwnedStorageObjects(
    fakeDb({
      "item-photos": bucket(
        [`${USER}/_staging/gphotos/originals/a.jpg`],
        (p) => p.endsWith("/gphotos") ? "listing blew up" : null,
      ),
    }),
    USER,
    { onListFailure: rec.onListFailure },
  );

  const note = rec.logFields().storage_purge_failures?.notes[0];
  assertEquals(note?.path, "_staging/gphotos");
  assert(
    !JSON.stringify(rec.logFields()).includes(USER),
    "no part of the recorded row may repeat the user id",
  );
});

Deno.test("US-3398: notes are capped while the count stays exact", () => {
  const rec = createPurgeRecorder(USER, () => {});
  for (let i = 0; i < MAX_RECORDED_FAILURES + 12; i++) {
    rec.noteRemoveFailure("item-photos", 1, `failure ${i}`);
  }
  const row = rec.logFields();
  assertEquals(row.storage_purge_failures?.count, MAX_RECORDED_FAILURES + 12);
  assertEquals(row.storage_purge_failures?.notes.length, MAX_RECORDED_FAILURES);
});

Deno.test("US-3398: the default sink still says INCOMPLETE ERASURE for a remove failure", async () => {
  // The container line was the only signal before this story and it stays.
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await removeInChunks(
      "item-photos",
      [`${USER}/a.jpg`],
      () => Promise.resolve({ error: { message: "nope" } }),
      createPurgeRecorder(USER),
    );
  } finally {
    console.error = original;
  }
  assertEquals(lines.length, 1);
  assert(/INCOMPLETE ERASURE/.test(lines[0] ?? ""), lines[0]);
  assert(/could not remove/.test(lines[0] ?? ""), lines[0]);
});

// ── AC4 + the ratchet: no route may write the claim as a literal again ───────

const ROUTES = new URL("../routes/", import.meta.url);

async function routeSource(file: string): Promise<string> {
  return await Deno.readTextFile(new URL(file, ROUTES));
}

/**
 * Source with whole-line `//` comments dropped.
 *
 * Both routes now explain in a comment what they used to write, and a guard
 * that counted those would fire on its own documentation. Line-level, because
 * every comment in these two files is a `//` line -- and self-checked below,
 * since a stripper that quietly strips nothing is the classic way a source scan
 * passes against broken code.
 */
function codeOnly(src: string): string {
  return src
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

Deno.test("US-3398: the comment filter strips comments and keeps code", () => {
  const sample = "// storage_purged: true\nconst a = 1;\r\n  // storage_purged: false\n";
  const out = codeOnly(sample);
  assertEquals(/storage_purged/.test(out), false, "the stripper is a no-op");
  assert(out.includes("const a = 1;"), "the stripper ate code");
});

Deno.test("US-3398: no edge route writes storage_purged as a literal", async () => {
  // The ratchet. Both erasure paths set that column by hand and a third would be
  // written the same way. The only legitimate way to set it now is to spread the
  // recorder's fields.
  const offenders: string[] = [];
  for await (const entry of Deno.readDir(ROUTES)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const src = codeOnly(await routeSource(entry.name));
    if (/storage_purged\s*:/.test(src)) offenders.push(entry.name);
  }
  assertEquals(
    offenders,
    [],
    "these routes set account_deletion_log.storage_purged directly. Spread " +
      "createPurgeRecorder(...).logFields() instead, so the value is what the " +
      "purge did rather than what the author hoped: " + offenders.join(", "),
  );
});

Deno.test("US-3398: both erasure routes record the purge they actually ran", async () => {
  for (const file of ["account.ts", "admin-compliance.ts"]) {
    // Comments stripped here too: a guard that a COMMENT can satisfy is a guard
    // that survives the code being deleted.
    const src = codeOnly(await routeSource(file));
    assert(
      src.includes("createPurgeRecorder("),
      `${file}: no purge recorder. The account_deletion_log insert would be ` +
        `claiming an outcome nobody measured.`,
    );
    assert(
      src.includes("{ onListFailure: purge.onListFailure }"),
      `${file}: the collector's failures do not reach the recorder, so a ` +
        `refused listing would still be logged as a complete purge.`,
    );
    assert(
      /removeAll\([^)]*purge\)/.test(src),
      `${file}: the sweep does not hand the recorder to removeAll, so a failed ` +
        `remove() would still be logged as a complete purge.`,
    );
    assert(
      src.includes("...purge.logFields()"),
      `${file}: the deletion-log insert does not carry the purge record.`,
    );
  }
});
