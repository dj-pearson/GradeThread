import { describe, expect, it } from "vitest";
import {
  type CaptureFetch,
  type CaptureFetchResponse,
  CAPTURE_POLL_MS,
  endCapture,
  missingSentence,
  photoTypeLabel,
  sendCapturePhotoWithRetry,
  readCapturePublic,
  sendCapturePhoto,
  startCapture,
  timeLeft,
} from "@/lib/phone-capture-client";

// US-3161. The phone half is the interesting half: it is not signed in, it is
// on a phone connection, and the person holding it cannot debug anything.

function res(body: unknown, ok = true, status = 200): CaptureFetchResponse {
  return { ok, status, json: () => Promise.resolve(body) };
}

function fetcher(queue: CaptureFetchResponse[]): {
  f: CaptureFetch;
  calls: { path: string; init?: { method?: string; unauthenticated?: boolean; json?: unknown } }[];
} {
  const calls: { path: string; init?: { method?: string; unauthenticated?: boolean; json?: unknown } }[] = [];
  const f: CaptureFetch = (path, init) => {
    calls.push({ path, init });
    return Promise.resolve(queue.shift() ?? res({}, false, 500));
  };
  return { f, calls };
}

describe("phone capture (US-3161)", () => {
  it("starting a capture names the target and gets back a url to put in the code", async () => {
    const { f, calls } = fetcher([
      res({ sessionId: "s1", url: "https://gradethread.com/capture/tok", expiresAt: "x", maxPhotos: 40 }),
    ]);
    const started = await startCapture(f, "item", "item-1");
    expect(started.url).toContain("/capture/");
    expect(calls[0]?.init?.json).toEqual({ targetKind: "item", targetId: "item-1" });
  });

  it("a refused start carries the server's own sentence", async () => {
    const { f } = fetcher([res({ error: "That item could not be found." }, false, 404)]);
    await expect(startCapture(f, "item", "someone-elses")).rejects.toThrow(
      "That item could not be found.",
    );
  });

  it("the phone reads its session without a login, and a dead code is not an exception", async () => {
    const { f, calls } = fetcher([
      res({ live: true, photosTaken: 0, photosLeft: 40, expiresAt: "x", targetKind: "item" }),
    ]);
    const ok = await readCapturePublic(f, "tok");
    expect(ok.ok).toBe(true);
    // No Authorization header is possible here — the phone has no session.
    expect(calls[0]?.init?.unauthenticated).toBe(true);

    const { f: f2 } = fetcher([
      res({ error: "This code has expired. Scan a new one." }, false, 410),
    ]);
    const dead = await readCapturePublic(f2, "tok");
    expect(dead).toEqual({ ok: false, reason: "This code has expired. Scan a new one." });
  });

  it("a finished or full code ends the page rather than inviting a retry", async () => {
    for (const status of [404, 410, 429]) {
      const { f } = fetcher([res({ error: "no" }, false, status)]);
      const sent = await sendCapturePhoto(f, "tok", new File([""], "a.jpg"), "k1");
      expect(sent.gone, `status ${status} should end the page`).toBe(true);
      expect(sent.ok).toBe(false);
    }
  });

  it("an ordinary failure is worth retrying and does not end the page", async () => {
    const { f } = fetcher([res({ error: "That photo could not be saved. Try it again." }, false, 502)]);
    const sent = await sendCapturePhoto(f, "tok", new File([""], "a.jpg"), "k1");
    expect(sent.gone).toBe(false);
    expect(sent.error).toBe("That photo could not be saved. Try it again.");
  });

  it("a retry of a photo that already landed is reported as a duplicate, not a second photo", async () => {
    const { f } = fetcher([res({ ok: true, duplicate: true, url: "u" })]);
    const sent = await sendCapturePhoto(f, "tok", new File([""], "a.jpg"), "same-key");
    expect(sent.ok).toBe(true);
    expect(sent.duplicate).toBe(true);
  });

  it("a sent photo carries the client key, which is what makes the retry safe", async () => {
    const { f, calls } = fetcher([res({ ok: true, photosTaken: 1, photosLeft: 39 })]);
    await sendCapturePhoto(f, "tok", new File(["x"], "a.jpg"), "key-42");
    const body = calls[0]?.init as unknown as { body?: FormData };
    expect(body?.body?.get("clientKey")).toBe("key-42");
    expect(body?.body?.get("photo")).toBeInstanceOf(File);
  });

  it("the token is url-encoded on the way out", async () => {
    const { f, calls } = fetcher([res({ live: true })]);
    await readCapturePublic(f, "a/b c");
    expect(calls[0]?.path).toContain(encodeURIComponent("a/b c"));
    expect(calls[0]?.path).not.toContain("a/b c");
  });

  it("ending a capture does not care what the server says back", async () => {
    const { f, calls } = fetcher([res({}, false, 500)]);
    await expect(endCapture(f, "s1")).resolves.toBeUndefined();
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("the countdown stops at zero rather than going negative", () => {
    const now = Date.parse("2026-09-08T12:00:00Z");
    expect(timeLeft("2026-09-08T12:05:07Z", now)).toBe("5:07");
    expect(timeLeft("2026-09-08T12:00:09Z", now)).toBe("0:09");
    expect(timeLeft("2026-09-08T12:00:00Z", now)).toBeNull();
    expect(timeLeft("2026-09-08T11:59:00Z", now)).toBeNull();
    expect(timeLeft("not a date", now)).toBeNull();
  });

  // ── US-3162 ──────────────────────────────────────────────────────

  it("the desktop poll is fast enough to meet the five-second promise", () => {
    // AC1: a photo finished on the phone appears on the desktop within five
    // seconds with no manual refresh. The poll is the whole mechanism.
    expect(CAPTURE_POLL_MS).toBeLessThanOrEqual(5000);
    expect(CAPTURE_POLL_MS).toBeGreaterThanOrEqual(1000);
  });

  it("the retry sends the SAME key, which is what stops a double count", async () => {
    const { f, calls } = fetcher([
      res({ error: "hiccup" }, false, 502),
      res({ ok: true, photosTaken: 1, missingTypes: ["back"] }),
    ]);
    const sent = await sendCapturePhotoWithRetry(f, "tok", new File(["x"], "a.jpg"), "key-9");
    expect(sent.ok).toBe(true);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const init = c.init as unknown as { body?: FormData };
      expect(init.body?.get("clientKey")).toBe("key-9");
    }
  });

  it("a gone result is never retried, because the answer will not change", async () => {
    const { f, calls } = fetcher([res({ error: "This code has expired." }, false, 410)]);
    const sent = await sendCapturePhotoWithRetry(f, "tok", new File(["x"], "a.jpg"), "k");
    expect(sent.gone).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("the retry happens once, not until it works", async () => {
    const { f, calls } = fetcher([
      res({ error: "hiccup" }, false, 502),
      res({ error: "hiccup" }, false, 502),
      res({ ok: true }),
    ]);
    const sent = await sendCapturePhotoWithRetry(f, "tok", new File(["x"], "a.jpg"), "k");
    expect(sent.ok).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("an upload carries the refreshed missing list, so the prompt keeps up", async () => {
    const { f } = fetcher([res({ ok: true, photosTaken: 2, missingTypes: ["tag"] })]);
    const sent = await sendCapturePhoto(f, "tok", new File(["x"], "a.jpg"), "k");
    expect(sent.missingTypes).toEqual(["tag"]);
    // A server that said nothing must not be read as "nothing is missing".
    const { f: f2 } = fetcher([res({ ok: true, photosTaken: 2 })]);
    expect((await sendCapturePhoto(f2, "tok", new File(["x"], "a.jpg"), "k")).missingTypes).toBeNull();
  });

  it("the missing shots read as a sentence a person would say", () => {
    expect(missingSentence([])).toBeNull();
    expect(missingSentence(["front"])).toBe("Still need the front shot.");
    expect(missingSentence(["front", "back"])).toBe("Still need the front and back shots.");
    expect(missingSentence(["front", "back", "tag"])).toBe(
      "Still need the front, back and tag shots.",
    );
    // An unknown type is printed readably rather than dropped, so a new photo
    // type added elsewhere cannot silently vanish from the prompt.
    expect(photoTypeLabel("tag_2")).toBe("second tag");
    expect(photoTypeLabel("some_new_type")).toBe("some new type");
  });
});
