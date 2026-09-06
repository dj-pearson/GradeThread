import { describe, it, expect, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SEO } from "./seo";

// React 19 requires this flag for act() to flush effects in a test env.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// No @testing-library in this repo — render into jsdom the way the app does
// (createRoot) and read the resulting document <head>.
//
// US-3120: <SEO> used to go through react-helmet-async, which batched its head
// writes via rAF; the macrotask flush below was for that. It writes the tags in
// a useEffect now, so act() alone is enough — the flush stays because the
// JSON-LD effect has always needed it and removing it proves nothing.

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderSEO(props: Parameters<typeof SEO>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(h(SEO, props));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.head.querySelectorAll("script[type='application/ld+json']").forEach(
    (n) => n.remove(),
  );
});

function meta(selector: string): string | null {
  return document.head.querySelector(selector)?.getAttribute("content") ?? null;
}

describe("<SEO> component (US-301)", () => {
  it("emits index,follow + canonical + default og:image by default", async () => {
    await renderSEO({ title: "Pricing", canonicalUrl: "https://gradethread.com/pricing" });
    expect(document.title).toContain("Pricing | GradeThread");
    expect(meta("meta[name='robots']")).toBe(
      "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
    );
    expect(
      document.head.querySelector("link[rel='canonical']")?.getAttribute("href"),
    ).toBe("https://gradethread.com/pricing");
    expect(meta("meta[property='og:image']")).toMatch(/^https:\/\//);
    expect(meta("meta[name='twitter:card']")).toBe("summary_large_image");
  });

  it("US-426: strips a trailing slash from the auto-derived canonical", async () => {
    window.history.pushState({}, "", "/pricing/");
    await renderSEO({ title: "Pricing" });
    expect(
      document.head.querySelector("link[rel='canonical']")?.getAttribute("href"),
    ).toBe("https://gradethread.com/pricing");
    window.history.pushState({}, "", "/");
  });

  it("US-426: keeps the root canonical as a single slash", async () => {
    window.history.pushState({}, "", "/");
    await renderSEO({ title: "Home" });
    expect(
      document.head.querySelector("link[rel='canonical']")?.getAttribute("href"),
    ).toBe("https://gradethread.com/");
  });

  it("emits noindex,nofollow when noindex is set", async () => {
    await renderSEO({ title: "Dashboard", noindex: true });
    expect(meta("meta[name='robots']")).toBe("noindex, nofollow");
  });

  it("serializes JSON-LD into a ld+json script tag", async () => {
    await renderSEO({
      title: "Home",
      jsonLd: { "@context": "https://schema.org", "@type": "Organization", name: "GradeThread" },
    });
    const script = document.head.querySelector(
      "script[type='application/ld+json']",
    );
    expect(script).not.toBeNull();
    expect(script?.textContent).toContain('"@type":"Organization"');
  });

  it("escapes < in JSON-LD so it cannot break out of the script", async () => {
    await renderSEO({
      title: "X",
      jsonLd: { "@context": "https://schema.org", "@type": "Thing", name: "</script>" },
    });
    const script = document.head.querySelector(
      "script[type='application/ld+json']",
    );
    expect(script?.textContent).not.toContain("</script>");
    expect(script?.textContent).toContain("\\u003c");
  });
});
