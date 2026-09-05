// GradeThread unified extension — the return shield (US-3068).
//
// A seller is looking at an item-not-as-described return in eBay Seller Hub.
// GradeThread already assembled the evidence: a dated grade report, the
// disclosure the listing actually carried, and whether the two support each
// other. This puts that on the page they are already on, instead of making them
// go and find the item in FlipDesk first.
//
// ── IT READS ONE THING OFF THE PAGE, AND THAT THING IS THE URL ───────────────
//
// US-3042's rule, unchanged: on eBay the extension reads an id and nothing
// else, because eBay's API License Agreement says their content comes through
// their API and a shopper's browser is not that. The return id is in the URL.
// Everything else — the order, the buyer's complaint, the grade report, the
// disclosure — is resolved server-side from a row we already hold.
//
// ── IT NEVER SUBMITS ANYTHING ────────────────────────────────────────────────
//
// No form is filled, no eBay button is clicked, no file is attached. Sending
// evidence stays on the FlipDesk post-sale surface where the eBay API does it
// behind a seller's separate, deliberate click. A test asserts this file
// contains no click, no submit and no value assignment, because "we already
// have the pack, why not attach it" is the obvious improvement that would make
// this extension act on a dispute on the seller's behalf.
//
// ── AND IT NEVER PROMISES AN OUTCOME ─────────────────────────────────────────
//
// No string here says or implies the case will be won. Evidence is evidence.
// A seller who reads "this will win" and loses has been told something we had
// no business saying, on the day it costs them money.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_RETURN_SHIELD = api; // every browser world
})(typeof self !== "undefined" ? self : this, function () {
  /**
   * Seller Hub paths that carry a return or case id.
   *
   * eBay serves the same dispute under more than one path shape, and the id is
   * the last meaningful segment in each. Anchored to /sh/ so an ordinary
   * listing page can never match.
   */
  const RETURN_PATH_RES = [
    /^\/sh\/rtn\/([A-Za-z0-9_-]{1,64})(?:\/|$)/,
    /^\/sh\/cases\/([A-Za-z0-9_-]{1,64})(?:\/|$)/,
    /^\/sh\/returns\/([A-Za-z0-9_-]{1,64})(?:\/|$)/,
  ];

  const EBAY_HOST_RE = /(^|\.)ebay\.[a-z.]{2,6}$/i;

  function isEbayHost(url) {
    try {
      return EBAY_HOST_RE.test(new URL(url).hostname);
    } catch (_e) {
      return false;
    }
  }

  /**
   * The return id on this page, or null.
   *
   * Null for every page that is not a Seller Hub dispute, including the Seller
   * Hub landing and the returns LIST — a list has no single return to answer
   * about, and guessing one would put a verdict about item A on a row for B.
   */
  function returnIdFromUrl(url) {
    if (typeof url !== "string" || !isEbayHost(url)) return null;
    let path;
    try {
      path = new URL(url).pathname;
    } catch (_e) {
      return null;
    }
    for (const re of RETURN_PATH_RES) {
      const m = path.match(re);
      if (m) return m[1];
    }
    return null;
  }

  /** Is this a page the shield should run on at all? */
  function isReturnPage(url) {
    return returnIdFromUrl(url) !== null;
  }

  /** The three answers the server can give. Anything else renders nothing. */
  const VERDICTS = ["assemble", "refuse-undisclosed", "no-report"];

  /**
   * Narrow the server's answer to something renderable, or null.
   *
   * Null on every failure — an unknown verdict, a malformed body, a network
   * error the caller turned into null. Absence is not a claim: a seller looking
   * at a return must not see a GradeThread panel that says nothing useful, and
   * an "unverified" state would read as us having checked and found nothing.
   */
  function readAnswer(body) {
    if (!body || typeof body !== "object") return null;
    const verdict = typeof body.verdict === "string" ? body.verdict : "";
    if (VERDICTS.indexOf(verdict) === -1) return null;
    if (verdict === "no-report") return null; // nothing to show, so show nothing

    const citations = Array.isArray(body.citations) ? body.citations : [];
    return {
      verdict: verdict,
      certificateNumber: typeof body.certificateNumber === "string"
        ? body.certificateNumber
        : null,
      gradedAt: typeof body.gradedAt === "string" ? body.gradedAt : null,
      defectCount: typeof body.defectCount === "number" ? body.defectCount : 0,
      hasPublicationSnapshot: body.hasPublicationSnapshot === true,
      // ⚠ ONLY on assemble, whatever the server sent. A refusal that arrived
      // with citations would otherwise hand the seller a Copy button for text
      // arguing that the buyer is right.
      citations: verdict === "assemble" ? citations : [],
    };
  }

  /**
   * The paragraph the seller can copy.
   *
   * Built HERE from typed citation fields, never from a sentence the server
   * composed, because the wording is the safety property: it states what the
   * report recorded and what the listing disclosed, and it claims nothing about
   * the outcome.
   */
  function draftParagraph(answer, strings) {
    if (!answer || answer.verdict !== "assemble") return "";
    const lines = [strings.draftOpening];
    for (const c of answer.citations) {
      if (!c || typeof c !== "object") continue;
      const where = c.disclosedIn === "aspects"
        ? strings.disclosedInAspects
        : strings.disclosedInDescription;
      lines.push(
        "- " + String(c.reportText || "").trim() + " " + where + ' "' +
          String(c.disclosureQuote || "").trim() + '"',
      );
    }
    if (answer.certificateNumber) {
      lines.push(strings.certificateLine.replace("{n}", answer.certificateNumber));
    }
    return lines.join("\n");
  }

  /** A date a seller reads, from an ISO string. Empty when there is none. */
  function gradedOn(answer) {
    if (!answer || !answer.gradedAt) return "";
    const d = new Date(answer.gradedAt);
    return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }

  return {
    RETURN_PATH_RES,
    VERDICTS,
    isEbayHost,
    isReturnPage,
    returnIdFromUrl,
    readAnswer,
    draftParagraph,
    gradedOn,
  };
});
