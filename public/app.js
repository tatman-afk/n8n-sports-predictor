const latestContainer = document.getElementById("latestContainer");
const historyContainer = document.getElementById("historyContainer");
const updatedAt = document.getElementById("updatedAt");
const refreshBtn = document.getElementById("refreshBtn");
const statLeague = document.getElementById("statLeague");
const statRuns = document.getElementById("statRuns");
const statLatestTime = document.getElementById("statLatestTime");
const sectionStats = document.getElementById("sectionStats");
const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
const pageBlocks = Array.from(document.querySelectorAll(".panel-block"));
const allowedPages = new Set(["overview", "predictions", "performance", "history"]);

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

  document.body.classList.remove("page-overview", "page-predictions", "page-performance", "page-history");
  document.body.classList.add(`page-${targetPage}`);

  if (updateHash) {
    history.replaceState(null, "", `#${targetPage}`);
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
    const line = rawLine.trim();
    if (!line) continue;

    const header = line.match(
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
    const cleaned = line.replace(/^\d+\)\s*/, "").replace(/^-\s*/, "");
    sections.get(currentSection).push(cleaned);
  }

  const hasAny = Array.from(sections.values()).some((items) => items.length > 0);
  return hasAny ? sections : null;
}

function parseSectionsWithOutcomes(rawMessage) {
  if (!rawMessage || typeof rawMessage !== "string") return null;

  const sectionOrder = [
    "Safe Bets",
    "Best Value Bets",
    "Long Shots",
    "2-Leg Parlays",
    "3-Leg Parlays"
  ];

  const sections = new Map(sectionOrder.map((name) => [name, []]));
  let currentSection = null;
  const lines = rawMessage.split("\n");

  function getOutcome(text) {
    if (/result:\s*win|status:\s*win|\bwon\b|✅|\[\s*W\s*\]/i.test(text)) return "win";
    if (/result:\s*loss|status:\s*loss|\blost\b|❌|\[\s*L\s*\]/i.test(text)) return "loss";
    return null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const header = line.match(
      /^(Safe Bets|Best Value Bets|Long Shots|2-Leg Parlays|3-Leg Parlays)\b/i
    );

    if (header) {
      const normalized = sectionOrder.find(
        (s) => s.toLowerCase() === header[1].toLowerCase()
      );
      currentSection = normalized || null;
      continue;
    }

    if (!currentSection) continue;
    const cleaned = line.replace(/^\d+\)\s*/, "").replace(/^-\s*/, "");
    sections.get(currentSection).push({ text: cleaned, outcome: getOutcome(cleaned) });
  }

  return sections;
}

function renderSectionStats(history) {
  const labels = [
    "Safe Bets",
    "Best Value Bets",
    "Long Shots",
    "2-Leg Parlays",
    "3-Leg Parlays"
  ];

  const totals = new Map(labels.map((label) => [label, { wins: 0, losses: 0 }]));

  for (const entry of history || []) {
    const parsed = parseSectionsWithOutcomes(entry.rawMessage || "");
    if (!parsed) continue;

    for (const label of labels) {
      for (const item of parsed.get(label) || []) {
        if (item.outcome === "win") totals.get(label).wins += 1;
        if (item.outcome === "loss") totals.get(label).losses += 1;
      }
    }
  }

  const cards = labels.map((label) => {
    const data = totals.get(label);
    const settled = data.wins + data.losses;
    const winRate = settled > 0 ? `${((data.wins / settled) * 100).toFixed(1)}%` : "-";
    return `
      <article class="perf-card">
        <p class="perf-label">${escapeHtml(label)}</p>
        <p class="perf-rate">${winRate}</p>
        <p class="perf-record">${data.wins}W - ${data.losses}L</p>
      </article>
    `;
  });

  sectionStats.innerHTML = cards.join("");
}

function renderSectionCards(rawMessage) {
  const sections = parseSections(rawMessage);
  if (!sections) {
    return `<pre class="raw">${escapeHtml(rawMessage)}</pre>`;
  }

  function renderItemRow(item) {
    const parts = item.split("|").map((p) => p.trim());
    const pick = parts[0] || item;
    const confidencePart = parts.find((p) => /^confidence:/i.test(p)) || "";
    const reasonPart = parts.find((p) => /^reason:/i.test(p)) || "";
    const confidence = confidencePart.replace(/^confidence:\s*/i, "").trim();
    const confidenceLabel =
      confidence && confidence.includes("%") ? confidence : confidence ? `${confidence}%` : "";
    const reason = reasonPart.replace(/^reason:\s*/i, "").trim();

    if (!confidence && !reason) {
      return `<li class="pick-row"><div class="pick-main">${escapeHtml(pick)}</div></li>`;
    }

    return `
      <li class="pick-row">
        <div class="pick-main">${escapeHtml(pick)}</div>
        <div class="pick-meta">
          ${confidenceLabel ? `<span class="pill">${escapeHtml(confidenceLabel)}</span>` : ""}
          ${reason ? `<span class="reason">${escapeHtml(reason)}</span>` : ""}
        </div>
      </li>
    `;
  }

  const cards = [];
  for (const [title, items] of sections.entries()) {
    if (items.length === 0) continue;
    const wideClass = title === "Risk Notes" ? " section-wide" : "";
    const list = items.map((item) => renderItemRow(item)).join("");
    cards.push(`
      <article class="section-card${wideClass}">
        <h3>${escapeHtml(title)}</h3>
        <ul>${list}</ul>
      </article>
    `);
  }

  return `<div class="sections-grid">${cards.join("")}</div>`;
}

function renderLatest(latest) {
  if (!latest) {
    latestContainer.innerHTML = '<div class="empty">No predictions yet.</div>';
    return;
  }

  const picksHtml = (latest.games || [])
    .map(
      (g) => `
      <article class="pick">
        <p><strong>${g.matchup || "Unknown matchup"}</strong></p>
        <p>Pick: ${g.pick || "N/A"}${g.odds ? ` (${g.odds})` : ""}</p>
        <p>Confidence: ${g.confidence || "N/A"}</p>
        ${g.reason ? `<p>${g.reason}</p>` : ""}
      </article>
    `
    )
    .join("");

  latestContainer.innerHTML = `
    <article class="latest-card">
      <div class="latest-meta">
        <span><strong>${latest.title}</strong></span>
        <span>League: ${latest.league || "Mixed"}</span>
        <span>Created: ${fmtDate(latest.createdAt)}</span>
      </div>
      <div class="latest-body">
        ${latest.aiSummary ? `<p>${latest.aiSummary}</p>` : ""}
        ${picksHtml || ""}
        ${latest.rawMessage ? renderSectionCards(latest.rawMessage) : ""}
      </div>
    </article>
  `;
}

function renderHistory(history) {
  if (!Array.isArray(history) || history.length === 0) {
    historyContainer.innerHTML = '<div class="empty">No run history yet.</div>';
    return;
  }

  historyContainer.innerHTML = history
    .map(
      (item) => `
        <div class="history-item">
          <span>${item.title} (${item.league || "Mixed"})</span>
          <span>${fmtDate(item.createdAt)}</span>
        </div>
      `
    )
    .join("");
}

async function load() {
  try {
    const res = await fetch("/api/predictions");
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    renderLatest(data.latest);
    renderHistory(data.history);
    renderSectionStats(data.history);
    updatedAt.textContent = data.updatedAt
      ? `Last updated ${fmtDate(data.updatedAt)}`
      : "Waiting for first prediction run...";
    statLeague.textContent = data.latest?.league || "Mixed";
    statRuns.textContent = Array.isArray(data.history) ? String(data.history.length) : "0";
    statLatestTime.textContent = data.latest?.createdAt ? fmtDate(data.latest.createdAt) : "-";
  } catch (err) {
    latestContainer.innerHTML = `<div class="empty">Failed to load: ${err.message}</div>`;
    sectionStats.innerHTML = "";
    statLeague.textContent = "-";
    statRuns.textContent = "0";
    statLatestTime.textContent = "-";
  }
}

refreshBtn.addEventListener("click", load);
for (const btn of tabButtons) {
  btn.addEventListener("click", () => setPage(btn.dataset.page || "overview"));
}

setPage(location.hash.replace("#", ""), false);
window.addEventListener("hashchange", () => setPage(location.hash.replace("#", ""), false));
load();
setInterval(load, 60000);
