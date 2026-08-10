import { describe, expect, it } from "vitest";
import { errorMessage, UNREACHABLE_MESSAGE } from "@/lib/utils";
import { AUTH_NETWORK_ERROR_MESSAGE } from "@/lib/auth-error";

// errorMessage() is what the composer's toasts render, so it is the one place
// that decides what a seller reads when a save fails. Two things must hold: it
// stays useful for real, actionable failures, and it never publishes our
// infrastructure — a host, a URL, or a stack trace — to the screen.

describe("errorMessage — transport failures", () => {
  it("collapses a browser fetch rejection to one actionable sentence", () => {
    expect(errorMessage(new TypeError("Failed to fetch"))).toBe(
      UNREACHABLE_MESSAGE,
    );
    // Safari and Firefox word the same failure differently.
    expect(errorMessage({ message: "Load failed" })).toBe(UNREACHABLE_MESSAGE);
    expect(
      errorMessage({ message: "NetworkError when attempting to fetch resource." }),
    ).toBe(UNREACHABLE_MESSAGE);
  });

  it("handles the supabase-js shape, where the TypeError is already gone", () => {
    // What postgrest-js actually resolves with when a request never lands: a
    // plain object, message re-stringified, details set to the whole stack.
    const postgrestNetworkError = {
      message: "TypeError: Failed to fetch",
      details:
        "TypeError: Failed to fetch\n    at https://gradethread.com/assets/index-a1b2c3.js:14:9182",
      hint: "",
      code: "",
    };
    expect(errorMessage(postgrestNetworkError)).toBe(UNREACHABLE_MESSAGE);
  });

  it("treats a gateway status as unreachable, not as a real answer", () => {
    // A busy edge behind its proxy answers 502/503/504 with the proxy's own
    // page, which is where the hostname used to come from.
    for (const status of [0, 502, 503, 504]) {
      expect(errorMessage({ status, message: "Bad Gateway" })).toBe(
        UNREACHABLE_MESSAGE,
      );
    }
  });

  it("keeps one sentence for the whole app", () => {
    // Two constants, one wording — see the comment on UNREACHABLE_MESSAGE.
    expect(UNREACHABLE_MESSAGE).toBe(AUTH_NETWORK_ERROR_MESSAGE);
  });
});

describe("errorMessage — nothing internal reaches the screen", () => {
  it("strips an internal hostname out of any message", () => {
    const message = errorMessage(
      new Error("Could not connect to functions.gradethread.com:443"),
    );
    expect(message).not.toContain("gradethread.com");
    expect(message).not.toContain("443");
  });

  it("strips an absolute URL out of any message", () => {
    const message = errorMessage(
      new Error("POST https://functions.gradethread.com/api/flipdesk/x failed"),
    );
    expect(message).not.toContain("http");
    expect(message).not.toContain("gradethread.com");
    // The part that tells the seller what happened survives.
    expect(message).toContain("failed");
  });

  it("drops a stack trace instead of pasting it into a toast", () => {
    const withStack = {
      message: "insert or update violates foreign key constraint",
      details:
        "Error: boom\n    at save (https://gradethread.com/assets/index-a1b2c3.js:14:9182)",
      hint: "",
      code: "23503",
    };
    const message = errorMessage(withStack);
    expect(message).toContain("foreign key constraint");
    expect(message).toContain("23503");
    expect(message).not.toContain("at save");
    expect(message).not.toContain("gradethread.com");
  });

  it("never falls back to a raw dump of an unreadable object", () => {
    // A JSON dump used to go out here, carrying whatever fields the thrower had.
    const message = errorMessage({
      requestUrl: "https://functions.gradethread.com/api/flipdesk/listings",
      internalId: "srv-7f3a",
    });
    expect(message).not.toContain("gradethread.com");
    expect(message).not.toContain("srv-7f3a");
    expect(message).toBe("Something went wrong. Please try again.");
  });
});

describe("errorMessage — real failures stay readable", () => {
  it("keeps a PostgrestError's message, details, hint and SQLSTATE", () => {
    expect(
      errorMessage({
        message: "duplicate key value violates unique constraint",
        details: "Key (sku)=(ABC-1) already exists.",
        hint: "Use a different SKU.",
        code: "23505",
      }),
    ).toBe(
      "duplicate key value violates unique constraint — Key (sku)=(ABC-1) already exists. — Use a different SKU. (23505)",
    );
  });

  it("passes plain validation copy straight through", () => {
    expect(errorMessage(new Error("Title is required."))).toBe(
      "Title is required.",
    );
    expect(errorMessage("Set a price above $0.")).toBe("Set a price above $0.");
  });

  it("still answers for null and undefined", () => {
    expect(errorMessage(null)).toBe("Unknown error");
    expect(errorMessage(undefined)).toBe("Unknown error");
  });
});
