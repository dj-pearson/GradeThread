import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the supabase MFA client. Each test rewires `challenge`/`verify` behavior.
// vi.hoisted so the fns exist when the hoisted vi.mock factory runs.
const { challenge, verify } = vi.hoisted(() => ({
  challenge: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { mfa: { challenge, verify } } },
}));

import { challengeAndVerifyTotp, isMfaIpMismatch } from "@/lib/mfa";

const ipMismatch = { code: "mfa_ip_address_mismatch", status: 422, message: "Challenge and verify IP addresses mismatch." };

beforeEach(() => {
  challenge.mockReset();
  verify.mockReset();
  challenge.mockResolvedValue({ data: { id: "ch1" }, error: null });
});

afterEach(() => vi.restoreAllMocks());

describe("isMfaIpMismatch", () => {
  it("matches by GoTrue error code", () => {
    expect(isMfaIpMismatch({ code: "mfa_ip_address_mismatch" })).toBe(true);
  });
  it("matches by 422 + message when code is absent", () => {
    expect(isMfaIpMismatch({ status: 422, message: "IP addresses mismatch" })).toBe(true);
  });
  it("ignores unrelated errors", () => {
    expect(isMfaIpMismatch({ code: "invalid_code", status: 422 })).toBe(false);
    expect(isMfaIpMismatch(null)).toBe(false);
    expect(isMfaIpMismatch("nope")).toBe(false);
  });
});

describe("challengeAndVerifyTotp", () => {
  it("resolves on first success", async () => {
    verify.mockResolvedValueOnce({ error: null });
    await expect(challengeAndVerifyTotp("f1", " 123456 ")).resolves.toBeUndefined();
    expect(challenge).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith({ factorId: "f1", challengeId: "ch1", code: "123456" });
  });

  it("retries the whole unit on IP mismatch, then succeeds", async () => {
    verify
      .mockResolvedValueOnce({ error: ipMismatch })
      .mockResolvedValueOnce({ error: ipMismatch })
      .mockResolvedValueOnce({ error: null });
    await expect(challengeAndVerifyTotp("f1", "123456", { retries: 3 })).resolves.toBeUndefined();
    // A fresh challenge is minted for every attempt (re-stamps the IP).
    expect(challenge).toHaveBeenCalledTimes(3);
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a wrong code — surfaces it immediately", async () => {
    const wrong = { code: "invalid_code", status: 422, message: "Invalid TOTP code entered" };
    verify.mockResolvedValueOnce({ error: wrong });
    await expect(challengeAndVerifyTotp("f1", "000000")).rejects.toBe(wrong);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("throws a friendly message after exhausting retries on persistent mismatch", async () => {
    verify.mockResolvedValue({ error: ipMismatch });
    await expect(challengeAndVerifyTotp("f1", "123456", { retries: 2 })).rejects.toThrow(
      /changed IP address/i,
    );
    expect(verify).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("surfaces a challenge-creation error without retrying", async () => {
    const chErr = new Error("factor expired");
    challenge.mockResolvedValueOnce({ data: null, error: chErr });
    await expect(challengeAndVerifyTotp("f1", "123456")).rejects.toBe(chErr);
    expect(verify).not.toHaveBeenCalled();
  });
});
