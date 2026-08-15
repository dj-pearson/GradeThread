import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isAttachmentUrlUsable,
  isSupportDataUrl,
  statusAfterUserClose,
  statusAfterUserReply,
  SUPPORT_ATTACHMENT_FORMATS,
  SUPPORT_ATTACHMENT_JPEG_QUALITY,
  SUPPORT_ATTACHMENT_MAX_WIDTH,
  SUPPORT_ATTACHMENT_URL_TTL_SEC,
  SUPPORT_DATA_URL_PATTERN,
  SUPPORT_MAX_ATTACHMENTS,
  SUPPORT_URL_EXPIRY_MARGIN_SEC,
} from "@/lib/support-attachment-contract";

// US-2561. The Swift half needs macOS. This pins the protocol it implements
// against the code that already serves it, so the contract cannot be a
// well-meaning guess and cannot drift once the iOS work lands.
//
// Every value in the contract module is READ BACK from its source here. A
// contract file nobody checks is documentation, and documentation about a wire
// format is the kind that goes wrong silently.

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/** Source with comments removed — prose describing a value is not the value. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const EDGE_ROUTE = "services/edge-functions/src/routes/support-tickets.ts";
const WEB_PICKER = "src/components/support/attachment-picker.tsx";
const WEB_PAGE = "src/pages/support-tickets.tsx";
const IMAGE_UTILS = "src/lib/image-utils.ts";
const SWIFT = "ios/GradeThread/Support/SupportTicketsView.swift";

function constant(rel: string, name: string): number {
  const m = new RegExp(`${name}\\s*=\\s*(\\d+(?:\\.\\d+)?)`).exec(code(rel));
  if (!m) throw new Error(`${name} not found in ${rel}`);
  return Number(m[1]);
}

describe("the attachment limit agrees everywhere (US-2561 AC2)", () => {
  it("matches the server, which is the one that rejects", () => {
    expect(constant(EDGE_ROUTE, "MAX_ATTACHMENTS_PER_MESSAGE")).toBe(
      SUPPORT_MAX_ATTACHMENTS,
    );
  });

  it("matches the web picker, which is the one that stops you", () => {
    // Two independent constants today; a Swift one would be the third. If the
    // client's limit exceeds the server's, the user waits through an upload and
    // then gets a 400 — the worst ordering of the two failures.
    expect(constant(WEB_PICKER, "MAX_ATTACHMENTS")).toBe(SUPPORT_MAX_ATTACHMENTS);
  });
});

describe("the wire format is what the server actually parses", () => {
  it("uses the TTL the GET signs with", () => {
    expect(constant(EDGE_ROUTE, "ATTACHMENT_URL_TTL_SEC")).toBe(
      SUPPORT_ATTACHMENT_URL_TTL_SEC,
    );
    // US-276 caps the private bucket at 900s. A contract claiming more would be
    // asking a client to trust a URL the storage layer will not honour.
    expect(SUPPORT_ATTACHMENT_URL_TTL_SEC).toBeLessThanOrEqual(900);
  });

  it("names the formats the validator allows", () => {
    const m = /allow:\s*\[([^\]]+)\]/.exec(code(EDGE_ROUTE));
    expect(m, "the allow list moved").toBeTruthy();
    const allowed = [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(allowed).toEqual([...SUPPORT_ATTACHMENT_FORMATS]);
  });

  it("sends data_url, not dataUrl", () => {
    // The edge reads `item?.data_url`. A camelCase key decodes to null and
    // surfaces as "One attachment was not an image." — a message that blames the
    // bytes when the key was wrong, which is exactly the kind of thing a second
    // client implementation gets wrong once and debugs for an hour.
    expect(code(EDGE_ROUTE)).toContain("data_url");
    expect(code(WEB_PAGE)).toContain("data_url: a.dataUrl");
  });

  it("accepts the data URLs the server accepts, and rejects the rest", () => {
    expect(isSupportDataUrl("data:image/jpeg;base64,AAAA")).toBe(true);
    expect(isSupportDataUrl("data:image/png;base64,AA==")).toBe(true);
    expect(isSupportDataUrl("data:image/svg+xml;base64,AAAA")).toBe(true);
    // No media type, and no base64 declaration: both rejected server-side.
    expect(isSupportDataUrl("data:;base64,AAAA")).toBe(false);
    expect(isSupportDataUrl("data:image/png,AAAA")).toBe(false);
    expect(isSupportDataUrl("https://example.com/a.png")).toBe(false);
  });

  it("keeps the same pattern the server decodes with", () => {
    // Both are the same regex; a client that is stricter rejects uploads the
    // server would take, and one that is looser sends bodies it will refuse.
    //
    // Compare the LITERAL as text rather than writing a regex that matches a
    // regex. The first attempt did the latter and failed on its own escaping,
    // which is a warning worth heeding: a pattern-matching-a-pattern is
    // unreadable, and when it breaks you cannot tell a real drift from a
    // backslash you miscounted.
    const src = read(EDGE_ROUTE);
    const start = src.indexOf("/^data:image");
    expect(start, "the server's data-URL literal moved").toBeGreaterThan(0);
    const literal = src.slice(start, src.indexOf("/i", start) + 2);
    expect(literal).toBe(`/${SUPPORT_DATA_URL_PATTERN.source}/i`);
  });
});

describe("a dead url is a placeholder, not a broken image (AC3)", () => {
  const T0 = 1_000_000_000_000;

  it("a null url is never usable", () => {
    expect(isAttachmentUrlUsable(null, T0, T0)).toBe(false);
  });

  it("a fresh url is usable", () => {
    expect(isAttachmentUrlUsable("https://x/y", T0, T0 + 1000)).toBe(true);
  });

  it("an EXPIRED url is not, even though it is a perfectly good string", () => {
    // The case a null-check misses entirely. The response was valid when it
    // arrived and rots in place — a user who reads a thread, switches apps and
    // comes back has a screen full of URLs that look fine and load nothing.
    const past = (SUPPORT_ATTACHMENT_URL_TTL_SEC + 60) * 1000;
    expect(isAttachmentUrlUsable("https://x/y", T0, T0 + past)).toBe(false);
  });

  it("treats a url about to expire as already gone", () => {
    const nearly = (SUPPORT_ATTACHMENT_URL_TTL_SEC - 5) * 1000;
    expect(isAttachmentUrlUsable("https://x/y", T0, T0 + nearly)).toBe(false);
    // And the margin is what makes that true, not an accident of the numbers.
    expect(SUPPORT_URL_EXPIRY_MARGIN_SEC).toBeGreaterThan(0);
  });

  it("a backwards clock is not evidence of freshness", () => {
    expect(isAttachmentUrlUsable("https://x/y", T0, T0 - 60_000)).toBe(false);
  });
});

describe("close and reopen match the server (AC4)", () => {
  it("a reply reopens a resolved or closed ticket and leaves the rest alone", () => {
    expect(statusAfterUserReply("closed")).toBe("open");
    expect(statusAfterUserReply("resolved")).toBe("open");
    expect(statusAfterUserReply("open")).toBe("open");
    expect(statusAfterUserReply("pending")).toBe("pending");
  });

  it("the user closes, and never resolves", () => {
    // `resolved` is support's verdict that the problem was fixed. A user setting
    // it would overwrite support's own record of what happened.
    expect(statusAfterUserClose()).toBe("closed");
    const route = code(EDGE_ROUTE);
    const closeHandler = route.slice(route.indexOf('post("/:id/close"'));
    expect(closeHandler).toContain('status: "closed"');
    expect(closeHandler.slice(0, closeHandler.indexOf("});"))).not.toContain(
      '"resolved"',
    );
  });

  it("mirrors the server's own reopen rule", () => {
    expect(code(EDGE_ROUTE)).toContain(
      'ticket.status === "resolved" || ticket.status === "closed"',
    );
  });

  it("the endpoints the story needs all already exist", () => {
    const route = code(EDGE_ROUTE);
    for (const r of ['post("/"', 'post("/:id/messages"', 'post("/:id/close"', 'get("/:id"']) {
      expect(route, r).toContain(r);
    }
  });
});

describe("the on-device downscale matches the web picker (AC5)", () => {
  it("uses the same numbers compressImage defaults to", () => {
    const m = /compressImage\([\s\S]{0,200}?maxWidth = (\d+),\s*quality = ([\d.]+)/
      .exec(code(IMAGE_UTILS));
    expect(m, "compressImage defaults moved").toBeTruthy();
    expect(Number(m![1])).toBe(SUPPORT_ATTACHMENT_MAX_WIDTH);
    expect(Number(m![2])).toBe(SUPPORT_ATTACHMENT_JPEG_QUALITY);
  });

  it("the web picker does compress before sending", () => {
    // The premise for asking iOS to. If the web stopped compressing, matching it
    // would be the wrong instruction.
    expect(code(WEB_PICKER)).toContain("compressImage(file)");
  });
});

describe("the gap this story exists to close (AC1)", () => {
  it("the iOS view still sends body text only", () => {
    // A BASELINE, not a permanent assertion. When the Swift half lands this
    // should be updated to assert the opposite — the value until then is that
    // nobody re-files the story believing it was already done.
    const swift = read(SWIFT);
    expect(swift).not.toContain("attachments");
    expect(swift).not.toContain("/close");
  });
});
