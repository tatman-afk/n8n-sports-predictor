#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    confidenceReport: "data/reports/v4_confidence_policy_backtest_2024_2025.json",
    dataset: "data/nba_event_training_features_v4.csv",
    out: "data/reports/v4_execution_quality_simulation.json",
    policy: "A_B",
    minBooks: 2,
    minMinutesToStart: 5,
    maxMinutesToStart: 180,
    fillProbBase: 0.85,
    fillProbBooksWeight: 0.10,
    fillProbLatencyPenalty: 0.15,
    fillSeed: 42
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--confidence-report") args.confidenceReport = argv[i + 1] || args.confidenceReport;
    if (t === "--dataset") args.dataset = argv[i + 1] || args.dataset;
    if (t === "--out") args.out = argv[i + 1] || args.out;
    if (t === "--policy") args.policy = argv[i + 1] || args.policy;
    if (t === "--min-books") args.minBooks = Number(argv[i + 1]) || args.minBooks;
    if (t === "--min-minutes-to-start") args.minMinutesToStart = Number(argv[i + 1]) || args.minMinutesToStart;
    if (t === "--max-minutes-to-start") args.maxMinutesToStart = Number(argv[i + 1]) || args.maxMinutesToStart;
    if (t === "--fill-prob-base") args.fillProbBase = Number(argv[i + 1]) || args.fillProbBase;
    if (t === "--fill-prob-books-weight") args.fillProbBooksWeight = Number(argv[i + 1]) || args.fillProbBooksWeight;
    if (t === "--fill-prob-latency-penalty") args.fillProbLatencyPenalty = Number(argv[i + 1]) || args.fillProbLatencyPenalty;
    if (t === "--fill-seed") args.fillSeed = Number(argv[i + 1]) || args.fillSeed;
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

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function hashUnit(str, seed) {
  let h = (seed >>> 0) || 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000000) / 1000000;
}

function bucketEligible(policy, bucket) {
  if (policy === "A_only") return bucket === "A";
  if (policy === "A_B") return bucket === "A" || bucket === "B";
  return true;
}

function fillProbability(books, mins, args) {
  const b = Number.isFinite(books) ? books : 0;
  const m = Number.isFinite(mins) ? mins : 99999;
  const booksBoost = Math.min(1, b / 5) * args.fillProbBooksWeight;
  const latencyPenalty = Math.min(1, Math.max(0, m) / 120) * args.fillProbLatencyPenalty;
  return Math.max(0, Math.min(1, args.fillProbBase + booksBoost - latencyPenalty));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const conf = JSON.parse(fs.readFileSync(args.confidenceReport, "utf8"));
  const picks = Array.isArray(conf.picks) ? conf.picks : [];
  const dsRows = parseCsv(fs.readFileSync(args.dataset, "utf8"));
  const dsMap = new Map(dsRows.map((r) => [`${r.event_id}::${String(r.team_name || "").toLowerCase()}`, r]));

  let eligible = 0;
  let filled = 0;
  const drops = { policy: 0, books: 0, minutes: 0, fill_prob: 0, missing_dataset_row: 0 };
  for (const p of picks) {
    if (!bucketEligible(args.policy, p.bucket)) {
      drops.policy += 1;
      continue;
    }
    eligible += 1;
    const key = `${p.event_id}::${String(p.team_name || "").toLowerCase()}`;
    const ds = dsMap.get(key);
    if (!ds) {
      drops.missing_dataset_row += 1;
      continue;
    }
    const books = Number(ds.books_aggregated);
    const mins = Number(ds.pulled_at_avg_minutes_to_start);
    if (!Number.isFinite(books) || books < args.minBooks) {
      drops.books += 1;
      continue;
    }
    if (!Number.isFinite(mins) || mins < args.minMinutesToStart || mins > args.maxMinutesToStart) {
      drops.minutes += 1;
      continue;
    }
    const pFill = fillProbability(books, mins, args);
    const draw = hashUnit(p.event_id, args.fillSeed);
    if (draw > pFill) {
      drops.fill_prob += 1;
      continue;
    }
    filled += 1;
  }

  const report = {
    created_at: new Date().toISOString(),
    config: args,
    summary: {
      picks_total: picks.length,
      policy_eligible: eligible,
      filled,
      fill_rate_over_eligible: eligible ? filled / eligible : null,
      fill_rate_over_total: picks.length ? filled / picks.length : null,
      drops
    }
  };

  ensureDirForFile(args.out);
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2), "utf8");
  console.log("V4 Execution Quality Simulation Complete");
  console.log("----------------------------------------");
  console.log(`Policy eligible: ${eligible}`);
  console.log(`Filled: ${filled}`);
  console.log(`Fill rate (eligible): ${report.summary.fill_rate_over_eligible === null ? "n/a" : report.summary.fill_rate_over_eligible.toFixed(4)}`);
  console.log(`Report: ${args.out}`);
}

main();
