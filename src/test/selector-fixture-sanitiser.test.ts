import { describe, expect, it } from "vitest";
import {
  BLANK_IMAGE,
  pathOf,
  sanitiseHtml,
} from "../../scripts/capture-selector-fixture.mjs";

// US-3063 AC1/AC2: what the fixture capture removes before anything is written.
//
// A sanitiser that only ever runs inside an operator script is one nobody
// checks until a fixture leaks — and a leaked fixture is a marketplace page
// captured from a signed-in account, committed to a public repo. gitleaks runs
// after this and deletes the file if it trips, but gitleaks looks for
// credential SHAPES; it does not know that a handle in an og: tag identifies
// the person who ran the capture.
//
// So these are the structural removals, tested as rules rather than described
// in a comment.

describe("sanitiseHtml: scripts", () => {
  it("removes script blocks entirely, content included", () => {
    // The single most important removal. A marketplace page's inline state blob
    // routinely carries the signed-in user's id, email and address book, and it
    // is a <script> every time.
    const html =
      `<html><head><script>window.__USER__={id:"u_1",email:"a@b.com"}</script>` +
      `</head><body><h1>Hi</h1></body></html>`;
    const out = sanitiseHtml(html);
    expect(out).not.toContain("__USER__");
    expect(out).not.toContain("a@b.com");
    expect(out).not.toContain("<script");
    expect(out).toContain("<h1>Hi</h1>");
  });

  it("removes a script with attributes and a self-closing one", () => {
    const out = sanitiseHtml(
      `<script type="application/json" id="state">{"email":"a@b.com"}</script>` +
        `<script src="/app.js"/><p>keep</p>`,
    );
    expect(out).not.toContain("a@b.com");
    expect(out).not.toContain("app.js");
    expect(out).toContain("<p>keep</p>");
  });

  it("removes noscript, which carries tracking pixels with account ids", () => {
    const out = sanitiseHtml(
      `<noscript><img src="https://t.example/p?uid=u_1"></noscript><p>k</p>`,
    );
    expect(out).not.toContain("uid=u_1");
    expect(out).toContain("<p>k</p>");
  });
});

describe("sanitiseHtml: images", () => {
  it("keeps the img element but replaces its src", () => {
    // The element has to survive: a gallery selector counts <img> nodes, and a
    // fixture with the images stripped would fail a selector that is correct.
    const out = sanitiseHtml(
      `<img class="photo" src="https://cdn.example/u_1/abc.jpg" alt="x">`,
    );
    expect(out).toContain("<img");
    expect(out).toContain('class="photo"');
    expect(out).toContain(BLANK_IMAGE);
    expect(out).not.toContain("cdn.example");
    expect(out).not.toContain("u_1");
  });

  it("drops srcset, which carries the same URLs at four sizes", () => {
    const out = sanitiseHtml(
      `<img src="https://cdn.example/a.jpg" srcset="https://cdn.example/a@2x.jpg 2x">`,
    );
    expect(out).not.toContain("srcset");
    expect(out).not.toContain("cdn.example");
  });

  it("handles single-quoted attributes", () => {
    const out = sanitiseHtml(`<img src='https://cdn.example/a.jpg'>`);
    expect(out).not.toContain("cdn.example");
  });
});

describe("sanitiseHtml: form values", () => {
  it("empties input values", () => {
    const out = sanitiseHtml(
      `<input name="title" value="My personal draft listing">`,
    );
    expect(out).toContain('name="title"');
    expect(out).toContain('value=""');
    expect(out).not.toContain("My personal draft listing");
  });

  it("empties textarea content", () => {
    const out = sanitiseHtml(
      `<textarea name="description">Bought at my local shop, ask me</textarea>`,
    );
    expect(out).toContain('name="description"');
    expect(out).not.toContain("Bought at my local shop");
  });
});

describe("sanitiseHtml: operator redactions", () => {
  it("scrubs the handle and email wherever they appear", () => {
    // The rules above are structural and cannot find a handle in a meta tag or
    // a data attribute, which is exactly where marketplaces put it.
    const html =
      `<meta property="og:title" content="myhandle's closet">` +
      `<div data-user="myhandle">myhandle</div>` +
      `<a href="mailto:me@example.com">me@example.com</a>`;
    const out = sanitiseHtml(html, ["myhandle", "me@example.com"]);
    expect(out).not.toContain("myhandle");
    expect(out).not.toContain("me@example.com");
    expect(out).toContain("REDACTED");
  });

  it("is case-insensitive, because nav chrome title-cases the handle", () => {
    const out = sanitiseHtml(`<span>MyHandle</span>`, ["myhandle"]);
    expect(out).not.toContain("MyHandle");
  });

  it("ignores a redaction too short to be safe", () => {
    // Redacting "ab" would rewrite half the document and destroy the fixture
    // while looking like it worked.
    const out = sanitiseHtml(`<div class="tab">tab</div>`, ["ab"]);
    expect(out).toContain('class="tab"');
  });

  it("treats a redaction as literal text, not a pattern", () => {
    // A handle can contain a dot or a plus. Unescaped, "a.b" would match "axb".
    const out = sanitiseHtml(`<p>axb and a.b</p>`, ["a.b"]);
    expect(out).toContain("axb");
    expect(out).not.toContain("a.b");
  });
});

describe("pathOf", () => {
  it("keeps the path and drops the query", () => {
    // A captured URL's query string routinely identifies the account that
    // captured it.
    expect(pathOf("https://poshmark.com/listing/abc?utm_source=x&uid=u_1"))
      .toBe("/listing/abc");
  });

  it("returns empty for something that is not a URL", () => {
    expect(pathOf("not a url")).toBe("");
    expect(pathOf("")).toBe("");
  });
});
