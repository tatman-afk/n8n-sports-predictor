#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    input: "data/nba_event_training_features_v4.csv",
    out: "data/reports/v4_dataset_integrity_report.json",
    strict: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--input") args.input = argv[i + 1] || args.input;
    if (t === "--out") args.out = argv[i + 1] || args.out;
    if (t === "--strict") args.strict = true;
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return rows;
  function splitCsvLine(line) {
    const out = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const next = line[i + 1];
      if (ch === '"') {
        if (inQuotes && next === '"') {
          current += '"';
          i += 1;
        } else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        out.push(current);
        current = "";
      } else current += ch;
    }
    out.push(current);
    return out;
  }

  const headers = splitCsvLine(lines[0]);
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const r = {};
    for (let j = 0; j < headers.length; j += 1) r[headers[j]] = cells[j] ?? "";
    rows.push(r);
  }
  return rows;
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) throw new Error(`Input not found: ${args.input}`);

  const rows = parseCsv(fs.readFileSync(args.input, "utf8"));
  const byEvent = new Map();
  for (const r of rows) {
    const id = String(r.event_id || "");
    if (!byEvent.has(id)) byEvent.set(id, []);
    byEvent.get(id).push(r);
  }

  const issues = {
    malformed_event_size: [],
    starts_at_mismatch: [],
    non_complement_team_win: [],
    opponent_id_mismatch: [],
    missing_core_fields: []
  };

  for (const [eventId, eventRows] of byEvent.entries()) {
    if (eventRows.length !== 2) {
      issues.malformed_event_size.push(eventId);
      continue;
    }
    const a = eventRows[0];
    const b = eventRows[1];
    if (String(a.starts_at) !== String(b.starts_at)) issues.starts_at_mismatch.push(eventId);
    const aw = Number(a.team_win);
    const bw = Number(b.team_win);
    if (!Number.isFinite(aw) || !Number.isFinite(bw) || (aw + bw !== 1)) issues.non_complement_team_win.push(eventId);
    if (String(a.opponent_team_id || "") !== String(b.team_id || "") || String(b.opponent_team_id || "") !== String(a.team_id || "")) {
      issues.opponent_id_mismatch.push(eventId);
    }
    const coreMissing = [a.team_id, a.opponent_team_id, a.implied_prob, a.odds_american_avg, b.team_id, b.opponent_team_id, b.implied_prob, b.odds_american_avg]
      .some((v) => v === null || v === undefined || String(v) === "");
    if (coreMissing) issues.missing_core_fields.push(eventId);
  }

  const issueCounts = Object.fromEntries(Object.entries(issues).map(([k, v]) => [k, v.length]));
  const totalIssues = Object.values(issueCounts).reduce((s, v) => s + v, 0);
  const report = {
    created_at: new Date().toISOString(),
    input: args.input,
    rows: rows.length,
    events: byEvent.size,
    issue_counts: issueCounts,
    total_issue_count: totalIssues,
    issues
  };

  ensureDirForFile(args.out);
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2), "utf8");

  console.log("V4 Dataset Integrity Check");
  console.log("--------------------------");
  console.log(`Rows: ${rows.length} | Events: ${byEvent.size}`);
  console.log(`Total issues: ${totalIssues}`);
  console.log(`Report: ${args.out}`);

  if (args.strict && totalIssues > 0) process.exit(2);
}

main();
