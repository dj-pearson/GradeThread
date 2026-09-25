import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { mount, settle } from "./helpers/mount";

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => navigateMock,
}));
import { HelpArticleBody } from "@/components/help/help-article-body";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// H2: one component injects help article bodies, and its comment names the
// real control (sanitizeHtml in buildPatch and projectArticle), not the old
// "sanitised at write time" claim that hid the gap.

const root = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

describe("HelpArticleBody", () => {
  it("renders the body inside a prose container", () => {
    const { container, unmount } = mount(
      <HelpArticleBody html="<h2>Hi</h2><p>Body</p>" className="mt-6" />,
    );
    const div = container.querySelector(".prose") as HTMLElement;
    expect(div.className).toContain("prose");
    expect(div.className).toContain("mt-6");
    expect(div.querySelector("h2")?.textContent).toBe("Hi");
    unmount();
  });

  it("is the only place in src/ that injects a help body_html", () => {
    const offenders = walk("src")
      .filter((f) => !f.includes("/test/") && !f.endsWith("help-article-body.tsx"))
      .filter((f) => {
        const src = readFileSync(join(root, f), "utf8");
        return /dangerouslySetInnerHTML=\{\{\s*__html:\s*[\w?.]*body_html/.test(src);
      });
    expect(offenders).toEqual([]);
  });

  it("no file claims help bodies are 'sanitised at write time'", () => {
    const files = [...walk("src"), ...walk("functions")].filter((f) => !f.includes("/test/"));
    const hits = files.filter((f) =>
      readFileSync(join(root, f), "utf8").includes("sanitised at write time"),
    );
    expect(hits).toEqual([]);
  });
});

describe("H11: links in article bodies stay in the app", () => {
  const BODY =
    '<p><a href="/help/billing/refunds-and-invoices">refunds</a> ' +
    '<a href="/pricing?x=1">pricing</a> <a href="#fees">fees</a> ' +
    '<a href="https://www.ebay.com/help">ebay</a> ' +
    '<a href="/help/billing/x" target="_blank">new tab</a> ' +
    '<a href="/help.md">md</a> <a href="/api/help">api</a></p>';

  function clickLink(container: HTMLElement, text: string, init: MouseEventInit = {}) {
    const a = Array.from(container.querySelectorAll("a")).find((x) => x.textContent === text)!;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    act(() => {
      a.dispatchEvent(ev);
    });
    return ev;
  }

  beforeEach(() => navigateMock.mockReset());

  it("a /help/<cat>/<slug> link navigates to linkFor(slug)", async () => {
    const m = mount(<HelpArticleBody html={BODY} linkFor={(s) => `/dashboard/help/${s}`} />);
    await settle();
    const ev = clickLink(m.container, "refunds");
    expect(ev.defaultPrevented).toBe(true);
    expect(navigateMock).toHaveBeenCalledWith("/dashboard/help/refunds-and-invoices");
    m.unmount();
  });

  it("another same-origin path goes through the router, query kept", async () => {
    const m = mount(<HelpArticleBody html={BODY} linkFor={(s) => `/dashboard/help/${s}`} />);
    await settle();
    expect(clickLink(m.container, "pricing").defaultPrevented).toBe(true);
    expect(navigateMock).toHaveBeenCalledWith("/pricing?x=1");
    m.unmount();
  });

  it("modifier clicks, new-tab links, #hash, files, the API and other origins are left alone", async () => {
    const m = mount(<HelpArticleBody html={BODY} linkFor={(s) => `/dashboard/help/${s}`} />);
    await settle();
    for (const [label, init] of [
      ["refunds", { ctrlKey: true }],
      ["refunds", { metaKey: true }],
      ["refunds", { shiftKey: true }],
      ["new tab", {}],
      ["fees", {}],
      ["ebay", {}],
      ["md", {}],
      ["api", {}],
    ] as const) {
      expect(clickLink(m.container, label, init).defaultPrevented, label).toBe(false);
    }
    expect(navigateMock).not.toHaveBeenCalled();
    m.unmount();
  });
});
