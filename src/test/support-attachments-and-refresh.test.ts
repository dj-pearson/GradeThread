import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2525. A support ticket took text only, on both clients — so the person
// reporting "this photo graded wrong" had to describe the photo. The web thread
// also never refreshed (iOS has had pull-to-refresh since it shipped), a user
// could not end their own conversation, and both error branches were a bare red
// line with no retry.

const PAGE = "src/pages/support-tickets.tsx";
const PICKER = "src/components/support/attachment-picker.tsx";
const ROUTE = "services/edge-functions/src/routes/support-tickets.ts";
const MIGRATION = "supabase/migrations/00593_support_ticket_attachments.sql";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("attachments follow the US-276 upload path (US-2525)", () => {
  it("the server sniffs the bytes, strips metadata, then uploads", () => {
    const src = read(ROUTE);
    // Order matters and is the whole rule: validate (magic bytes, never the
    // client's content-type) → strip EXIF/GPS → upload.
    const validateAt = src.indexOf("validateImageUpload(bytes");
    const stripAt = src.indexOf("stripImageMetadata(bytes");
    const uploadAt = src.indexOf(".upload(path, clean");
    expect(validateAt).toBeGreaterThan(-1);
    expect(stripAt).toBeGreaterThan(validateAt);
    expect(uploadAt).toBeGreaterThan(stripAt);
  });

  it("files land in the PRIVATE bucket under the uploader's own folder", () => {
    const src = read(ROUTE);
    expect(src).toMatch(/\.from\("submission-images"\)/);
    expect(src).toMatch(/\$\{userId\}\/support\/\$\{ticketId\}/);
    // A private bucket is read through signed URLs only — never getPublicUrl.
    expect(src).not.toContain("getPublicUrl");
    expect(src).toMatch(/createSignedUrl\(a\.path, ATTACHMENT_URL_TTL_SEC\)/);
  });

  it("a rejected attachment fails the message rather than dropping quietly", () => {
    const src = read(ROUTE);
    expect(src).toMatch(/if \(!uploaded\.ok\) return c\.json\(\{ error: uploaded\.error \}, 400\)/);
  });

  it("the picker exists on both the new-ticket form and the reply", () => {
    const src = read(PAGE);
    const uses = src.match(/<AttachmentPicker/g) ?? [];
    expect(uses.length).toBe(2);
    expect(read(PICKER)).toContain("compressImage");
  });

  it("the thread renders what came back, and says when a link has expired", () => {
    const src = read(PAGE);
    expect(src).toMatch(/m\.attachments \?\? \[\]/);
    expect(src).toContain("Link expired");
    expect(src).toContain('rel="noopener noreferrer"');
  });
});

describe("the thread keeps up, and the user can end it (US-2525)", () => {
  it("the thread refetches without a manual reload", () => {
    const src = read(PAGE);
    expect(src).toMatch(/refetchInterval: 30_000/);
    expect(src).toMatch(/refetchOnWindowFocus: true/);
  });

  it("a user can close their own ticket, and closing is not resolving", () => {
    const src = read(PAGE);
    expect(src).toContain("Close ticket");
    expect(src).toMatch(/\/close`/);
    const route = read(ROUTE);
    expect(route).toMatch(/supportTicketRoutes\.post\("\/:id\/close"/);
    // 'resolved' is the operator's verdict that the problem was fixed. A user
    // setting it would overwrite support's own record of what happened.
    expect(route).toMatch(/\.update\(\{ status: "closed" \} as never\)/);
    expect(route).not.toMatch(/status: "resolved" \} as never/);
    // Tenant-scoped, like every other write in the file.
    expect(route).toMatch(/loadOwnedTicket\(userId, c\.req\.param\("id"\)\)/);
  });

  it("both error branches are the shared ErrorState with a retry", () => {
    const src = read(PAGE);
    const states = src.match(/<ErrorState/g) ?? [];
    expect(states.length).toBe(2);
    expect(src).toMatch(/onRetry=\{\(\) => listQuery\.refetch\(\)\}/);
    expect(src).toMatch(/onRetry=\{\(\) => threadQuery\.refetch\(\)\}/);
    // The bare red line is gone.
    expect(src).not.toMatch(/text-sm text-brand-red-text">\s*<AlertTriangle/);
  });
});

describe("the migration carries the US-1108 triple (US-2525)", () => {
  it("is idempotent and self-recording", () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS attachments jsonb/);
    expect(sql).toMatch(
      /insert into public\.applied_migrations \(version\) values \('00593'\)/,
    );
  });

  it("the edge expects at least this migration", () => {
    // Not an equality check — the next migration moves the number. See the same
    // guard in import-durable-and-reversible.test.ts, which was pinned to an
    // exact value and went red the moment this story added a migration.
    const version = read("services/edge-functions/src/lib/schema-version.ts");
    const found = /EXPECTED_SCHEMA_VERSION = "(\d+)"/.exec(version);
    expect(found, "EXPECTED_SCHEMA_VERSION is missing").toBeTruthy();
    expect(Number(found![1])).toBeGreaterThanOrEqual(593);
  });
});
