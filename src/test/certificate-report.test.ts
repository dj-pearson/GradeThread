import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CERTIFICATE_REPORT_REASONS,
  CERTIFICATE_REPORT_NOTE_MAX,
} from "@/lib/certificate-report";

// US-2550. "Integrity check failed — do not trust this certificate" is the worst
// news the product can give somebody, and it used to end there: no report, no
// contact, nothing. The unsigned state said "contact support" without a link.

const CERT_PAGE = "src/pages/certificate.tsx";
const DIALOG = "src/components/certificate/report-certificate-dialog.tsx";
const ADMIN = "src/pages/admin/moderation.tsx";
const EDGE_QUEUE = "services/edge-functions/src/lib/moderation-queue.ts";
const EDGE_PUBLIC = "services/edge-functions/src/routes/content-public.ts";
const EDGE_ADMIN = "services/edge-functions/src/routes/admin-moderation.ts";
const MIGRATION = "supabase/migrations/00599_moderation_certificate_reports.sql";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("a failed certificate leads somewhere (US-2550 AC1, AC2)", () => {
  const src = read(CERT_PAGE);

  it("the mismatch state offers a report and a human", () => {
    // The block that tells a buyer not to trust the certificate.
    const start = src.indexOf("Integrity check failed");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 1600);
    expect(block).toContain("<ReportCertificateDialog");
    expect(block).toContain("mailto:support@gradethread.com");
  });

  it("the unsigned state stopped saying 'contact support' with nothing to click", () => {
    const start = src.indexOf("Integrity could not be confirmed");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 1600);
    expect(block).toContain("<ReportCertificateDialog");
    expect(block).toContain("mailto:support@gradethread.com");
    // The old copy told them to do something the page did not let them do.
    expect(src).not.toContain("Contact support before relying on");
  });

  it("the report is filed against the certificate the buyer is holding", () => {
    expect(src).toContain("certificateId={certificateId}");
    expect(src).toMatch(/certificateId=\{id \?\? ""\}/);
    const dialog = read(DIALOG);
    expect(dialog).toContain(
      "/api/content/public/certificates/${encodeURIComponent(certificateId)}/report",
    );
  });

  it("the report needs no account, and stores nothing about the reporter", () => {
    const dialog = read(DIALOG);
    // No auth header, no session read: a buyer on a marketplace has no account
    // and will not make one to complain about us.
    expect(dialog).not.toContain("edgeFetch");
    expect(dialog).not.toContain("useAuthStore");
    const route = read(EDGE_PUBLIC);
    const start = route.indexOf('contentPublicRoutes.post("/certificates/:id/report"');
    expect(start).toBeGreaterThan(-1);
    const block = route.slice(start, start + 2600);
    expect(block).toContain("flaggedBy: null");
    // The owner is resolved from the id, never taken from the body.
    expect(block).toContain("resolveCertificateOwner(certId)");
    expect(block).not.toMatch(/body\.(owner|ownerUserId|owner_user_id)/);
  });

  it("a failure is reported, not swallowed into a cheerful lie", () => {
    const dialog = read(DIALOG);
    expect(dialog).toContain("toast.error");
    expect(dialog).toMatch(/if \(!res\.ok\) throw/);
  });
});

describe("the report reaches operators (US-2550 AC3)", () => {
  it("it lands in the queue the console already drains", () => {
    const route = read(EDGE_PUBLIC);
    expect(route).toContain('contentType: "certificate"');
    expect(route).toContain('source: "user_report"');
    expect(route).toContain("enqueueModerationFlag");
  });

  it("the admin console has somewhere to see it", () => {
    const admin = read(ADMIN);
    expect(admin).toContain('<TabsTrigger value="certificates">');
    expect(admin).toContain("<CertificatesTab />");
    expect(admin).toContain("/api/admin/moderation/certificates");
    const edge = read(EDGE_ADMIN);
    expect(edge).toContain('adminModerationRoutes.get("/certificates"');
  });

  it("the operator's action is reversible, and the destructive half steps up", () => {
    const edge = read(EDGE_ADMIN);
    const withhold = edge.slice(edge.indexOf('"/certificates/:id/withhold"'));
    expect(withhold.slice(0, 900)).toContain("requireStepUp(c)");
    // Withhold writes the SAME state US-484 already uses to hide a certificate,
    // and restore is its exact inverse. Two ways to hide a cert would be two
    // answers to one question.
    expect(edge).toContain('{ flagged: true, moderation_status: "flagged" }');
    expect(edge).toContain('{ flagged: false, moderation_status: "approved" }');
    expect(edge).toContain('action: "admin.moderation_certificate_withhold"');
    expect(edge).toContain('action: "admin.moderation_certificate_restore"');
  });

  it("repeat reports count instead of overwriting one another", () => {
    // The queue keeps ONE open flag per certificate, so five reporters have to
    // read as five, not as the last one to arrive.
    const queue = read(EDGE_QUEUE);
    expect(queue).toContain("composeCertificateReportReason");
    const route = read(EDGE_PUBLIC);
    expect(route).toContain('.eq("content_type", "certificate")');
    expect(route).toContain('.eq("status", "open")');
  });
});

describe("the client and the server agree on what can be reported", () => {
  it("the reason vocabularies are identical, key for key", () => {
    // A reason the client offers and the server rejects is a report button that
    // silently does nothing. Compared, not restated.
    const queue = read(EDGE_QUEUE);
    const serverBlock = queue.slice(
      queue.indexOf("export const CERTIFICATE_REPORT_REASONS"),
      queue.indexOf("} as const;", queue.indexOf("export const CERTIFICATE_REPORT_REASONS")),
    );
    for (const [key, label] of Object.entries(CERTIFICATE_REPORT_REASONS)) {
      expect(serverBlock, `server is missing ${key}`).toContain(`${key}: "${label}"`);
    }
    const serverKeys = [...serverBlock.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(serverKeys.sort()).toEqual(Object.keys(CERTIFICATE_REPORT_REASONS).sort());
  });

  it("the note cap is the same on both sides", () => {
    expect(CERTIFICATE_REPORT_NOTE_MAX).toBe(500);
    expect(read(EDGE_QUEUE)).toContain("export const CERTIFICATE_REPORT_NOTE_MAX = 500;");
    // The client caps the textarea; the server does not trust that.
    expect(read(DIALOG)).toContain("maxLength={CERTIFICATE_REPORT_NOTE_MAX}");
  });

  it("a reason is validated by ownership, not by the prototype chain", () => {
    // `in` walks the prototype, so "toString" and "constructor" were accepted as
    // reasons and stringified a FUNCTION into the operator queue.
    const queue = read(EDGE_QUEUE);
    expect(queue).toContain("Object.hasOwn(CERTIFICATE_REPORT_REASONS, v)");
    expect(queue).not.toMatch(/v in CERTIFICATE_REPORT_REASONS/);
  });
});

describe("the seller attribution already linked to the profile (US-2550 AC4)", () => {
  it("is built, and stays built", () => {
    // ALREADY DONE by US-1912/US-1913 — recorded here rather than re-implemented.
    // The link only renders when a verified profile exists, which is the "where
    // one exists" the criterion asks for.
    const src = read(CERT_PAGE);
    expect(src).toContain("to={`/verified/${sellerIntegrity.handle}`}");
    expect(src).toContain("See this seller");
    expect(src).toMatch(/\{sellerIntegrity && \(/);
  });
});

describe("the migration follows the US-1108 triple", () => {
  it("is idempotent and self-recording", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("add value if not exists 'certificate'");
    expect(sql).toContain(
      "insert into public.applied_migrations (version) values ('00599')",
    );
  });

  it("the edge expects at least this schema", () => {
    const ver = read("services/edge-functions/src/lib/schema-version.ts");
    const found = /EXPECTED_SCHEMA_VERSION = "(\d+)"/.exec(ver)?.[1];
    expect(Number(found)).toBeGreaterThanOrEqual(599);
  });
});
