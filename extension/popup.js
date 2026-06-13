// GradeThread Lister — popup (status + clickwrap consent, US-716 / US-377 pattern)

function platformRows() {
  // Mirror of selectors.js (the popup can't import the content-script global),
  // kept intentionally tiny: just what the status list needs.
  return [
    { key: "poshmark", label: "Poshmark", enabled: true, phase: "Phase 1" },
    { key: "mercari", label: "Mercari", enabled: false, phase: "Phase 2" },
    { key: "grailed", label: "Grailed", enabled: false, phase: "Phase 3" },
  ];
}

function renderVersion() {
  const m = chrome.runtime.getManifest();
  document.getElementById("ext-version").textContent = "v" + m.version;
}

function renderPlatforms() {
  const ul = document.getElementById("platforms");
  ul.innerHTML = "";
  for (const p of platformRows()) {
    const li = document.createElement("li");
    const left = document.createElement("div");
    left.innerHTML =
      '<div class="name">' + p.label + "</div>" +
      '<div class="meta">' + p.phase + "</div>";
    const badge = document.createElement("span");
    badge.className = "badge " + (p.enabled ? "on" : "off");
    badge.textContent = p.enabled ? "Enabled" : "Coming soon";
    li.appendChild(left);
    li.appendChild(badge);
    ul.appendChild(li);
  }
}

async function renderConsent() {
  const out = await chrome.storage.local.get("tosAcceptedAt");
  const accepted = out && out.tosAcceptedAt;
  const note = document.getElementById("accepted-note");
  const check = document.getElementById("tos-check");
  const btn = document.getElementById("accept");
  if (accepted) {
    note.hidden = false;
    note.textContent = "Terms accepted " + new Date(accepted).toLocaleDateString() + ".";
    check.checked = true;
    btn.textContent = "Terms accepted";
    btn.disabled = true;
  } else {
    note.hidden = true;
    btn.disabled = !check.checked;
  }
}

function wire() {
  const check = document.getElementById("tos-check");
  const btn = document.getElementById("accept");
  check.addEventListener("change", async function () {
    const out = await chrome.storage.local.get("tosAcceptedAt");
    if (!out.tosAcceptedAt) btn.disabled = !check.checked;
  });
  btn.addEventListener("click", async function () {
    if (!check.checked) return;
    await chrome.storage.local.set({ tosAcceptedAt: new Date().toISOString() });
    renderConsent();
  });
}

renderVersion();
renderPlatforms();
renderConsent();
wire();
