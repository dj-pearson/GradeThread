// US-353: allowlist (parser-based) HTML sanitizer — bypass-corpus tests.
//
// These assert that the tokenizer drops every executable construct even when
// the input is adversarially malformed: nested/broken tags, javascript:/data:
// URIs, attribute-smuggled `>`, RAWTEXT mutation tricks, and bogus comments.
import { assert, assertEquals } from "@std/assert";
import { sanitizeHtml } from "../lib/content-sanitize.ts";

// No <script>, no on* handler, no javascript:/vbscript:, no <style>/<svg>/
// <iframe> (non-YouTube), no inline style attr should survive.
function assertInert(out: string) {
  const low = out.toLowerCase();
  assert(!low.includes("<script"), `leaked <script: ${out}`);
  assert(!/\son\w+\s*=/.test(low), `leaked event handler: ${out}`);
  assert(!low.includes("javascript:"), `leaked javascript: ${out}`);
  assert(!low.includes("vbscript:"), `leaked vbscript: ${out}`);
  assert(!low.includes("<style"), `leaked <style: ${out}`);
  assert(!low.includes("<svg"), `leaked <svg: ${out}`);
  assert(!low.includes("<object"), `leaked <object: ${out}`);
  assert(!low.includes("<embed"), `leaked <embed: ${out}`);
  assert(!low.includes(" style="), `leaked inline style: ${out}`);
}

Deno.test("strips a plain script tag and its content", () => {
  const out = sanitizeHtml('<p>Hi</p><script>alert(1)</script>');
  assertInert(out);
  assert(!out.includes("alert"));
  assert(out.includes("<p>Hi</p>"));
});

Deno.test("defeats nested/broken script reconstitution", () => {
  // A naive regex .replace() of <script>…</script> would leave a live
  // <script> behind here. The RAWTEXT tokenizer must not.
  for (
    const payload of [
      "<scri<script>pt>alert(1)</scri</script>pt>",
      "<script><script>alert(1)</script>",
      "<scr\0ipt>alert(1)</scr\0ipt>",
      "<SCRIPT SRC=//evil/x.js></SCRIPT>",
    ]
  ) {
    assertInert(sanitizeHtml(payload));
  }
});

Deno.test("strips event handlers regardless of quoting/casing", () => {
  for (
    const payload of [
      '<img src=x onerror=alert(1)>',
      '<img src="x" OnError="alert(1)">',
      "<a href='#' onclick='steal()'>x</a>",
      '<p OnMouseOver=alert(1)>hover</p>',
    ]
  ) {
    assertInert(sanitizeHtml(payload));
  }
});

Deno.test("blocks javascript:/vbscript:/data: hrefs (incl. obfuscated)", () => {
  for (
    const payload of [
      '<a href="javascript:alert(1)">x</a>',
      '<a href="java\tscript:alert(1)">x</a>',
      '<a href="JavaScript:alert(1)">x</a>',
      '<a href="vbscript:msgbox(1)">x</a>',
      '<a href="javascript:alert(1)">x</a>',
    ]
  ) {
    const out = sanitizeHtml(payload);
    assertInert(out);
    // The anchor text survives, the dangerous href does not.
    assert(out.includes(">x</a>"), out);
    assert(!out.includes("href="), out);
  }
});

Deno.test("allows data:image on <img> but not data: on <a>", () => {
  const img = sanitizeHtml('<img src="data:image/png;base64,AAAA" alt="ok">');
  assert(img.includes('src="data:image/png;base64,AAAA"'), img);
  const a = sanitizeHtml('<a href="data:text/html,<b>x">y</a>');
  assert(!a.includes("href="), a);
});

Deno.test("attribute-smuggled '>' cannot break out of the tag", () => {
  // The `>` lives inside the title value; it must not start new markup.
  const out = sanitizeHtml('<a href="#" title="a>b" onclick="x()">link</a>');
  assertInert(out);
  assert(out.includes("link</a>"), out);
});

Deno.test("drops svg/style mutation vectors entirely", () => {
  assertInert(sanitizeHtml("<svg><style><img src=x onerror=alert(1)></style></svg>"));
  assertInert(sanitizeHtml('<svg><animate onbegin=alert(1) attributeName=x>'));
  assertInert(sanitizeHtml("<noscript><p title='</noscript><img src=x onerror=alert(1)>'>"));
});

Deno.test("only YouTube iframes survive", () => {
  const yt = sanitizeHtml('<iframe src="https://www.youtube.com/embed/abc"></iframe>');
  assert(yt.includes("youtube.com/embed/abc"), yt);
  for (
    const bad of [
      '<iframe src="https://evil.com/x"></iframe>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<iframe src="http://www.youtube.com/embed/x"></iframe>', // not https
    ]
  ) {
    const out = sanitizeHtml(bad);
    assert(!out.toLowerCase().includes("<iframe"), out);
  }
});

Deno.test("drops bogus comments and CDATA without leaking markup", () => {
  assertInert(sanitizeHtml("<!-- <script>alert(1)</script> -->"));
  assertInert(sanitizeHtml("<![CDATA[<script>alert(1)</script>]]>"));
  assertInert(sanitizeHtml("<!doctype html><img src=x onerror=alert(1)>"));
});

Deno.test("preserves allowed structure + auto-balances stray tags", () => {
  const out = sanitizeHtml(
    "<h2>Title</h2><p>Para with <strong>bold</strong> and <em>em</p>",
  );
  assert(out.includes("<h2>Title</h2>"), out);
  assert(out.includes("<strong>bold</strong>"), out);
  // The unclosed <em> is auto-closed; no dangling open tag.
  assertEquals((out.match(/<em>/g) || []).length, (out.match(/<\/em>/g) || []).length);
  // A stray end tag with no opener is dropped.
  assert(!sanitizeHtml("</div></p>plain").includes("</"));
});

Deno.test("escapes bare angle brackets / ampersands in text", () => {
  const out = sanitizeHtml("5 < 10 && 10 > 5, see &amp; keep &copy;");
  assert(out.includes("5 &lt; 10"), out);
  assert(out.includes("10 &gt; 5"), out);
  assert(out.includes("&amp; 10"), out); // bare && → escaped
  assert(out.includes("&amp; keep"), out); // existing &amp; preserved (not doubled)
  assert(out.includes("&copy;"), out); // existing entity preserved
});

Deno.test("adds rel=noopener to target=_blank links", () => {
  const out = sanitizeHtml('<a href="https://x.com" target="_blank">x</a>');
  assert(out.includes('target="_blank"'), out);
  assert(out.includes('rel="noopener noreferrer"'), out);
});

Deno.test("empty / falsy input is safe", () => {
  assertEquals(sanitizeHtml(""), "");
  assertEquals(sanitizeHtml(undefined as unknown as string), "");
});
