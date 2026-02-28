#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    picksJson: "data/reports/v4_confidence_policy_backtest_2024_2025.json",
    closingCsv: "",
    out: "data/reports/v4_clv_validation_report.json"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--picks-json") args.picksJson = argv[i + 1] || args.picksJson;
    if (t === "--closing-csv") args.closingCsv = argv[i + 1] || args.closingCsv;
    if (t === "--out") args.out = argv[i + 1] || args.out;
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return rows;
  function split(line) {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const nx = line[i + 1];
      if (ch === '"') {
        if (q && nx === '"') {
          cur += '"';
          i += 1;
        } else q = !q;
      } else if (ch === "," && !q) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }
  const h = split(lines[0]);
  for (let i = 1; i < lines.length; i += 1) {
    const c = split(lines[i]);
    const r = {};
    for (let j = 0; j < h.length; j += 1) r[h[j]] = c[j] ?? "";
    rows.push(r);
  }
  return rows;
}

function americanToDecimal(a) {
  const n = Number(a);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? (1 + n / 100) : (1 + 100 / Math.abs(n));
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.picksJson)) throw new Error(`Missing picks JSON: ${args.picksJson}`);

  const picksReport = JSON.parse(fs.readFileSync(args.picksJson, "utf8"));
  const picks = Array.isArray(picksReport.picks) ? picksReport.picks : [];
  if (!picks.length) throw new Error("No picks found in picks JSON.");

  const byKey = new Map();
  for (const p of picks) byKey.set(`${p.event_id}::${String(p.team_name).toLowerCase()}`, p);

  let mode = "closing_csv";
  let closingRows = [];
  if (args.closingCsv && fs.existsSync(args.closingCsv)) {
    closingRows = parseCsv(fs.readFileSync(args.closingCsv, "utf8"));
  } else {
    mode = "proxy_same_snapshot";
    // Fallback proxy: closing equals entry (CLV deltas become 0).
    closingRows = picks.map((p) => ({
      event_id: p.event_id,
      team_name: p.team_name,
      odds_american_avg: p.odds_american_avg
    }));
  }

  const matched = [];
  for (const row of closingRows) {
    const key = `${row.event_id}::${String(row.team_name || "").toLowerCase()}`;
    const pick = byKey.get(key);
    if (!pick) continue;
    const entryDec = americanToDecimal(pick.odds_american_avg);
    const closeDec = americanToDecimal(row.odds_american_avg);
    if (!Number.isFinite(entryDec) || !Number.isFinite(closeDec)) continue;
    const deltaDec = entryDec - closeDec;
    matched.push({
      event_id: pick.event_id,
      team_name: pick.team_name,
      entry_odds_american: pick.odds_american_avg,
      closing_odds_american: row.odds_american_avg,
      entry_decimal: entryDec,
      closing_decimal: closeDec,
      clv_decimal_delta: deltaDec,
      positive_clv: deltaDec > 0 ? 1 : 0
    });
  }

  const report = {
    created_at: new Date().toISOString(),
    mode,
    inputs: {
      picks_json: args.picksJson,
      closing_csv: args.closingCsv || null
    },
    summary: {
      picks_total: picks.length,
      matched: matched.length,
      share_positive_clv: matched.length ? matched.filter((r) => r.positive_clv === 1).length / matched.length : null,
      mean_clv_decimal_delta: matched.length ? matched.reduce((s, r) => s + r.clv_decimal_delta, 0) / matched.length : null
    },
    records: matched
  };

  ensureDirForFile(args.out);
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2), "utf8");

  console.log("V4 CLV Validation Complete");
  console.log("--------------------------");
  console.log(`Mode: ${mode}`);
  console.log(`Matched picks: ${matched.length}/${picks.length}`);
  console.log(`Share positive CLV: ${report.summary.share_positive_clv === null ? "n/a" : report.summary.share_positive_clv.toFixed(4)}`);
  console.log(`Report: ${args.out}`);
}

main();
