// US-1700: client ad click-id capture — query → first-party storage,
// normalization, and the persisted flag.
import { beforeEach, describe, expect, it } from "vitest";
import {
  captureClickIds,
  getStoredAttribution,
  markAttributionPersisted,
  normalizeClickId,
} from "@/lib/ad-attribution";

beforeEach(() => localStorage.clear());

describe("normalizeClickId", () => {
  it("trims and length-bounds", () => {
    expect(normalizeClickId("  abc ")).toBe("abc");
    expect(normalizeClickId("")).toBeNull();
    expect(normalizeClickId(null)).toBeNull();
    expect(normalizeClickId("x".repeat(513))).toBeNull();
  });
});

describe("captureClickIds", () => {
  it("captures gclid → google_ads and stores it unpersisted", () => {
    const a = captureClickIds("?gclid=Cj0abc&utm_source=google", "2026-07-07T00:00:00.000Z");
    expect(a).not.toBeNull();
    expect(a?.clickId).toBe("Cj0abc");
    expect(a?.clickIdType).toBe("gclid");
    expect(a?.platform).toBe("google_ads");
    expect(a?.persisted).toBe(false);
    expect(a?.landingAt).toBe("2026-07-07T00:00:00.000Z");
    // persisted to storage
    expect(getStoredAttribution()?.clickId).toBe("Cj0abc");
  });

  it("captures gbraid and wbraid too", () => {
    expect(captureClickIds("?gbraid=GB1")?.clickIdType).toBe("gbraid");
    localStorage.clear();
    expect(captureClickIds("?wbraid=WB1")?.clickIdType).toBe("wbraid");
  });

  it("returns the existing stored attribution when no click id is present", () => {
    captureClickIds("?gclid=first");
    const a = captureClickIds("?foo=bar");
    expect(a?.clickId).toBe("first");
  });

  it("returns null when nothing is stored and no click id is present", () => {
    expect(captureClickIds("?foo=bar")).toBeNull();
  });

  it("a fresh click id replaces the stored one and resets persisted", () => {
    captureClickIds("?gclid=old");
    markAttributionPersisted();
    expect(getStoredAttribution()?.persisted).toBe(true);
    const a = captureClickIds("?gclid=new");
    expect(a?.clickId).toBe("new");
    expect(a?.persisted).toBe(false);
  });
});

describe("markAttributionPersisted", () => {
  it("flips the stored persisted flag", () => {
    captureClickIds("?gclid=abc");
    expect(getStoredAttribution()?.persisted).toBe(false);
    markAttributionPersisted();
    expect(getStoredAttribution()?.persisted).toBe(true);
  });
});
