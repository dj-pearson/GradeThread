// GradeThread unified extension — the care-label reader (US-3070).
//
// Right-click any care-tag photograph, anywhere on the web, and get what is
// printed on it: the RN, the brand, the size, the fibre content and the style
// code. A shopper uses it to check a listing's claims; a seller uses it to
// start an item without retyping a label.
//
// ── IT READS THE IMAGE THE PERSON POINTED AT, AND NOTHING ELSE ───────────────
//
// No page URL, no page text, no surrounding markup. The context-menu event
// carries `srcUrl` and that is the entire input. On a marketplace this keeps
// US-3042's no-scrape rule intact; everywhere else it is simply the least the
// feature can ask for.
//
// ── AND IT KEEPS NOTHING ────────────────────────────────────────────────────
//
// The server persists no image (US-9033); the client matches that. The result
// lives in the card and dies with it — no storage.local, no cache, no history.
// A care label carries a size, and a size is a fact about a body.
//
// Zero-dependency UMD so the node tests can drive it.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_LABEL_READER = api; // content-script world
})(typeof self !== "undefined" ? self : this, function () {
  const MENU_ID = "gt-read-label";

  /**
   * The server's cap, mirrored (public-grading.ts GRADE_CHECK_MAX_BYTES).
   *
   * Checked CLIENT-SIDE BEFORE the upload, which is the point: an 11MB press
   * photo posted and then refused costs the person their whole upload and tells
   * them nothing they could not have been told instantly. The server still
   * enforces it — this is a courtesy, not a defence.
   */
  const MAX_BYTES = 8 * 1024 * 1024;

  /** The card is gone after this whether or not anybody touched it. */
  const CARD_TTL_MS = 60 * 1000;

  /** Only what the endpoint returns, in the order the card renders it. */
  const FIELDS = [
    { key: "brand", label: "Brand" },
    { key: "size", label: "Size" },
    { key: "fiberContent", label: "Fibre content" },
    { key: "styleCode", label: "Style code" },
    { key: "rn", label: "RN" },
  ];

  /**
   * Narrow the endpoint's answer, or null when there is nothing to show.
   *
   * A read where every field came back null is not a card with five blanks in
   * it — the model looked and could not tell, and saying so in one sentence is
   * more use than a table of dashes.
   */
  function readAnswer(body) {
    if (!body || typeof body !== "object") return null;

    // The refusals come back with a code and are rendered as themselves,
    // never retried. A rate limit that retries itself is a rate limit the
    // person cannot see and cannot wait out.
    if (body.code === "rate_limited") {
      return { state: "rate_limited", message: strOr(body.error, "") };
    }
    if (body.code === "at_capacity") {
      return { state: "at_capacity", message: strOr(body.error, "") };
    }
    if (typeof body.error === "string" && body.error) {
      return { state: "error", message: body.error };
    }

    const fields = {};
    let any = false;
    for (const f of FIELDS) {
      const v = strOr(body[f.key], null);
      fields[f.key] = v;
      if (v) any = true;
    }
    if (!any) return { state: "empty", message: "", fields, disclaimer: "" };
    return {
      state: "ok",
      message: "",
      fields,
      disclaimer: strOr(body.disclaimer, ""),
    };
  }

  function strOr(v, fallback) {
    return typeof v === "string" && v.trim() ? v.trim() : fallback;
  }

  /**
   * Is this a URL the worker can fetch bytes from?
   *
   * `data:` is allowed because a page may inline a tag photo and the bytes are
   * already in hand. `blob:` is NOT: a blob URL belongs to the page's origin
   * and the service worker cannot read it, so accepting one here would produce
   * a fetch that fails for a reason nobody could diagnose from the card.
   */
  function isReadableImageUrl(url) {
    if (typeof url !== "string" || !url) return false;
    return /^https?:\/\//i.test(url) || /^data:image\//i.test(url);
  }

  /** The RN lookup link, or null when the read found no number. */
  function rnLookupPath(fields) {
    const rn = fields && strOr(fields.rn, null);
    if (!rn) return null;
    // Digits only in the query. The label may print "RN# 12345" and the lookup
    // page wants the number.
    const digits = rn.replace(/[^0-9]/g, "");
    return digits ? "/tools/rn-lookup?rn=" + digits : null;
  }

  /** Every field with a value, as the copy buttons need them. */
  function copyableRows(answer) {
    if (!answer || answer.state !== "ok") return [];
    return FIELDS
      .map((f) => ({ key: f.key, label: f.label, value: answer.fields[f.key] }))
      .filter((r) => Boolean(r.value));
  }

  return {
    MENU_ID,
    MAX_BYTES,
    CARD_TTL_MS,
    FIELDS,
    readAnswer,
    isReadableImageUrl,
    rnLookupPath,
    copyableRows,
  };
});
