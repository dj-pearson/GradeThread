import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { mount } from "./helpers/mount";
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
