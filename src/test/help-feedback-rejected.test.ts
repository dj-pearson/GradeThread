import { afterEach, describe, expect, it, vi } from "vitest";

// US-3384. functions/help/feedback.ts forwarded the vote with a bare
// `await fetch(...)` and threw the Response away. A 401 from a rotated
// CF_PAGES_ORIGIN_SECRET, a 429 from the public limiter or a 500 from the edge
// produced no log anywhere, and the reader was 303'd to `?thanks=1` and thanked
// for feedback the edge had just rejected.
//
// The specifier is assembled at runtime because the module declares a
// PagesFunction handler, a Workers global tsconfig.app.json does not load: a
// literal import would break `tsc -b` for all of src/. Do not "tidy" it.
const loadFeedback = () =>
  import(/* @vite-ignore */ "../../functions/help/" + "feedback") as Promise<{
    onRequestPost: (context: unknown) => Promise<Response>;
  }>;

const env = {
  PUBLIC_SITE_URL: "https://gradethread.com",
  EDGE_API_URL: "https://functions.example.invalid",
};

function vote(fields: Record<string, string>): Request {
  return new Request("https://gradethread.com/help/feedback", {
    method: "POST",
    body: new URLSearchParams(fields),
  });
}

async function post(upstream: () => Promise<Response>): Promise<Response> {
  vi.stubGlobal("fetch", vi.fn(upstream));
  const { onRequestPost } = await loadFeedback();
  return await onRequestPost({
    request: vote({
      slug: "the-photos-we-need",
      category: "grading",
      helpful: "yes",
      comment: "clear",
    }),
    env,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the no-JS feedback form only thanks a reader whose vote landed", () => {
  it("thanks them when the edge accepted it", async () => {
    const res = await post(async () => new Response("{}", { status: 200 }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://gradethread.com/help/grading/the-photos-we-need?thanks=1",
    );
  });

  for (const status of [401, 429, 500]) {
    it(`does not thank them, and logs the status, on a ${status}`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await post(async () => new Response("no", { status }));
      // Still a 303 back to the article: an error page on somebody who was only
      // trying to be helpful is the worse outcome, and that part does not change.
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        "https://gradethread.com/help/grading/the-photos-we-need",
      );
      expect(res.headers.get("location")).not.toContain("thanks");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(String(status));
    });
  }

  it("does not thank them when the forward throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(() => Promise.reject(new Error("socket hang up")));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).not.toContain("thanks");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("still refuses a malformed vote without calling the edge at all", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { onRequestPost } = await loadFeedback();
    const res = await onRequestPost({
      request: vote({ slug: "../admin", category: "grading", helpful: "maybe" }),
      env,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://gradethread.com/help");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
