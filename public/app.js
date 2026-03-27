const latestContainer = document.getElementById("latestContainer");
const historyContainer = document.getElementById("historyContainer");
const updatedAt = document.getElementById("updatedAt");
const refreshBtn = document.getElementById("refreshBtn");
const statLeague = document.getElementById("statLeague");
const statRuns = document.getElementById("statRuns");
const statLatestTime = document.getElementById("statLatestTime");
const viewLatestBtn = document.getElementById("viewLatestBtn");
const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
const pageBlocks = Array.from(document.querySelectorAll(".panel-block"));
const navBurger = document.getElementById("navBurger");
const navDrawer = document.getElementById("navDrawer");
const refreshBtnMobile = document.getElementById("refreshBtnMobile");
const topbar = document.getElementById("topbar");
const allowedPages = new Set(["overview", "predictions", "history"]);
const revealTargets = Array.from(
  document.querySelectorAll(
    ".hero-body, .league-strip, .band-inner, .section-head, .site-footer .footer-inner"
  )
);
let latestPrediction = null;
let predictionHistory = [];
let selectedPredictionId = null;
let revealObserver = null;

function setPage(page, updateHash = true) {
  const targetPage = allowedPages.has(page) ? page : "overview";

  for (const btn of tabButtons) {
    btn.classList.toggle("is-active", btn.dataset.page === targetPage);
  }

  for (const block of pageBlocks) {
    const pages = (block.dataset.pages || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    block.hidden = !pages.includes(targetPage);
  }

  document.body.classList.remove("page-overview", "page-predictions", "page-history");
  document.body.classList.add(`page-${targetPage}`);

  if (updateHash) {
    history.replaceState(null, "", `#${targetPage}`);
  }

  closeMobileNav();
}

function closeMobileNav() {
  if (!navDrawer || !navBurger) return;
  navDrawer.classList.remove("is-open");
  navBurger.classList.remove("is-open");
}

function revealElement(element) {
  if (!element) return;
  element.classList.add("is-visible");
}

function initRevealObserver() {
  if (!("IntersectionObserver" in window)) {
    for (const element of revealTargets) {
      revealElement(element);
    }
    return;
  }

  revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        revealElement(entry.target);
        revealObserver.unobserve(entry.target);
      }
    },
    {
      threshold: 0.12,
      rootMargin: "0px 0px -8% 0px"
    }
  );

  for (const element of revealTargets) {
    revealObserver.observe(element);
  }
}

function fmtDate(iso) {
  if (!iso) return "Unknown";
  return new Date(iso).toLocaleString();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripMarkdown(text) {
  return String(text || "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .trim();
}

function normalizeSectionHeader(text) {
  return stripMarkdown(String(text || ""))
    .replace(/^#+\s*/, "")
    .replace(/:\s*$/, "")
    .trim();
}

function parseModelPickList(rawMessage) {
  if (!rawMessage || typeof rawMessage !== "string") return null;

  const lines = rawMessage.split("\n");
  const picks = [];
  let current = null;

  function commitCurrent() {
    if (!current || !current.matchup) return;
    picks.push(current);
  }

  for (const rawLine of lines) {
    const trimmed = stripMarkdown(rawLine.trim());
    if (!trimmed) continue;

    const gameMatch = trimmed.match(/^\d+[.)]\s*Game:\s*(.+)$/i);
    if (gameMatch) {
      commitCurrent();
      current = {
        matchup: gameMatch[1].trim(),
        pick: "",
        confidence: "",
        details: []
      };
      continue;
    }

    if (!current) continue;

    const pickMatch = trimmed.match(/^Pick:\s*(.+)$/i);
    if (pickMatch) {
      current.pick = pickMatch[1].trim();
      continue;
    }

    const confidenceMatch = trimmed.match(/^(Confidence|Model Probability):\s*(.+)$/i);
    if (confidenceMatch) {
      current.confidence = confidenceMatch[2].trim();
      continue;
    }

    const detailMatch = trimmed.match(/^([^:]+):\s*(.+)$/);
    if (detailMatch) {
      current.details.push({
        label: detailMatch[1].trim(),
        value: detailMatch[2].trim()
      });
      continue;
    }

    current.details.push({ label: "", value: trimmed });
  }

  commitCurrent();
  return picks.length ? picks : null;
}

function parseSections(rawMessage) {
  if (!rawMessage || typeof rawMessage !== "string") return null;

  const sectionOrder = [
    "Safe Bets",
    "Best Value Bets",
    "Long Shots",
    "2-Leg Parlays",
    "3-Leg Parlays",
    "Risk Notes"
  ];

  const sections = new Map(sectionOrder.map((name) => [name, []]));
  let currentSection = null;
  const lines = rawMessage.split("\n");

  for (const rawLine of lines) {
    const trimmedRaw = rawLine.trim();
    const line = stripMarkdown(trimmedRaw);
    if (!line) continue;

    const header = normalizeSectionHeader(trimmedRaw).match(
      /^(Safe Bets|Best Value Bets|Long Shots|2-Leg Parlays|3-Leg Parlays|Risk Notes)\b/i
    );

    if (header) {
      const normalized = sectionOrder.find(
        (s) => s.toLowerCase() === header[1].toLowerCase()
      );
      currentSection = normalized || null;
      continue;
    }

    if (!currentSection) continue;

    const isBulletContinuation = /^[-*]\s+/.test(trimmedRaw);
    const cleaned = stripMarkdown(line.replace(/^\d+[.)]\s*/, "").replace(/^[-*]\s*/, ""));
    const items = sections.get(currentSection);

    if (isBulletContinuation && items.length > 0) {
      const previous = items[items.length - 1];
      items[items.length - 1] = `${previous} | Reason: ${cleaned}`;
      continue;
    }

    items.push(cleaned);
  }

  const hasAny = Array.from(sections.values()).some((items) => items.length > 0);
  return hasAny ? sections : null;
}

function renderSectionCards(rawMessage) {
  const modelPickList = parseModelPickList(rawMessage);
  if (modelPickList) {
    return `
      <div class="pick-card-grid pick-card-grid-model">
        ${modelPickList
          .map(
            (pick) => `
            <article class="pick-card pick-card-model">
              <div class="pick-card-top">
                <p class="pick-card-matchup">${escapeHtml(pick.matchup)}</p>
                ${pick.confidence ? `<span class="pick-card-chip">${escapeHtml(pick.confidence)}</span>` : ""}
              </div>
              ${pick.pick ? `<p class="pick-card-pick">Pick: <span>${escapeHtml(pick.pick)}</span></p>` : ""}
              <div class="pick-card-details">
                ${pick.details
                  .map((detail) =>
                    detail.label
                      ? `<p class="pick-card-reason"><strong>${escapeHtml(detail.label)}:</strong> ${escapeHtml(detail.value)}</p>`
                      : `<p class="pick-card-reason">${escapeHtml(detail.value)}</p>`
                  )
                  .join("")}
              </div>
            </article>
          `
          )
          .join("")}
      </div>
    `;
  }

  const sections = parseSections(rawMessage);
  if (!sections) {
    return `<pre class="raw">${escapeHtml(rawMessage)}</pre>`;
  }

  function renderItemRow(item) {
    const parts = item.split("|").map((p) => p.trim());
    const pick = parts[0] || item;
    const confidencePart = parts.find((p) => /^(confidence|model probability):/i.test(p)) || "";
    const confidence = confidencePart.replace(/^(confidence|model probability):\s*/i, "").trim();
    const confidenceLabel = confidence
      ? confidence.includes("%")
        ? confidence
        : `${confidence}%`
      : "";
    const details = parts
      .filter((p) => p !== pick && p !== confidencePart)
      .map((part) => {
        const match = part.match(/^([^:]+):\s*(.*)$/);
        return match
          ? { label: match[1].trim(), value: match[2].trim() }
          : { label: "", value: part.trim() };
      })
      .filter((detail) => detail.value);

    return `
      <li class="pick-row">
        <div class="pick-main-row">
          <div class="pick-main">${escapeHtml(pick)}</div>
          ${confidenceLabel ? `<span class="pill">${escapeHtml(confidenceLabel)}</span>` : ""}
        </div>
        ${
          details.length
            ? `<div class="pick-meta">${details
                .map((detail) =>
                  detail.label
                    ? `<p class="reason"><strong>${escapeHtml(detail.label)}:</strong> ${escapeHtml(detail.value)}</p>`
                    : `<p class="reason">${escapeHtml(detail.value)}</p>`
                )
                .join("")}</div>`
            : ""
        }
      </li>
    `;
  }

  const allItems = [];
  for (const [title, items] of sections.entries()) {
    if (items.length === 0) continue;
    for (const item of items) {
      allItems.push({
        title,
        item
      });
    }
  }

  if (allItems.length === 0) {
    return `<pre class="raw">${escapeHtml(rawMessage)}</pre>`;
  }

  return `
    <article class="section-card section-wide">
      <h3>Model Picks</h3>
      <ul>
        ${allItems.map(({ item }) => renderItemRow(item)).join("")}
      </ul>
    </article>
  `;
}

function renderLatest(latest) {
  if (!latest) {
    latestContainer.innerHTML = '<div class="empty">No predictions yet.</div>';
    return;
  }

  const picksHtml = (latest.games || [])
    .map(
      (g) => `
      <article class="pick-card">
        <div class="pick-card-top">
          <p class="pick-card-matchup">${escapeHtml(g.matchup || "Unknown matchup")}</p>
          <span class="pick-card-chip">${escapeHtml(g.confidence || "N/A")}</span>
        </div>
        <p class="pick-card-pick">Pick: ${escapeHtml(g.pick || "N/A")}${g.odds ? ` <span>${escapeHtml(g.odds)}</span>` : ""}</p>
        ${g.reason ? `<p class="pick-card-reason">${escapeHtml(g.reason)}</p>` : ""}
      </article>
    `
    )
    .join("");

  latestContainer.innerHTML = `
    <article class="latest-card">
      <div class="latest-meta">
        <span><strong>${escapeHtml(latest.title || "Latest Run")}</strong></span>
        <span>League: ${escapeHtml(latest.league || "Mixed")}</span>
        <span>Created: ${escapeHtml(fmtDate(latest.createdAt))}</span>
      </div>
      <div class="latest-body">
        ${latest.aiSummary ? `<div class="summary-box"><p>${escapeHtml(latest.aiSummary)}</p></div>` : ""}
        ${picksHtml ? `<div class="pick-card-grid">${picksHtml}</div>` : ""}
        ${latest.rawMessage ? renderSectionCards(latest.rawMessage) : ""}
      </div>
    </article>
  `;
}

function renderHistory(history, selectedId = null) {
  if (!Array.isArray(history) || history.length === 0) {
    historyContainer.innerHTML = '<div class="empty">No run history yet.</div>';
    return;
  }

  historyContainer.innerHTML = history
    .map(
      (item) => `
        <button class="history-item${item.id === selectedId ? " is-active" : ""}" type="button" data-history-id="${item.id}">
          <span>${item.title} (${item.league || "Mixed"})</span>
          <span>${fmtDate(item.createdAt)}</span>
        </button>
      `
    )
    .join("");
}

function setSelectedPrediction(id) {
  const target = predictionHistory.find((entry) => entry.id === id);
  if (!target) return;

  selectedPredictionId = id;
  renderLatest(target);
  renderHistory(predictionHistory, selectedPredictionId);
  viewLatestBtn.hidden = latestPrediction && selectedPredictionId === latestPrediction.id;
  setPage("predictions");
}

function showLatestPrediction() {
  selectedPredictionId = latestPrediction?.id || null;
  renderLatest(latestPrediction);
  renderHistory(predictionHistory, selectedPredictionId);
  viewLatestBtn.hidden = true;
}

async function load() {
  try {
    const res = await fetch("/api/predictions");
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    latestPrediction = data.latest || null;
    predictionHistory = Array.isArray(data.history) ? data.history : [];

    if (!selectedPredictionId || !predictionHistory.some((entry) => entry.id === selectedPredictionId)) {
      selectedPredictionId = latestPrediction?.id || null;
    }

    const selectedPrediction = predictionHistory.find((entry) => entry.id === selectedPredictionId) || latestPrediction;
    renderLatest(selectedPrediction);
    renderHistory(predictionHistory, selectedPredictionId);
    viewLatestBtn.hidden = !latestPrediction || selectedPredictionId === latestPrediction.id;
    latestContainer.classList.add("is-visible");
    historyContainer.classList.add("is-visible");
    updatedAt.textContent = data.updatedAt
      ? `Last updated ${fmtDate(data.updatedAt)}`
      : "Waiting for first prediction run...";
    statLeague.textContent = data.latest?.league || "Mixed";
    statRuns.textContent = Array.isArray(data.history) ? String(data.history.length) : "0";
    statLatestTime.textContent = data.latest?.createdAt ? fmtDate(data.latest.createdAt) : "-";
  } catch (err) {
    latestContainer.innerHTML = `<div class="empty">Failed to load: ${err.message}</div>`;
    predictionHistory = [];
    latestPrediction = null;
    selectedPredictionId = null;
    viewLatestBtn.hidden = true;
    statLeague.textContent = "-";
    statRuns.textContent = "0";
    statLatestTime.textContent = "-";
    latestContainer.classList.add("is-visible");
    historyContainer.classList.add("is-visible");
  }
}

refreshBtn.addEventListener("click", load);
if (refreshBtnMobile) {
  refreshBtnMobile.addEventListener("click", () => {
    closeMobileNav();
    load();
  });
}
viewLatestBtn.addEventListener("click", showLatestPrediction);
historyContainer.addEventListener("click", (event) => {
  const button = event.target.closest("[data-history-id]");
  if (!button) return;
  const id = Number(button.dataset.historyId);
  if (!Number.isFinite(id)) return;
  setSelectedPrediction(id);
});
for (const btn of tabButtons) {
  btn.addEventListener("click", () => setPage(btn.dataset.page || "overview"));
}

if (navBurger && navDrawer) {
  navBurger.addEventListener("click", () => {
    navDrawer.classList.toggle("is-open");
    navBurger.classList.toggle("is-open");
  });
}

if (topbar) {
  window.addEventListener(
    "scroll",
    () => {
      topbar.classList.toggle("is-scrolled", window.scrollY > 20);
    },
    { passive: true }
  );
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(".ripple-btn");
  if (!button) return;

  const rect = button.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.35;
  const ripple = document.createElement("span");
  ripple.className = "ripple";
  ripple.style.width = `${size}px`;
  ripple.style.height = `${size}px`;
  ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
  ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
  button.appendChild(ripple);
  setTimeout(() => ripple.remove(), 650);
});

setPage(location.hash.replace("#", ""), false);
window.addEventListener("hashchange", () => setPage(location.hash.replace("#", ""), false));
initRevealObserver();
load();
setInterval(load, 60000);
