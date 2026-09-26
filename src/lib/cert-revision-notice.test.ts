import { describe, expect, it } from "vitest";
import { certRevisionHeading, parseCertRevision } from "./cert-revision-notice";

describe("US-3540 cert revision notice", () => {
  it("reads a withdrawn certificate", () => {
    const n = parseCertRevision({
      revised: true,
      status: "revoked",
      message: "This certificate was withdrawn on 2026-09-26.",
      current_certificate_id: null,
    });
    expect(n?.status).toBe("revoked");
    expect(certRevisionHeading(n!.status)).toBe("This certificate was withdrawn");
  });

  it("reads a replaced certificate with its successor", () => {
    const n = parseCertRevision({
      revised: true,
      status: "revised",
      message: "Replaced.",
      current_certificate_id: "abc",
      current_certificate_number: "GT-1",
    });
    expect(n).toEqual({
      status: "revised",
      message: "Replaced.",
      currentCertificateId: "abc",
      currentCertificateNumber: "GT-1",
    });
  });

  it("ignores a plain not-found body", () => {
    expect(parseCertRevision({ error: "Not found" })).toBeNull();
    expect(parseCertRevision(null)).toBeNull();
  });
});
