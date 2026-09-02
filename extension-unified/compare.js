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

function listingCell(row, entry) {
  const td = document.createElement("td");
  td.className = "cmp-listing";

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

  td.appendChild(body);
  row.appendChild(td);
}

function render(list, sortBy) {
  const table = document.getElementById("table");
  const empty = document.getElementById("empty");
  const note = document.getElementById("note");
  const tbody = document.getElementById("rows");
  tbody.textContent = "";

  if (!list.length) {
    table.hidden = true;
    note.hidden = true;
    empty.hidden = false;
    empty.textContent = TRAY.STRINGS.empty;
    return;
  }
  empty.hidden = true;
  table.hidden = false;
  note.hidden = false;

  for (const entry of TRAY.sortRows(list, sortBy)) {
    const row = document.createElement("tr");
    listingCell(row, entry);

    // scoreLabel is the single NaN gate: a stored non-finite score renders as an
    // em dash, never as "NaN" (US-1884 AC5, same rule as the overlay).
    const score = cell(row, TRAY.scoreLabel(entry), "cmp-score " + TRAY.scoreClass(entry.overallScore));
    score.setAttribute("data-score", TRAY.scoreLabel(entry));

    cell(
      row,
      entry.confidence == null ? "—" : Math.round(entry.confidence * 100) + "%",
      "cmp-num",
    );

    const priceTd = cell(row, entry.priceText || TRAY.STRINGS.noPrice, "cmp-num");
    const fair = TRAY.fairnessLabel(entry);
    if (fair) {
      const tag = document.createElement("div");
      tag.className = "cmp-fair cmp-fair-" + entry.fairness;
      tag.textContent = fair;
      priceTd.appendChild(tag);
    }

    cell(row, entry.imagesAnalyzed == null ? "—" : String(entry.imagesAnalyzed), "cmp-num");

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
})();
