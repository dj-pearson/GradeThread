import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  classifyError,
  friendlyError,
  isOffline,
  looksLikeOurCopy,
  rawDetail,
  type FriendlyErrorKind,
} from "@/lib/friendly-error";
import CASES from "./fixtures/friendly-error-cases.json";

// US-2869.
//
// THE DEFECT WAS REAL AND I CONFIRMED IT BEFORE BUILDING. 308 customer-facing
// toasts passed an error's `.message` straight through, 132 of them bare. And
// five customer-facing edge routes put a raw PostgREST or Supabase Storage
// message into the `{ error }` body those toasts print --
// flipdesk-consignment.ts, flipdesk-listings.ts, flipdesk-measure.ts (twice)
// and flipdesk-autolister.ts. That is the whole path the story describes, end
// to end.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("classification (US-2869)", () => {
  for (const c of CASES.cases) {
    if (!c.platforms.includes("web")) continue;
    for (const sample of c.samples) {
      it(`"${sample.slice(0, 42)}" is ${c.kind}`, () => {
        expect(classifyError(new Error(sample))).toBe(c.kind);
      });
    }
  }

  it("a SQLSTATE code beats whatever the message says", () => {
    // The case the story is named for. `column listings.x does not exist`
    // contains "not" and "exist" and would otherwise fall through to a
    // guess; the code is exact.
    for (const [code, kind] of Object.entries(CASES.pgCodes)) {
      if (code.startsWith("$")) continue;
      const err = Object.assign(new Error("column listings.x does not exist"), {
        code,
      });
      expect(classifyError(err), `SQLSTATE ${code}`).toBe(kind as FriendlyErrorKind);
    }
  });

  it("an unrecognised database error is never 'unknown'", () => {
    // 'unknown' is the ONLY kind that may promote a server string into the
    // headline, so a database must never land there.
    const err = Object.assign(new Error("column listings.x does not exist"), {
      code: "42703",
    });
    expect(classifyError(err)).toBe("server");
    const f = friendlyError(err);
    expect(f.title).not.toContain("listings.x");
    expect(f.title).not.toContain("42703");
    // But support still gets it.
    expect(f.detail).toContain("42703");
    expect(f.detail).toContain("column listings.x does not exist");
  });

  it("reads status codes off whatever field carries them", () => {
    expect(classifyError({ status: 429, message: "nope" })).toBe("rateLimited");
    expect(classifyError({ statusCode: 403, message: "nope" })).toBe("permission");
    expect(classifyError({ status: 503, message: "nope" })).toBe("server");
  });

  it("marketplace reconnect wins over the generic auth reading", () => {
    // It is a 401 or a 409 depending on which eBay call failed, and the
    // recovery is neither "sign in again" nor "upgrade" but a third page.
    expect(classifyError({ status: 401, message: "reconnect-required" })).toBe(
      "marketplaceReconnect",
    );
  });

  it("spots offline without a message to read", () => {
    expect(isOffline(new TypeError("Failed to fetch"))).toBe(true);
    expect(isOffline({ name: "AuthRetryableFetchError" })).toBe(true);
    expect(isOffline(new Error("Title is required"))).toBe(false);
  });

  it("survives the shapes that are not errors at all", () => {
    for (const junk of [null, undefined, "", 0, [], {}]) {
      expect(() => friendlyError(junk)).not.toThrow();
      expect(friendlyError(junk).kind).toBe("unknown");
    }
  });
});

describe("the three lines (US-2869 AC1)", () => {
  const KINDS: FriendlyErrorKind[] = [
    "offline", "sessionExpired", "emailUnverified", "invalidCredentials",
    "rateLimited", "planLimit", "marketplaceReconnect", "permission",
    "notFound", "validation", "conflict", "server", "unknown",
  ];

  it("every kind says what happened, what it means and what to do", () => {
    for (const kind of KINDS) {
      // Reach each kind through a sample that classifies to it.
      const f = friendlyError(
        kind === "unknown"
          ? new Error("???")
          : Object.assign(new Error("x"), { code: "", status: undefined }),
      );
      void f;
    }
    // Directly: assert the copy table, which is what actually matters.
    const seen = new Set<string>();
    for (const kind of KINDS) {
      const sample = SAMPLE_FOR[kind];
      const f = friendlyError(sample);
      expect(f.kind, `${kind} sample misclassifies`).toBe(kind);
      expect(f.title.length, `${kind} title`).toBeGreaterThan(5);
      expect(f.meaning.length, `${kind} meaning`).toBeGreaterThan(15);
      expect(f.action.length, `${kind} action`).toBeGreaterThan(10);
      // The action is an INSTRUCTION, not a description.
      expect(f.action.trim().endsWith("."), `${kind} action is not a sentence`).toBe(true);
      // No two kinds may share a title, or they are not distinct kinds.
      if (kind !== "unknown") {
        expect(seen.has(f.title), `${kind} repeats another kind's title`).toBe(false);
        seen.add(f.title);
      }
    }
  });

  it("the call site's own sentence survives an unclassifiable error", () => {
    // How 284 converted call sites keep the specific copy they already had
    // instead of all collapsing onto one generic line.
    const f = friendlyError(new Error("???"), "Bulk edit failed.");
    expect(f.title).toBe("Bulk edit failed.");
    expect(f.action.length).toBeGreaterThan(10);
  });

  it("a classified error ignores the fallback, because it knows better", () => {
    const f = friendlyError(new Error("Failed to fetch"), "Bulk edit failed.");
    expect(f.kind).toBe("offline");
    expect(f.title).not.toBe("Bulk edit failed.");
  });

  it("tells our own copy from a machine's", () => {
    expect(looksLikeOurCopy("Could not start generation.")).toBe(true);
    expect(looksLikeOurCopy("Your eBay connection expired.")).toBe(true);
    // Machine text, every one.
    expect(looksLikeOurCopy("column listings.x does not exist")).toBe(false);
    expect(looksLikeOurCopy("duplicate key value violates unique_constraint")).toBe(false);
    expect(looksLikeOurCopy('{"code":"PGRST301"}')).toBe(false);
    expect(looksLikeOurCopy("at Object.fetch (main.ts:12)")).toBe(false);
    expect(looksLikeOurCopy("short")).toBe(false);
    // These two ISOLATE the identifier rules. The lowercase samples above are
    // all caught by the starts-with-a-capital check first, so deleting the
    // table.column rule left them passing and the sabotage went unnoticed on
    // the first run of this guard.
    expect(looksLikeOurCopy("Update failed on listings.status column")).toBe(false);
    expect(looksLikeOurCopy("Constraint listings_sku_key was violated")).toBe(false);
  });

  it("rawDetail keeps the code, because that is what a ticket needs", () => {
    const err = Object.assign(new Error("boom"), { code: "23505", details: "Key (sku)=(A) exists." });
    const d = rawDetail(err);
    expect(d).toContain("boom");
    expect(d).toContain("23505");
    expect(d).toContain("Key (sku)=(A) exists.");
  });
});

/** One raw error per kind, used to walk the whole copy table. */
const SAMPLE_FOR: Record<FriendlyErrorKind, unknown> = {
  offline: new Error("Failed to fetch"),
  sessionExpired: new Error("JWT expired"),
  emailUnverified: new Error("Email not confirmed"),
  invalidCredentials: new Error("Invalid login credentials"),
  rateLimited: new Error("Too many requests"),
  planLimit: new Error("Upgrade your plan to continue."),
  marketplaceReconnect: new Error("reconnect-required"),
  permission: { status: 403, message: "no" },
  notFound: { status: 404, message: "no" },
  validation: { status: 400, message: "no" },
  conflict: { status: 409, message: "no" },
  server: { status: 500, message: "no" },
  unknown: new Error("???"),
};

// ---------------------------------------------------------------------------
// AC4: no toast may be handed an error's message directly.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "__tests__", "dist", "coverage"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) {
      out.push(relative(ROOT, p).replace(/\\/g, "/"));
    }
  }
  return out;
}

/**
 * Call sites where `.message` reaches a toast and SHOULD.
 *
 * Every entry is a lookup table of copy WE wrote that happens to use the field
 * name `message`, not an error. The codemod converted all three and was wrong
 * to: routing "Google sign-in cancelled." through the classifier replaces a
 * precise sentence with a generic one, which is the opposite of the point.
 *
 * `.message` is a SHAPE, not a meaning. This list is the difference.
 */
const NOT_AN_ERROR: Record<string, string> = {
  "src/pages/flipdesk/marketplaces-google.tsx":
    "CALLBACK_MESSAGES is a table of our own OAuth-callback copy keyed by a " +
    "query parameter. `entry.message` is the sentence we wrote for that case.",
  "src/pages/flipdesk/marketplaces.tsx": "The same CALLBACK_MESSAGES table.",
  "src/components/flipdesk/photo-uploader.tsx":
    "MacroQualityAssessment.message is a photo-quality NUDGE (US-2137), shown " +
    "after a SUCCESSFUL upload. There is no error here at all.",
  "src/components/flipdesk/measurement-photo-editor.tsx":
    "`json.message` is the measure endpoint's own explanation of why a pass " +
    "found nothing (US-2608), which is better than anything a classifier " +
    "could say about it.",
};

function rawMessageToasts(rel: string): number[] {
  const src = read(rel);
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (/^toast\.(error|warning)$/.test(callee) && node.arguments.length) {
        if (/\.message\b/.test(node.arguments[0]!.getText(sf))) {
          lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe("no toast prints what the server said (US-2869 AC4)", () => {
  const FILES = walk(resolve(ROOT, "src")).filter((f) => !f.startsWith("src/test/"));

  it("the scan found the codebase", () => {
    // Guards the guard: every count below goes to zero if the walk breaks,
    // and zero reads exactly like success.
    expect(FILES.length).toBeGreaterThan(400);
    expect(FILES.some((f) => f.includes("autolister"))).toBe(true);
  });

  it("no customer surface hands toast.error an error's message", () => {
    const offenders: string[] = [];
    for (const rel of FILES) {
      if (NOT_AN_ERROR[rel]) continue;
      // Operator surfaces are exempt: an admin WANTS the raw string, and
      // giving them "Something broke on our side" instead would be a
      // downgrade for the two people who can act on it.
      if (rel.includes("/admin/")) continue;
      for (const line of rawMessageToasts(rel)) {
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(
      offenders,
      `these print whatever the server said:\n  ${offenders.join("\n  ")}\n` +
        "Use toastError(err, \"your own fallback sentence\") from " +
        "@/lib/toast-error. If the thing is NOT an error -- a table of our " +
        "own copy that happens to have a `message` field -- add it to " +
        "NOT_AN_ERROR with the reason.",
    ).toEqual([]);
  });

  it("the exemptions still describe something true", () => {
    // The direction that rots: an excuse for a file that no longer does it.
    for (const [rel, why] of Object.entries(NOT_AN_ERROR)) {
      expect(
        rawMessageToasts(rel).length,
        `${rel} no longer passes a .message to a toast -- drop its ` +
          `exemption. It said: ${why}`,
      ).toBeGreaterThan(0);
    }
  });

  it("toastError is actually the thing being used", () => {
    // An empty offender list is also what "nobody calls toasts any more"
    // looks like.
    const users = FILES.filter((f) => read(f).includes("toastError("));
    expect(users.length, "toastError is imported nowhere").toBeGreaterThan(50);
  });
});

describe("the raw detail survives, and reaches Sentry (US-2869 AC3)", () => {
  const src = read("src/lib/toast-error.tsx");

  it("every toast reports", () => {
    expect(src).toContain("captureException");
    // Counting, not toContain: toastError and toastWarning must BOTH report,
    // and a single call would satisfy a toContain.
    expect((src.match(/captureException\(/g) ?? []).length).toBe(2);
  });

  it("the raw string goes to Sentry, not to the headline", () => {
    expect(src).toContain("raw_detail: f.detail");
    expect(src).toContain("friendly_kind: f.kind");
    expect(src).toContain("toast.error(f.title");
  });

  it("support can still get at it", () => {
    expect(src).toContain('label: "Details"');
    expect(src).toContain("clipboard.writeText");
  });
});

describe("the edge stopped sending raw database text (US-2869)", () => {
  // The five customer-facing routes that put a PostgREST or Storage message
  // into the body the browser prints. Fixing it HERE is better than hiding it
  // behind a disclosure there: the raw text never leaves the server.
  const ROUTES = [
    "services/edge-functions/src/routes/flipdesk-consignment.ts",
    "services/edge-functions/src/routes/flipdesk-listings.ts",
    "services/edge-functions/src/routes/flipdesk-measure.ts",
    "services/edge-functions/src/routes/flipdesk-autolister.ts",
  ];

  for (const rel of ROUTES) {
    it(`${rel.split("/").pop()} keeps the technical string in \`detail\``, () => {
      const src = read(rel);
      // The exact shapes that leaked, by their old spelling.
      for (const leak of [
        "error: insertErr?.message",
        "error: error.message.slice",
        "error: `Could not store the render: ${upErr.message}`",
        "error: `Render stored but row insert failed: ${insErr.message}`",
        "error: `Upload failed: ${upErr.message}`",
      ]) {
        expect(src.includes(leak), `${rel} leaks again: ${leak}`).toBe(false);
      }
    });
  }

  it("the human sentence and the technical one are separate fields", () => {
    const src = read("services/edge-functions/src/routes/flipdesk-measure.ts");
    expect(src).toContain('error: "Could not save the measurements photo."');
    expect(src).toContain("detail: upErr.message");
  });
});

// ---------------------------------------------------------------------------
// AC5: the shared fixture, checked against BOTH clients.
// ---------------------------------------------------------------------------

describe("web and iOS are checked against one list (US-2869 AC5)", () => {
  const swift = read("ios/GradeThread/Telemetry/FriendlyErrorCopy.swift");
  /** Strip comments: a source scan otherwise fires on the prose about it. */
  const swiftCode = swift
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("every case the web claims, the web handles", () => {
    for (const c of CASES.cases) {
      if (!c.platforms.includes("web")) continue;
      for (const sample of c.samples) {
        expect(classifyError(new Error(sample)), `${c.kind}: "${sample}"`).toBe(
          c.kind,
        );
      }
    }
  });

  it("every case the fixture says iOS has, iOS has", () => {
    // Parsed from the Swift SOURCE, not compiled: Swift cannot be built on
    // this box, and reading an enum's cases needs no compiler.
    for (const c of CASES.cases) {
      if (!c.platforms.includes("ios")) continue;
      expect(c.ios, `${c.kind} claims iOS but names no Kind`).toBeTruthy();
      expect(
        new RegExp(`case ${c.ios}\\b`).test(swiftCode),
        `FriendlyErrorCopy has no case ${c.ios}, which the fixture says it does`,
      ).toBe(true);
    }
    for (const c of CASES.iosOnly) {
      expect(
        new RegExp(`case ${c.kind}\\b`).test(swiftCode),
        `FriendlyErrorCopy has no case ${c.kind}`,
      ).toBe(true);
    }
  });

  it("the asymmetry is written down rather than implied", () => {
    // Each case only one client covers has to say WHY. Without this the
    // fixture reads as a to-do list somebody will silently "finish" by
    // deleting rows.
    for (const c of CASES.cases) {
      if (c.platforms.length === 2) continue;
      const why = (c as { $why?: string }).$why;
      expect(why, `${c.kind} is web-only and does not say why`).toBeTruthy();
      expect(why!.length).toBeGreaterThan(30);
    }
    for (const c of CASES.iosOnly) {
      expect(c.$why, `${c.kind} is iOS-only and does not say why`).toBeTruthy();
    }
  });

  it("the fixture is not empty and covers every web kind", () => {
    const webKinds = new Set(
      CASES.cases.filter((c) => c.platforms.includes("web")).map((c) => c.kind),
    );
    for (const kind of Object.keys(SAMPLE_FOR)) {
      expect(webKinds.has(kind), `${kind} is not in the shared fixture`).toBe(true);
    }
  });
});
