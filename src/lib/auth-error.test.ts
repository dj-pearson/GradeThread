import { describe, it, expect } from "vitest";
import { classifyAuthFailure } from "@/lib/auth-error";

// US-1432: a rate-limit or network failure must not read as a credential error.
describe("classifyAuthFailure", () => {
  it("classifies GoTrue 429 (status or code) as rate_limit", () => {
    expect(classifyAuthFailure({ status: 429, message: "Too many requests" })).toBe(
      "rate_limit",
    );
    expect(
      classifyAuthFailure({ status: 400, code: "over_request_rate_limit" }),
    ).toBe("rate_limit");
    expect(
      classifyAuthFailure({ status: 429, code: "over_email_send_rate_limit" }),
    ).toBe("rate_limit");
  });

  it("classifies transport failures as network", () => {
    expect(classifyAuthFailure(new TypeError("Failed to fetch"))).toBe("network");
    expect(
      classifyAuthFailure({ name: "AuthRetryableFetchError", status: 0 }),
    ).toBe("network");
    expect(classifyAuthFailure({ status: 503, message: "Service Unavailable" })).toBe(
      "network",
    );
    expect(classifyAuthFailure({ message: "NetworkError when attempting to fetch" })).toBe(
      "network",
    );
    expect(classifyAuthFailure({ message: "request timed out" })).toBe("network");
  });

  it("classifies genuine 400/401 auth failures as credentials", () => {
    expect(
      classifyAuthFailure({ status: 400, code: "invalid_credentials", message: "Invalid login credentials" }),
    ).toBe("credentials");
    expect(classifyAuthFailure({ status: 401, message: "Unauthorized" })).toBe(
      "credentials",
    );
  });

  it("rate_limit takes precedence over a 4xx status", () => {
    // A 429 must win even though it is a 4xx, so it never reads as credentials.
    expect(classifyAuthFailure({ status: 429 })).toBe("rate_limit");
  });

  it("defaults unknown/empty errors to credentials (never a false network/rate-limit)", () => {
    expect(classifyAuthFailure(null)).toBe("credentials");
    expect(classifyAuthFailure(undefined)).toBe("credentials");
    expect(classifyAuthFailure({})).toBe("credentials");
    expect(classifyAuthFailure(new Error("something odd"))).toBe("credentials");
  });
});
