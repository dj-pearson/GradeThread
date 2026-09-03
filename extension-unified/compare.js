// GradeThread unified extension — the compare view (US-2240)
//
// Renders the pinned tray as a side-by-side table. ENTIRELY from storage: no
// fetch, no message round trip for data, no re-grade. Every figure here was
// returned by the endpoint at the moment the shopper pinned it, which is the
// point — a row that quietly refreshed itself would no longer be the thing they
// were comparing.

const ext = globalThis.browser || globalThis.chrome;
const TRAY = self.GT_CC_TRAY;

const MARKETPLACE_LABEL = {
  ebay: "eBay",
  poshmark: "Poshmark",
  grailed: "Grailed",
  mercari: "Mercari",
  depop: "Depop",
  vinted: "Vinted",
};

async function readTray() {
  try {
    const out = await ext.storage.local.get(TRAY.KEY);
    const list = (out && out[TRAY.KEY]) || [];
    return Array.isArray(list) ? list : [];
  } catch (_e) {
    return [];
  }
}

async function writeTray(list) {
  try {
    await ext.storage.local.set({ [TRAY.KEY]: list });
  } catch (_e) { /* storage unavailable — the view still reflects what we have */ }
}

function cell(row, text, cls) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  if (text != null) td.textContent = text;
  row.appendChild(td);
  return td;
}

function listingCell(row, entry, isBest) {
  const td = document.createElement("td");
  td.className = "cmp-listing";
  td.dataset.label = "Listing";

  if (entry.thumbUrl) {
    const img = document.createElement("img");
    img.className = "cmp-thumb";
    img.src = entry.thumbUrl;
    img.alt = "";
    // The thumbnail is a marketplace CDN URL that was on the page already. If it
    // 404s or is hotlink-blocked, drop it rather than leaving a broken-image box
    // in the middle of the comparison.
    img.addEventListener("error", () => img.remove());
    td.appendChild(img);
  }

  const body = document.createElement("div");
  const link = document.createElement("a");
  link.href = entry.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = entry.title || "Listing";
  link.className = "cmp-listing-title";
  body.appendChild(link);

  const meta = document.createElement("div");
  meta.className = "cmp-listing-meta";
  const parts = [MARKETPLACE_LABEL[entry.marketplace] || entry.marketplace];
  if (entry.seller) parts.push(entry.seller);
  if (entry.gradeTier) parts.push(entry.gradeTier);
  meta.textContent = parts.filter(Boolean).join(" · ");
  body.appendChild(meta);
  // US-3056: the row worth buying. A tag on the listing cell, not a colour on
  // the row, so it reads the same in a stacked card.
  if (isBest) {
    const tag = document.createElement("span");
    tag.className = "cmp-best";
    tag.textContent = TRAY.STRINGS.bestValue;
    body.appendChild(tag);
  }

  td.appendChild(body);
  row.appendChild(td);
}

function render(list, sortBy) {
  const table = document.getElementById("table");
  const empty = document.getElementById("empty");
  const note = document.getElementById("note");
  const bestNote = document.getElementById("bestNote");
  const copy = document.getElementById("copy");
  const tbody = document.getElementById("rows");
  const attribution = document.getElementById("attribution");
  tbody.textContent = "";
  if (attribution) attribution.textContent = "";

  if (!list.length) {
    table.hidden = true;
    note.hidden = true;
    if (copy) copy.hidden = true;
    empty.hidden = false;
    empty.textContent = TRAY.STRINGS.empty;
    return;
  }
  empty.hidden = true;
  table.hidden = false;
  note.hidden = false;
  if (copy) copy.hidden = false;

  // US-3112: attribution for the marketplaces actually on the table, rebuilt on
  // every render because the tray changes underneath it. Driven by the pinned
  // rows rather than hard-coded, so clearing the last eBay row also clears
  // eBay's notice instead of leaving a claim about data no longer shown.
  if (attribution && self.GT_MP_NOTICE) {
    const notices = self.GT_MP_NOTICE.noticesForMarketplaces(
      list.map((e) => e.marketplace),
    );
    for (const text of notices) {
      const p = document.createElement("p");
      p.textContent = text;
      attribution.appendChild(p);
    }
  }

  // US-3056: the best condition per dollar, over rows with a score AND a price.
  const bestKey = TRAY.bestValueKey(list);
  const unpriced = list.filter((e) => TRAY.priceCents(e) === null).length;
  if (bestNote) {
    bestNote.textContent = bestKey
      ? " Best value is the highest grade per dollar among the rows with a price" +
        (unpriced ? "; " + unpriced + " row" + (unpriced === 1 ? " has" : "s have") + " no price read and sit out." : ".")
      : unpriced === list.length
        ? " No row has a price read, so there is no best value to mark."
        : "";
  }

  for (const entry of TRAY.sortRows(list, sortBy)) {
    const row = document.createElement("tr");
    if (entry.key === bestKey) row.className = "cmp-row-best";
    listingCell(row, entry, entry.key === bestKey);

    // scoreLabel is the single NaN gate: a stored non-finite score renders as an
    // em dash, never as "NaN" (US-1884 AC5, same rule as the overlay).
    const score = cell(row, TRAY.scoreLabel(entry), "cmp-score " + TRAY.scoreClass(entry.overallScore));
    score.setAttribute("data-score", TRAY.scoreLabel(entry));
    score.dataset.label = "Condition";

    cell(
      row,
      entry.confidence == null ? "—" : Math.round(entry.confidence * 100) + "%",
      "cmp-num",
    ).dataset.label = "Confidence";

    const priceTd = cell(row, entry.priceText || TRAY.STRINGS.noPrice, "cmp-num");
    priceTd.dataset.label = "Price";
    const fair = TRAY.fairnessLabel(entry);
    if (fair) {
      const tag = document.createElement("div");
      tag.className = "cmp-fair cmp-fair-" + entry.fairness;
      tag.textContent = fair;
      priceTd.appendChild(tag);
    } else if (TRAY.priceCents(entry) === null) {
      const tag = document.createElement("div");
      tag.className = "cmp-fair cmp-fair-fair";
      tag.textContent = TRAY.STRINGS.noPriceNote;
      priceTd.appendChild(tag);
    }

    cell(row, entry.imagesAnalyzed == null ? "—" : String(entry.imagesAnalyzed), "cmp-num").dataset.label = "Photos";

    const actions = document.createElement("td");
    const unpin = document.createElement("button");
    unpin.type = "button";
    unpin.className = "cmp-linkbtn";
    unpin.textContent = TRAY.STRINGS.unpin;
    unpin.addEventListener("click", async () => {
      const next = TRAY.remove(await readTray(), entry.key);
      await writeTray(next);
      render(next, document.getElementById("sort").value);
    });
    actions.appendChild(unpin);
    row.appendChild(actions);

    tbody.appendChild(row);
  }
}

(async function () {
  void self.GT_THEME.init(ext, document); // US-3055
  const sort = document.getElementById("sort");
  let list = await readTray();
  render(list, sort.value);

  sort.addEventListener("change", () => render(list, sort.value));

  document.getElementById("clear").addEventListener("click", async () => {
    list = [];
    await writeTray(list);
    render(list, sort.value);
  });

  // US-3056: the tray as text, in the sort order on screen. Clipboard only —
  // nothing leaves the device until the shopper pastes it somewhere.
  const copy = document.getElementById("copy");
  copy.addEventListener("click", async () => {
    const text = TRAY.summaryText(TRAY.sortRows(list, sort.value), MARKETPLACE_LABEL);
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = TRAY.STRINGS.copied;
    } catch (_e) {
      copy.textContent = TRAY.STRINGS.copyFailed;
    }
    setTimeout(() => { copy.textContent = TRAY.STRINGS.copySummary; }, 1800);
  });
})();
