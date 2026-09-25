// Shared Help Center body fixtures (H1). Not a test file: importing a *_test.ts
// would register its tests twice.

export const HOSTILE_HELP_BODY =
  '<p>ok</p><img src=x onerror=alert(1)><script>x</script>' +
  '<meta http-equiv=refresh content=0;url=https://evil>' +
  '<form action=https://evil><input name=q></form>';

// What the help editor and the seed script emit. Void elements are written in
// the sanitizer's own serialization so the sample can round-trip byte for byte.
export const TIPTAP_HELP_BODY = [
  "<h2>Before you start</h2>",
  '<p>Open <a href="/help/billing/refunds-and-invoices">refunds</a> or <a target="_blank" rel="noopener noreferrer nofollow" href="https://www.ebay.com/help">eBay help</a>.</p>',
  "<ul><li><p><strong>Front</strong> and <em>back</em></p></li><li><p><code>SKU-1</code></p></li></ul>",
  "<ol><li><p>One</p></li></ol>",
  '<p><img src="https://cdn.gradethread.com/help/a.png" alt="The measure screen" /></p>',
  '<table><tbody><tr><th colspan="1" rowspan="1"><p>Fee</p></th></tr><tr><td colspan="1" rowspan="1"><p>13.25%</p></td></tr></tbody></table>',
  '<pre><code class="language-text">GT-1234</code></pre>',
  "<blockquote><p>Quote &amp; more</p></blockquote>",
].join("");
