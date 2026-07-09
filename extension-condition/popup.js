// GradeThread Condition Check — popup (US-1755)
//
// Shows the buyer's recent reads, the auto-run + per-site toggles, and a
// sign-in / connect link (attributed to the extension funnel via utm params).

const SITE = "https://gradethread.com";

function scoreClass(score) {
  if (score >= 9) return "s-excellent";
  if (score >= 7) return "s-good";
  if (score >= 5) return "s-fair";
  if (score >= 3) return "s-poor";
  return "s-bad";
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

async function activeHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) return new URL(tab.url).host;
  } catch (_e) { /* no activeTab access */ }
  return null;
}

async function renderReads() {
  const ul = document.getElementById("reads");
  const { recentReads } = await chrome.storage.local.get("recentReads");
  const list = Array.isArray(recentReads) ? recentReads : [];
  if (!list.length) return; // keep the empty-state <li> from the HTML
  ul.textContent = "";
  for (const r of list) {
    const li = document.createElement("li");
    li.className = "pop-read";
    const a = document.createElement("a");
    a.href = r.url || SITE;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    const score = document.createElement("span");
    score.className = "pop-read-score " + scoreClass(Number(r.overallScore));
    score.textContent = Number(r.overallScore).toFixed(1);

    const body = document.createElement("span");
    body.className = "pop-read-body";
    const title = document.createElement("div");
    title.className = "pop-read-title";
    title.textContent = r.title || "eBay listing";
    const meta = document.createElement("div");
    meta.className = "pop-read-meta";
    meta.textContent = (r.gradeTier ? r.gradeTier + " · " : "") + timeAgo(Number(r.at) || Date.now());
    body.appendChild(title);
    body.appendChild(meta);

    a.appendChild(score);
    a.appendChild(body);
    li.appendChild(a);
    ul.appendChild(li);
  }
}

async function initSettings() {
  const { autoRun, disabledHosts } = await chrome.storage.local.get(["autoRun", "disabledHosts"]);
  const disabled = Array.isArray(disabledHosts) ? disabledHosts : [];

  const autoEl = document.getElementById("autoRun");
  autoEl.checked = Boolean(autoRun);
  autoEl.addEventListener("change", () => {
    chrome.storage.local.set({ autoRun: autoEl.checked });
  });

  const host = await activeHost();
  if (host && /(^|\.)ebay\./.test(host)) {
    const wrap = document.getElementById("siteToggleWrap");
    const label = document.getElementById("siteToggleLabel");
    const box = document.getElementById("siteEnabled");
    wrap.hidden = false;
    label.textContent = "Enabled on " + host;
    box.checked = !disabled.includes(host);
    box.addEventListener("change", async () => {
      const cur = (await chrome.storage.local.get("disabledHosts")).disabledHosts || [];
      const set = new Set(Array.isArray(cur) ? cur : []);
      if (box.checked) set.delete(host);
      else set.add(host);
      await chrome.storage.local.set({ disabledHosts: Array.from(set) });
    });
  }
}

function initLinks() {
  const signin = document.getElementById("signin");
  signin.href = SITE + "/login?utm_source=extension&utm_medium=popup&utm_campaign=condition-check";
  const privacy = document.getElementById("privacy");
  privacy.href = SITE + "/privacy?utm_source=extension&utm_medium=popup";
  const version = document.getElementById("version");
  const manifest = chrome.runtime.getManifest();
  version.textContent = "v" + manifest.version;
}

(async function () {
  initLinks();
  await Promise.all([renderReads(), initSettings()]);
})();
