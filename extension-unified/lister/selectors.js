// GradeThread Lister — versioned marketplace selectors / flows (US-716)
//
// ⚠️ MARKETPLACES CHANGE THEIR LISTING FORMS WITHOUT NOTICE — esp. Mercari.
// Assume monthly breakage. Every flow below MUST `probe()` its `required`
// selectors before touching the form and FAIL LOUDLY (degrade to a clear
// "list manually" message) when any required selector is missing, rather than
// half-filling a form or silently doing nothing.
//
// To update a broken target: bump that platform's `version`, set `lastVerified`
// to the date you re-checked it against the live site, fix the selectors, and
// note what changed. The version is reported back to the SaaS + shown in the
// popup so a stale build is visible.
//
// Content scripts run in a shared isolated world per frame, so assigning to the
// global here makes GT_LISTER_SELECTORS visible to common.js + the per-platform
// script that load after it.

const GT_LISTER_SELECTORS = {
  // ── Poshmark — PHASE 1 (enabled) ──────────────────────────────────────
  poshmark: {
    enabled: true,
    version: "2026.08.2",
    // 2026-08-10: confirmed. A second report from the live create-listing page
    // read clean — title, description and submit all resolve against the new
    // wizard. `price` and `photoInput` are still misses, and they are supposed
    // to be: those fields live on a later wizard step, they are optional here,
    // and the fill flow already reports 0 photos attached rather than claiming
    // otherwise. The seller finishes both in the tab, which is what they were
    // going to do anyway.
    lastVerified: "2026-08-20",
    newListingUrl: "https://poshmark.com/create-listing",
    // US-1876: known domains a delist URL must host-match (subdomains included).
    // The background rejects any delist listingUrl outside these.
    hosts: ["poshmark.com"],
    // US-1875 AC3: how to recognise a login/interstitial page, so a logged-out
    // seller is told "log in and retry" instead of "the selectors broke". A
    // password input is the universal tell (checked in isLoginWall); these narrow
    // it for the SPA case where the URL changes but the form renders in place.
    login: { urlPattern: "poshmark\\.com/(login|signup)" },
    // US-1877 (AC1): what a LIVE listing's URL looks like once the seller submits.
    // Anchored on the path so the create-listing page we opened can never match
    // itself — a false capture would record the form URL as the live listing.
    liveListingUrlPattern: "^https://[^/]*poshmark\\.(com|ca)/listing/[^/]+",
    // The form is considered "present" only if every required selector resolves.
    required: ["title", "description", "submit"],
    // 2026-08-10, from a probe report on the live create-listing page: Poshmark
    // has REBUILT this as a multi-step wizard, and every selector below was a
    // miss. The editor now starts on a "Single Item / Multi Item" step whose
    // only inputs are title, brand and tags; price and photos moved to a later
    // step, and there is no submit button on screen at all — the primary action
    // is "Next".
    //
    // The wizard does not change what we DO here: the fill flow has never
    // auto-submitted (see runFlow in common.js — category, size and condition
    // pickers vary too much to set safely, so the seller reviews and posts).
    // `submit` is a PRESENCE PROBE, proof the editor rendered, and "Next" is
    // that proof on the new layout. Nothing clicks it.
    //
    // The placeholder anchors are the weak part and are deliberately LAST: they
    // are English-only, so a French-Canadian seller falls through to them and
    // gets "list manually" rather than the wrong field filled. Replace them the
    // moment a report shows a stable class or data-test on these inputs.
    fields: {
      title:
        'input[data-test="listing-editor-title"], input[name="title"], input#title, ' +
        'input[placeholder^="What are you selling"]',
      description:
        'textarea[data-test="listing-editor-description"], textarea[name="description"], ' +
        'textarea#description, textarea[placeholder^="Describe it"]',
      // US-2730 STEP 1 — DECLARED SO THE PROBE CAN SEE THEM, NOT SO THEY FILL.
      //
      // Nothing fills these yet, and that is deliberate. runFlow only fills the
      // keys it names, so declaring a field here is inert until a fill call is
      // added. What declaring it DOES do is make the field visible to the deep
      // selector probe (US-2485): the probe reports candidate controls for
      // entries that MISS, so a key with no working selector is how we get the
      // real attribute signatures off a page nobody here can log into.
      //
      // The values below are the documented wizard's likely anchors, in the
      // house order: data-test first, then name/id, and NO placeholder-text
      // fallback. A placeholder anchor that half-matches would fill the wrong
      // control, which is worse than filling nothing — the same reasoning the
      // title/description entries already carry, applied before the fact.
      //
      // Poshmark's step 1 holds title, BRAND and TAGS (see the wizard note
      // above), so these two are reachable on the page the extension already
      // opens. Both are typeaheads, so a matching selector is necessary and may
      // not be sufficient: setting the value may still need the dropdown
      // selection that a real keystroke triggers. Verify before filling.
      // 2026-08-20: VERIFIED against a live create-listing page with the deep
      // probe. Every guess above was wrong; these are what is actually there.
      //
      // BRAND has no data-test, no name and no id, and its class is
      // `form__text form__text--input p--4` — the SAME class the title input
      // carries. The placeholder is the only thing that distinguishes the two,
      // so this is a placeholder anchor by necessity rather than by choice, and
      // it is English-only: a French-Canadian seller falls through to a miss and
      // gets nothing filled, which is the correct failure. Replace it the moment
      // a report shows a test attribute here.
      //
      // `^=` rather than `=` because the visible text is the part we can rely on;
      // a trailing "(required)"-style suffix must not break the match.
      brand: 'input[placeholder^="Enter the Brand"]',
      // TAGS is the opposite and much safer: `listing-editor__tag__input` is the
      // site's own component class, matches exactly one element, and needs no
      // English. Declared and NOT filled — see runFlow. It is a chip control:
      // setting a value types text, it does not create a tag, which needs the
      // Enter key. Filling it would leave uncommitted text in a field the seller
      // believes is set.
      tags: 'input.listing-editor__tag__input',
      // COLOUR IS A PICKER, and is deliberately absent from this list.
      //
      // Confirmed on the live form 2026-08-20. It was declared here briefly to
      // let the probe describe it; that is now answered, so the entry is gone
      // rather than left to report "missing" in every future report — a
      // selector that can never match reads as a broken channel, and this one
      // is not broken.
      //
      // FOUR PICKERS, ALL CONFIRMED ON THE LIVE FORM 2026-08-20:
      //   colour, size, category, condition.
      // None is a text input, so none belongs in this list. They are option
      // lists whose choices vary per garment, where picking wrong is worse than
      // leaving the field empty — and Poshmark requires category and size before
      // it will publish, so the seller is on that screen regardless.
      //
      // This is the COMPLETE answer for Poshmark's create form. Everything
      // text-shaped is now filled: title, description, brand, style tags, price
      // and original price. What remains is pickers and nothing else, so there
      // is no more selector work to do here — driving an option list is a
      // different problem with its own verification, not a line added here.
      // 2026-08-20: `data-vv-name` is the anchor, and it was hiding in plain
      // sight. Poshmark's editor is Vue + vee-validate (its console says so),
      // and vee-validate stamps every validated field with the model name the
      // site itself uses. That makes it semantic, stable across restyles, and
      // free of English — everything the placeholder anchors on this page are
      // not. The probe never showed it because `data-vv-name` was not in
      // PROBE_ATTRS; it is now, so the next report on any Vue marketplace
      // carries it.
      //
      // The modal ids stay as a SECOND clause rather than being replaced. The
      // same amount is editable in two places — the form field here, and the
      // price-suggestion dialog it opens — and a selector that works whichever
      // one is on screen costs nothing.
      originalPrice:
        'input[data-vv-name="originalPrice"], #listing-price-modal-original-price-input, ' +
        'input[data-test="listing-editor-original-price"]',
      price:
        'input[data-vv-name="listingPrice"], #listing-price-modal-listing-price-input, ' +
        'input[data-test="listing-editor-listing-price"]',
      // 2026-08-11: `input[type="file"][accept*="image"]` matched NOTHING here,
      // and had not been noticed because photoInput is not in `required` — the
      // probe stayed green while every cross-post to Poshmark attached zero
      // photos. The cause is that Poshmark's picker lists EXTENSIONS rather than
      // a MIME type: accept=".mov, .mp4, .png, .jpg, .jpeg", which `*="image"`
      // cannot match.
      //
      // `#img-file-input` is the real control and it is the FIRST file input in
      // the document, which matters: a selector list has no clause priority, so
      // querySelector returns the earliest MATCHING element in document order,
      // not the earliest clause. The generic fallbacks are last in the string
      // for readability only — document order is what actually decides.
      photoInput:
        'input#img-file-input, input[name="img-file-input"], ' +
        'input[type="file"][accept*="image"], input[type="file"][accept*="jpg"]',
    },
    // ── The price dialog (2026-08-20) ────────────────────────────────────
    //
    // Poshmark's price is not on the create form. Clicking the price control
    // opens `listing-price-suggestion-modal`, and BOTH amounts live inside it.
    // That is the whole reason `price` above has never matched, and why sellers
    // were told "we could not set the price" on every single cross-post.
    //
    // The two inputs are the best anchors on this entire page — real ids and a
    // real aria-label, no placeholder text, no English:
    //   #listing-price-modal-listing-price-input   aria-label="Listing Price"
    //   #listing-price-modal-original-price-input
    //
    // `open` is the one piece INFERRED rather than read off the page. The deep
    // probe found a create-page input carrying `ff--no-increment-input` that is
    // not one of the modal's two, and that is the price control the seller
    // clicks. The `:not()` is what keeps it honest — it can never match the
    // modal's own inputs, so a mis-inference opens nothing rather than typing
    // into the wrong box. If the dialog does not appear, the flow reports the
    // price as unfilled exactly as it does today; nothing is worse than before.
    //
    // NOT a submit and never will be. Opening a dialog to reach a field is the
    // same move the delist flow already makes for its menu; the seller still
    // reviews and posts. It runs AFTER the photos deliberately: an open modal
    // sits over the file input, and attaching photos matters more than price.
    // Poshmark's own cap: the tag box says "Add up to 3 tags". Ours to respect,
    // not to exceed — a fourth entry is a rejected keystroke at best.
    tagsMax: 3,
    priceDialog: {
      open: 'input.ff--no-increment-input:not([id^="listing-price-modal"])',
      price: '#listing-price-modal-listing-price-input, input[aria-label="Listing Price"]',
      originalPrice: '#listing-price-modal-original-price-input',
    },
    submit:
      'button[data-test="listing-editor-submit"], button[type="submit"].listing-editor__submit, ' +
      'button.btn--primary[type="submit"], button[data-et-name="next"]',
    // US-717: end a live listing. On a Poshmark listing page the owner has an
    // options/menu control exposing "Delete Listing", which opens a confirm
    // modal. Probed + fail-loud like the fill flow.
    delist: {
      enabled: true,
      version: "2026.08.0",
      // 2026-08-10: a probe of a live listing found no menu and no delete
      // anywhere outside the site header. What it DID find is
      // `[data-et-name="edit_listing"]` — Poshmark's delete lives behind that,
      // on the edit page rather than the listing.
      //
      // US-2486 makes that a supported shape rather than a blocker. `menu` is
      // now the link, `navigatesTo` says that clicking it loads a page instead
      // of opening a panel, and the run continues on the far side with the
      // stage recorded on the job first. See runDelistFlow.
      //
      // 2026-08-11: all three controls are now named from live evidence rather
      // than guessed — `edit_listing` on the listing, `delete` on the editor,
      // and a confirm that resolves in the editor's modal footer. The date
      // moves with them.
      //
      // What is still unproven is the WHOLE CHAIN running end to end: nobody
      // has watched a listing actually disappear. That is the one thing a
      // probe cannot show, and it fails safe if it is wrong — no positive
      // verification means `unverified`, which leaves the pending-delist stamp
      // armed and asks the seller to check.
      lastVerified: "2026-08-11",
      // The presence of this key is what turns `menu` from a panel-opener into
      // a link. Anchored on origin + path so a query string cannot satisfy it.
      navigatesTo: "^https://[^/]*poshmark\\.(com|ca)/edit-listing/",
      // US-1875 AC1: ONLY what can exist before any interaction. `remove` lives
      // inside the overflow menu and does not exist until `menu` is clicked, so
      // requiring it up front (as this did) made the probe unsatisfiable and the
      // whole enabled flow bailed out every run. It is validated after the click.
      required: ["menu"],
      menu:
        '[data-et-name="edit_listing"], button[data-test="listing-menu"], ' +
        'button.listing__menu, [data-et-name="listing_options"]',
      // 2026-08-11, from the listing editor's own test attributes: the control
      // is `[data-et-name="delete"]`, sitting beside cancel, update, discard
      // and save_draft. The three older selectors here were guesses and all
      // three missed; they stay only as fallbacks for an older layout.
      //
      // `a[href*="delete"]` is deliberately LAST and deliberately kept narrow.
      // It is the loosest thing in this file — on a page that happened to link
      // anywhere containing the word, it would match — and it is only ever
      // consulted after the editor has been reached and the named selectors
      // have already failed.
      remove:
        '[data-et-name="delete"], [data-test="delete-listing"], ' +
        '[data-et-name="delete_listing"], a[href*="delete"]',
      // 2026-08-11: a probe of the listing editor found the confirm modal —
      // `[data-test="modal"]` with a `modal-footer` holding a plain "No" and
      // "Yes" pair. Neither carries a `data-et-name`, which is why every
      // selector before the last one here missed: they were all looking for a
      // name that Poshmark does not put on this button.
      //
      // Scoped to the footer rather than matched on `btn--primary` alone: the
      // editor's own "Update" button is also `btn--primary`, and a confirm
      // selector that can match Save is the worst possible miss on this flow.
      confirm:
        'button[data-test="confirm-delete"], button.btn--primary[data-et-name="yes"], ' +
        'button[data-et-name="confirm"], [data-test="modal-footer"] button.btn--primary',
      // US-1875 AC2: proof the delete took. Poshmark bounces to the closet, so the
      // URL change is the primary signal; the listing menu vanishing and the
      // success toast are corroboration for any in-place variant.
      verify: {
        urlChanged: true,
        gone: 'button[data-test="listing-menu"], button.listing__menu',
        toast: '[data-test="toast-success"], .toast--success, [role="alert"].success',
      },
    },

    // ── Engagement automation (US-2482) ────────────────────────────────────
    //
    // Share / follow / send-offer, run in the seller's own closet tab. The caps,
    // pacing and consent gate are NOT here — they are in lister/engagement.js as
    // a pure state machine with its own tests, because those are the parts that
    // can cost a seller their closet and they must be impossible to remove by
    // editing a selector file.
    //
    // What IS here is the DOM, and one selector matters more than the others:
    // `humanCheck`. When Poshmark asks for a human check, the run pauses and the
    // seller finishes it. GradeThread does not answer it, does not route it to a
    // solving service, and does not retry around it — that is a bright line in
    // vault/60-decisions/adr-no-server-side-marketplace-automation.md §3.2, and
    // it holds even though this runs in the seller's own browser.
    engage: {
      // ON as of 2026-08-11, at the seller's instruction and with the default
      // caps cut to 250/50/25 for the first live release (see LIMITS in
      // engagement.js). Every control on the path was found on the live closet:
      // shareButton, shareInternal, and the confirm modal's primary.
      //
      // ONE THING IS STILL UNPROVEN, and it is written here rather than
      // discovered later: `actionConfirmed` — Poshmark's success toast — has
      // never been observed. Four watcher runs failed to catch it; it survives
      // about two seconds and may not be a DOM insertion at all. The meter
      // therefore leans on `confirmGone`, the share modal closing, admissible
      // only as a present-then-absent transition (see confirmed() in
      // poshmark-engage.js).
      //
      // That is why the default cap is 250 and not 5000. If the witness is
      // wrong the meter under-counts, and a low ceiling is what keeps an
      // under-counting meter from becoming a share-jailed closet. Watch one
      // real run before raising it.
      enabled: true,
      // 2026-08-10, from a probe on the seller's own closet: `shareButton` and
      // `shareToFollowers` both resolve. That is the click path itself, and it
      // is the half that was most likely to have moved.
      //
      // The paragraph that used to sit here said STILL OFF, directly below the
      // line that turns this on — it was written when `enabled` was false and
      // was never rewritten when it flipped. Left in place it would eventually
      // send someone looking for a switch that had already been thrown. What it
      // argued is still true and now lives above, next to the caps it explains:
      // the click path is verified, the confirmation is not, and the low default
      // cap is the answer to that.
      version: "2026.08.0",
      lastVerified: "2026-08-11",
      // The closet page a share run walks. Locale-free; Poshmark redirects an
      // unauthenticated visitor to login, which isLoginWall catches.
      closetUrlPattern: "^https://[^/]*poshmark\\.(com|ca)/closet/",
      required: ["shareButton"],
      // Each listing tile's share control. Opens a small modal offering "To My
      // Followers" and "To a Party".
      shareButton:
        '[data-et-name="share"], button.share-grey, .tile__social-actions button[aria-label*="Share"]',
      // ⚠️ SHARING IS TWO MODALS, NOT ONE (watched live, 2026-08-11).
      //
      // The first modal is a share MENU, and most of what it offers leaves
      // Poshmark entirely: `share_facebook`, `share_pinterest`, `share_email`,
      // `share_copy`, plus a `people_search` box for sending the listing to a
      // named person. The one internal option is `share_poshmark`, and it opens
      // a SECOND modal where "To My Followers" and "To a Party" actually live.
      //
      // That structure is why this stays off. A share automation that clicks
      // the wrong element in the first modal does not fail — it posts the
      // seller's listing to their Facebook, or DMs it to a stranger, thousands
      // of times. Sharing to a party has always been excluded here for a
      // smaller version of the same reason (parties are themed and time-boxed);
      // discovering an outbound-social row sitting one selector away makes the
      // point louder.
      //
      // `shareInternal` is the step INTO the followers choice, and it is
      // required so that nothing can reach the second modal by accident.
      shareInternal: '[data-et-name="share_poshmark"]',
      // Inside the SECOND modal, and every one of these is now SCOPED to a
      // modal — which is the fix, not a tidy-up.
      //
      // 2026-08-11: this resolved `ok` on a closet at rest, with no modal open
      // anywhere. `a[href*="followers"]` was matching the closet's own
      // Followers tab, because `.share-modal` is in the page from the start,
      // empty, and the descendant combinator found the link elsewhere once the
      // first clause failed. A selector we intend to CLICK, thousands of times,
      // matching a navigation link.
      //
      // What it would have done is worse than nothing: shareOne waits for this
      // and clicks it, so the run would have left the closet on its first
      // iteration and then found no tiles to share, over and over, while the
      // meter reported honest zeroes and the seller wondered why.
      //
      // Still unverified — the watcher has caught the second modal opening but
      // not its contents — but now it cannot match anything outside one.
      // 2026-08-11, watched: `share_poshmark` does not open a followers/party
      // CHOOSER. It opens a plain confirm dialog — `[data-test="modal"]` with a
      // footer holding a tertiary (cancel) and a primary (go ahead), the same
      // shape as the delete confirm on the listing editor. So this selector is
      // that primary button, and the older three stay as fallbacks in case the
      // chooser exists for other accounts.
      //
      // Every alternative names a modal. That rule is enforced by
      // verify-lister-selectors, and it exists because the unscoped version of
      // this selector spent three reports matching the closet's own Followers
      // TAB while looking perfectly healthy.
      shareToFollowers:
        '[data-test="modal-footer"] button.btn--primary, ' +
        '[data-test="modal"] [data-et-name="share_to_followers"], ' +
        '[data-test="modal-body"] a[href*="followers"], ' +
        '[data-test="modal"] button[aria-label*="My Followers"]',
      // The witness for "the action landed" when no toast can be caught: the
      // share modal itself, present before the confirm click and gone after.
      // See confirmed() in poshmark-engage.js for why this is admissible only
      // as a present-then-absent transition.
      confirmGone: '[data-test="listing-share-modal"], .share-modal',
      followButton:
        '[data-et-name="follow"], button.btn--follow, button[aria-label^="Follow"]',
      // "Offer to Likers" on a listing the seller owns.
      offerButton:
        '[data-et-name="offer_to_likers"], button[aria-label*="Offer to Likers"]',
      // Scoped for the same reason as shareToFollowers above. These two are
      // specific enough that they probably would not have matched a closet at
      // rest — but "probably" is exactly what `a[href*="followers"]` had going
      // for it, and the rule is cheaper to keep than to reason about per
      // selector. Both are still unverified: nobody has opened an offer dialog
      // with the watcher armed.
      offerPriceInput:
        '[data-test="modal"] input[data-test="offer-price"], ' +
        '[data-test="modal"] input[name="offerPrice"]',
      offerSubmit:
        '[data-test="modal"] button[data-test="offer-submit"], ' +
        '[data-test="modal"] button[data-et-name="submit_offer"]',
      // Poshmark's own confirmation that one action landed. Without a positive
      // signal the run would count actions it never performed, and the meter
      // would tell the seller they were safe while the real total ran ahead.
      actionConfirmed:
        '[data-test="toast-success"], .toast--success, [data-et-name="shared"]',
      // The pause signal. Broad on purpose — a missed human check means we keep
      // clicking into a wall, which is the single behaviour most likely to get a
      // closet flagged. A FALSE positive just pauses a run the seller resumes.
      humanCheck:
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[title*="challenge"], ' +
        '[data-test="captcha"], [id*="px-captcha"], [class*="captcha"]',
    },
  },

  // ── Mercari — PHASE 2, LIVE since 2026-08-11 ──────────────────────────
  // This heading said "not yet enabled" for a day after the flip, directly
  // above `enabled: true`. Mercari's React SPA rewrites field ids frequently,
  // which is why both halves were held until probed against the live flow —
  // and why a stale "not enabled" here is worth correcting rather than leaving:
  // it is the first thing anyone reads before touching these selectors.
  mercari: {
    // ON as of 2026-08-11. Both halves: every list selector resolved on
    // mercari.com/sell/, and the delist menu resolved on a live listing.
    enabled: true,
    version: "2026.08.1",
    // 2026-08-10: the list flow is verified. All five selectors resolved on
    // mercari.com/sell/, including the renamed title field.
    //
    // Enabling still waits on delist, for the reason spelled out on Grailed
    // below: a channel that can list and cannot end a listing sells one garment
    // to two people. `delist.menu` has only ever been probed from the sell
    // form, where it cannot exist.
    lastVerified: "2026-08-20",
    newListingUrl: "https://www.mercari.com/sell/",
    hosts: ["mercari.com"],
    login: { urlPattern: "mercari\\.com/(signin|login|signup)" },
    liveListingUrlPattern: "^https://[^/]*mercari\\.com/(us/)?item/[^/]+",
    required: ["title", "description", "price", "submit"],
    fields: {
      // 2026-08-10: was `input[name="name"], input[data-testid="Name"]`, and it
      // was the ONLY miss on the live form — description, price, photos and the
      // submit button all resolved. Mercari renamed the field to `sellName`
      // and the test id to `Title`. Ordered most stable first: the test id is
      // the attribute Mercari's own tests depend on, the name/id are the form
      // wiring, and no placeholder anchor is used because that would be
      // English-only for no gain here.
      title: 'input[data-testid="Title"], input[name="sellName"], input#sellName',
      description: 'textarea[name="description"], textarea[data-testid="Description"]',
      price: 'input[name="price"], input[data-testid="Price"]',
      // 2026-08-20: VERIFIED on the live sell form — the deep probe reports
      // this resolving. Leading with data-testid was the right call: Mercari is
      // React and that is the attribute its own tests depend on, the same anchor
      // the title field uses. No placeholder clause, deliberately, since that
      // would be English-only for no gain.
      //
      // Filled by the generic path in runFlow (US-2730), witnessed like price.
      // ONE THING TO WATCH on the first live run: Mercari's brand is a
      // typeahead, so a resolving selector is necessary and may not be
      // sufficient — the value can need the dropdown selection a real keystroke
      // triggers. Poshmark's brand behaved and this is the same shape, but that
      // is precedent, not proof.
      brand:
        'input[data-testid="Brand"], input[data-testid="BrandName"], ' +
        'input[name="brand"], input#brand',
      photoInput: 'input[type="file"][accept*="image"]',
    },
    // CONDITION AND SIZE ARE PICKERS on Mercari - condition is a selection and
    // size a dropdown, reported from the live form 2026-08-20. Same class as
    // Poshmark's four: option lists whose choices vary per category, where a
    // wrong pick is worse than an empty field. Deliberately absent from
    // `fields` rather than declared and left permanently missing, because a
    // selector that can never match reads as a broken channel.
    submit: 'button[data-testid="ListButton"], button[type="submit"]',
    delist: {
      // ON as of 2026-08-11. `menu` — the one selector this flow probes before
      // touching anything — was confirmed on a live listing.
      //
      // What is inside the panel has not been seen. `remove` and `confirm` are
      // therefore checked at the point they should appear, and a miss reports
      // `unverified`: the seller is told to end the listing themselves and the
      // pending-delist stamp stays armed. That is the designed failure, not a
      // gap — a false "delisted" costs a double sale, a false "check this"
      // costs ten seconds.
      enabled: true,
      version: "2026.08.0",
      lastVerified: "2026-08-11",
      // US-1875 AC1: pre-interaction selectors only (see the Poshmark note).
      required: ["menu"],
      // 2026-08-10: `ListingMenu` never existed. The control is the "More"
      // button beside Like and Share — `MoreItemOptions` — and the panel it
      // opens is `ItemOptions`. Both names came from the page's own test
      // attributes; the old selector was a guess that had never been checked
      // against the live item page, which is exactly what enabling is supposed
      // to prevent.
      menu: 'button[data-testid="MoreItemOptions"], button[data-testid="ListingMenu"], ' +
        'button[aria-label*="menu"]',
      // Scoped to the opened panel first, then the loose forms. The wildcard
      // matches are deliberate and safe HERE because `remove` is only ever
      // looked for after `menu` is clicked, and a wrong match fails loudly as
      // `unverified` rather than deleting something else — the panel holds
      // options for this one listing.
      remove: '[data-testid="ItemOptions"] [data-testid*="Delete"], ' +
        '[data-testid="ItemOptions"] [data-testid*="Remove"], ' +
        '[data-testid="Delete"], [data-testid="DeleteListing"]',
      confirm: 'button[data-testid="ConfirmDelete"], button[type="submit"]',
      verify: {
        urlChanged: true,
        gone: 'button[data-testid="MoreItemOptions"], button[data-testid="ListingMenu"]',
        toast: '[data-testid="Toast"], [role="alert"]',
      },
    },
  },

  // ── Grailed — PHASE 3 (LIST enabled; delist deliberately not) ─────────
  //
  // 2026-08-10: the LIST flow is verified. A probe report from
  // grailed.com/sell/new resolved all five selectors, page verdict included.
  // It was switched ON on 2026-08-11 — see the note on the config below.
  //
  // ⚠ 2026-08-21: this heading said "not yet enabled" and the paragraph below
  // said "Still `enabled: false`" for ten days, sitting directly above
  // `enabled: true`. That is the SECOND time in this file: the Mercari block
  // fifty lines up carries the same correction, for the same reason. A comment
  // that contradicts the line it introduces is worse than no comment, because
  // it is the thing a reader trusts when deciding whether a flow is safe to
  // touch — and this one said a channel was off while sellers were listing to
  // it.
  //
  // The original worry is preserved below because it is still the right rule;
  // what changed is that the trade was made knowingly rather than avoided.
  // Turning listing on without a working delist is the oversell in Step 5 of
  // vault/30-platform/closing-a-coverage-gap.md: the item sells elsewhere, the
  // Grailed sibling stays live and purchasable, and the seller owes two people
  // one garment. Grailed escapes that only because the seller is TOLD every
  // time, which is the distinction the config note draws.
  //
  // ⛔ 2026-08-11: GRAILED AUTO-DELIST IS NOT POSSIBLE IN THIS DESIGN, and the
  // reason is not a selector we have failed to find.
  //
  // The seller reports that Grailed's Delete opens a NATIVE BROWSER dialog —
  // `window.confirm`, the one Chrome draws itself — rather than an in-page
  // modal. Nothing running in the page can answer that. It is not a matter of
  // the right selector or a longer wait: a native dialog is drawn by the
  // browser, outside the document, and it BLOCKS the page's JavaScript while it
  // is open. The probe itself hangs on it, which is the same fact from the
  // other end.
  //
  // (An extension could only intercept it by overriding `window.confirm` in the
  // page's own world before the click. That means injecting script into the
  // page context to defeat a confirmation the seller is being shown — a deletion
  // dialog, specifically — and doing it silently. That is not a technique this
  // project uses, and the ADR's bright lines exist for smaller reasons than
  // this one.)
  //
  // So Grailed gets the honest fallback: `delist.enabled` stays false, and when
  // an item sells elsewhere the seller is told to end the Grailed listing
  // themselves. That is US-2165's `delist_unresolved` path — a durable marker
  // plus a notification, one message per sale, and the seller keeps the sale.
  //
  // The earlier note here recorded that the listing page carried no owner
  // control at all. That reading was a cap artefact: 11 of the 20 candidate
  // slots went to the follow-heart on each related listing, all identical but
  // for their id. The dedupe now collapses repeats, so a page like that one
  // reports its own controls. The conclusion did not survive; the fix it
  // prompted did.
  grailed: {
    // ON as of 2026-08-11 for LISTING ONLY, at the seller's decision.
    //
    // `delist.enabled` stays false and always will: Grailed confirms a delete
    // with a NATIVE browser dialog ("Are you sure you want to delete your
    // item?"), which nothing in the page can answer. So an item that sells
    // elsewhere leaves a pending-delist the seller ends by hand — Grailed is
    // still in EXTENSION_DELIST_PLATFORMS precisely so that reminder reaches
    // them, rather than the sibling being forgotten.
    //
    // This is a deliberate trade, not the oversell Step 5 warns about: that one
    // is a channel where the seller is never TOLD. Here they are told every
    // time, and they chose it knowing so.
    enabled: true,
    version: "2026.08.0",
    // The list flow, and only the list flow. Every one of its five selectors
    // was seen to resolve on grailed.com/sell/new.
    lastVerified: "2026-08-10",
    newListingUrl: "https://www.grailed.com/sell/",
    hosts: ["grailed.com"],
    login: { urlPattern: "grailed\\.com/(users/sign_in|login|signup)" },
    liveListingUrlPattern: "^https://[^/]*grailed\\.com/listings/[^/]+",
    required: ["title", "description", "price", "submit"],
    fields: {
      title: 'input[name="title"], input#title',
      description: 'textarea[name="description"], textarea#description',
      price: 'input[name="price"], input#price',
      photoInput: 'input[type="file"][accept*="image"]',
    },
    // 2026-08-11: `.listItem` no longer exists, so this fell through to the bare
    // `button[type="submit"]` — whose first match in document order is the SITE
    // HEADER'S SEARCH BUTTON, not Publish. The probe reported `ok` for a control
    // on a completely different part of the page: a false green, and the exact
    // failure this file's fail-loud contract exists to prevent.
    //
    // Nothing clicks submit (runFlow is always autoSubmit:false), so no seller
    // has been hurt by it. Scoped to the sell form anyway, because a presence
    // probe that can be satisfied by the header is not a presence probe.
    //
    // `.SellForm-Form-Wrapper` is one of the few UNHASHED classes on this page —
    // the buttons themselves carry only `Button-module__button___<hash>`, which
    // is worthless the next time Grailed builds. Two submits live inside that
    // wrapper, "Save as Draft" first and "Publish" second, so this selector must
    // NOT be clicked without disambiguating them by text.
    submit: '.SellForm-Form-Wrapper button[type="submit"], button[type="submit"].listItem',
    delist: {
      enabled: false,
      version: "2026.07.0-draft",
      lastVerified: null,
      // US-1875 AC1: pre-interaction selectors only (see the Poshmark note).
      required: ["menu"],
      menu: 'button[aria-label*="actions"], button.listing-actions',
      remove: 'button[data-action="delete"], a[href*="delete"]',
      confirm: 'button[data-action="confirm-delete"], button[type="submit"]',
      verify: {
        urlChanged: true,
        gone: 'button[aria-label*="actions"], button.listing-actions',
        toast: '[data-role="toast"], [role="alert"]',
      },
    },
  },

  // ── Vinted — PHASE 4 (US-2479) ────────────────────────────────────────
  //
  // Vinted is EU-first and runs ~20 COUNTRY DOMAINS with the same app on each.
  // That is the whole complication: `newListingUrl` is one string everywhere
  // else, and here it depends on which Vinted the seller's account lives on.
  //
  // The answer is `locales` — a map of covered host → its new-listing URL — and
  // NOT "take the domain from the job payload". The whole point of
  // lister-guard's newListingUrlFor is that the navigation target comes from
  // this bundled config and never from a message, so an XSS on a gradethread.com
  // tab cannot steer the extension anywhere. A locale KEY from the payload is
  // fine; a URL is not. An uncovered locale resolves to null and the seller is
  // told to list manually, naming the domain — never a guess at a form on a
  // domain we have not verified (US-2479 AC2).
  vinted: {
    // ON as of 2026-08-11 for LISTING ONLY, at the seller's decision.
    //
    // All five list selectors resolved on www.vinted.com/items/new, page verdict
    // included. That is ONE locale of the 22 below, and it is the honest limit of
    // what has been checked: the app is the same on every country domain, so the
    // rest are a reasoned expectation rather than a verified fact. They fail loud
    // if that expectation is wrong — a missing required selector aborts before
    // anything is typed, and the seller is told to list by hand.
    //
    // `delist.enabled` stays false, and unlike Grailed that is a GAP, not a wall.
    // The delist probe has only ever run on a page that was not one of the
    // seller's own live listings, where `menu` cannot exist, so its miss proves
    // nothing either way. Re-probe from a live Vinted listing to settle it.
    enabled: true,
    version: "2026.08.0",
    // The list flow, on vinted.com, and nothing else.
    lastVerified: "2026-08-11",
    // The default target when the job names no locale. vinted.com is the
    // smallest of these markets, but defaulting to a European one would silently
    // send US sellers somewhere their account does not exist.
    newListingUrl: "https://www.vinted.com/items/new",
    locales: {
      "vinted.com": "https://www.vinted.com/items/new",
      "vinted.co.uk": "https://www.vinted.co.uk/items/new",
      "vinted.fr": "https://www.vinted.fr/items/new",
      "vinted.de": "https://www.vinted.de/items/new",
      "vinted.es": "https://www.vinted.es/items/new",
      "vinted.it": "https://www.vinted.it/items/new",
      "vinted.nl": "https://www.vinted.nl/items/new",
      "vinted.pl": "https://www.vinted.pl/items/new",
      "vinted.be": "https://www.vinted.be/items/new",
      "vinted.at": "https://www.vinted.at/items/new",
      "vinted.cz": "https://www.vinted.cz/items/new",
      "vinted.sk": "https://www.vinted.sk/items/new",
      "vinted.lt": "https://www.vinted.lt/items/new",
      "vinted.pt": "https://www.vinted.pt/items/new",
      "vinted.se": "https://www.vinted.se/items/new",
      "vinted.ro": "https://www.vinted.ro/items/new",
      "vinted.hu": "https://www.vinted.hu/items/new",
      "vinted.lu": "https://www.vinted.lu/items/new",
      "vinted.hr": "https://www.vinted.hr/items/new",
      "vinted.gr": "https://www.vinted.gr/items/new",
      "vinted.dk": "https://www.vinted.dk/items/new",
      "vinted.fi": "https://www.vinted.fi/items/new",
    },
    // Every host a Vinted listing URL may live on — the delist guard's allowlist.
    // Derived from the same set as `locales` and kept identical by
    // test/vinted-locales.test.cjs, so a locale can never be listable-but-not-
    // delistable (which would leave a live listing after a sale elsewhere).
    hosts: [
      "vinted.com", "vinted.co.uk", "vinted.fr", "vinted.de", "vinted.es",
      "vinted.it", "vinted.nl", "vinted.pl", "vinted.be", "vinted.at",
      "vinted.cz", "vinted.sk", "vinted.lt", "vinted.pt", "vinted.se",
      "vinted.ro", "vinted.hu", "vinted.lu", "vinted.hr", "vinted.gr",
      "vinted.dk", "vinted.fi",
    ],
    login: { urlPattern: "vinted\\.[a-z.]+/(member/general/login|signup)" },
    // Vinted item URLs are /items/<id>-<slug> on every locale. Anchored so the
    // /items/new page we opened cannot match itself.
    liveListingUrlPattern: "^https://[^/]*vinted\\.[a-z.]+/items/\\d+",
    required: ["title", "description", "price", "submit"],
    fields: {
      title: 'input#title, input[name="title"], input[data-testid="item-title--input"]',
      description:
        'textarea#description, textarea[name="description"], textarea[data-testid="item-description--input"]',
      price: 'input#price, input[name="price"], input[data-testid="item-price--input"]',
      photoInput: 'input[type="file"][accept*="image"]',
    },
    submit:
      'button[data-testid="upload-form-save-button"], button#upload-form-save-button, button[type="submit"]',
    delist: {
      // OFF, and the selectors below are UNCHECKED guesses — not a verdict on
      // them. The 2026-08-11 probe reported `menu` missing from a page that was
      // not one of the seller's own live listings, which is the one page where
      // that control cannot exist. A miss there is not evidence.
      //
      // Until it is probed from a real live listing this is a gap, and the gap
      // is covered the same way Grailed's permanent one is: Vinted stays in
      // EXTENSION_DELIST_PLATFORMS, so a Vinted copy of something that sells
      // elsewhere gets a pending-delist marker and a reminder rather than being
      // silently left live.
      enabled: false,
      version: "2026.08.0-draft",
      lastVerified: null,
      // Pre-interaction selectors only (see the Poshmark note) — `remove` lives
      // inside the item's action menu and does not exist until it is opened.
      required: ["menu"],
      menu:
        'button[data-testid="item-action-menu"], button[aria-label*="More"], button.item-actions',
      remove: '[data-testid="item-delete"], button[data-testid="delete-item"], a[href*="delete"]',
      confirm:
        'button[data-testid="modal-confirm-button"], button[data-testid="item-delete-confirm"], button[type="submit"]',
      verify: {
        urlChanged: true,
        gone: 'button[data-testid="item-action-menu"], button.item-actions',
        toast: '[data-testid="notification"], [role="alert"]',
      },
    },
  },

  // ── Facebook Marketplace — PHASE 5 (US-2480, not yet enabled) ─────────
  //
  // The highest-traffic channel and the hardest to keep working. Marketplace's
  // markup is machine-generated: class names are hashed and change on every
  // deploy, so a class selector here is worthless within days. Everything below
  // is anchored on ARIA and roles — the attributes Meta's own accessibility
  // requirements stop them from churning — and the flow's fail-loud abort matters
  // more here than anywhere else, because this is the form most likely to have
  // moved since the last verification.
  //
  // Marketplace is also the one channel where "just submit it" is wrong: the
  // create flow is a multi-step dialog with a required category and condition,
  // so the seller finishes it. We prefill what is unambiguous and stop.
  //
  // ⛔ 2026-08-11: THE ARIA PLAN DOES NOT WORK ON THE LIVE FORM. Read this
  // before spending an afternoon on better aria-label spellings.
  //
  // Probed on facebook.com/marketplace/create/item, signed in, form rendered:
  // `photoInput` and `submit` resolve. `title`, `price` and `description` all
  // miss — and not because the label text differs. Those three inputs carry NO
  // ACCESSIBLE NAME AT ALL: no `aria-label`, no `aria-labelledby`, no
  // `placeholder`, no wrapping `<label>`. There is nothing for a spelling
  // variant to match, so every alternative below is dead for the same reason.
  //
  // The premise above — that Meta's own accessibility requirements stop these
  // attributes churning — turned out to assume the attributes were there. On
  // the fields that matter they are not. The selectors are LEFT AS THEY ARE
  // rather than replaced with a positional guess ("the second text input in the
  // form"), because a positional selector on machine-generated markup is the one
  // thing worse than no selector: it keeps matching after the form changes, and
  // it types a price into whatever now sits in that position.
  //
  // Whoever picks Phase 5 up needs a different handle entirely. Until then this
  // stays `enabled: false` and reports "list manually", which is correct.
  facebook: {
    enabled: false,
    version: "2026.08.0-draft",
    lastVerified: null,
    newListingUrl: "https://www.facebook.com/marketplace/create/item",
    hosts: ["facebook.com", "fb.com"],
    login: { urlPattern: "facebook\\.com/(login|checkpoint|recover)" },
    // A live Marketplace listing is /marketplace/item/<numeric id>. Anchored so
    // /marketplace/create/item can never match itself.
    liveListingUrlPattern: "^https://[^/]*facebook\\.com/marketplace/item/\\d+",
    required: ["title", "price", "submit"],
    fields: {
      // ⚠️ These three MISS on the live form — see the block above. They are
      // kept because they cost nothing while the channel is disabled and they
      // still describe the shape we would want; they are not a working config.
      title:
        'input[aria-label="Title"], input[aria-label*="Title"], label[aria-label="Title"] input',
      price:
        'input[aria-label="Price"], input[aria-label*="Price"], label[aria-label="Price"] input',
      description:
        'textarea[aria-label="Description"], textarea[aria-label*="Description"], label[aria-label="Description"] textarea',
      photoInput: 'input[type="file"][accept*="image"]',
    },
    // "Next" on the first step of the create dialog, not a final publish — the
    // seller picks category/condition and publishes. Deliberate: auto-publishing
    // an incomplete Marketplace listing gets it removed and the account flagged.
    submit:
      'div[aria-label="Next"][role="button"], div[aria-label="Publish"][role="button"], button[type="submit"]',
    delist: {
      enabled: false,
      version: "2026.08.0-draft",
      lastVerified: null,
      required: ["menu"],
      menu:
        'div[aria-label="More options"][role="button"], div[aria-label*="More"][role="button"], [aria-label="Actions for this listing"]',
      remove:
        'div[role="menuitem"][aria-label*="Delete"], div[role="menuitem"][aria-label*="Remove"]',
      confirm:
        'div[aria-label="Delete"][role="button"], div[aria-label="Confirm"][role="button"], button[type="submit"]',
      verify: {
        urlChanged: true,
        gone: 'div[aria-label="More options"][role="button"]',
        toast: '[role="alert"], [aria-live="assertive"]',
      },
    },
  },
};

// Expose to the other content scripts in this isolated world.
self.GT_LISTER_SELECTORS = GT_LISTER_SELECTORS;
