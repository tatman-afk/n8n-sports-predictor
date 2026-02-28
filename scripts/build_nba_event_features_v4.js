#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    input: "data/nba_event_training_dataset.csv",
    out: "data/nba_event_training_features_v4.csv",
    shortWindow: 5,
    longWindow: 10
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input") args.input = argv[i + 1] || args.input;
    if (token === "--out") args.out = argv[i + 1] || args.out;
    if (token === "--short-window") args.shortWindow = Number(argv[i + 1]) || args.shortWindow;
    if (token === "--long-window") args.longWindow = Number(argv[i + 1]) || args.longWindow;
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
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        out.push(current);
        current = "";
      } else {
        current += ch;
      }
    }

    out.push(current);
    return out;
  }

  const headers = splitCsvLine(lines[0]);
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j += 1) obj[headers[j]] = cells[j] ?? "";
    rows.push(obj);
  }

  return rows;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (!/[",\n]/.test(str)) return str;
  return `"${str.replaceAll('"', '""')}"`;
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function toNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toBoolInt(v) {
  if (v === true || v === 1) return 1;
  const s = String(v || "").toLowerCase();
  return (s === "true" || s === "t" || s === "1") ? 1 : 0;
}

function daysBetween(tsA, tsB) {
  return (tsA - tsB) / (1000 * 60 * 60 * 24);
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const idx = (sortedValues.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const t = idx - lo;
  return sortedValues[lo] * (1 - t) + sortedValues[hi] * t;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

function iqr(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q25 = quantile(sorted, 0.25);
  const q75 = quantile(sorted, 0.75);
  if (!Number.isFinite(q25) || !Number.isFinite(q75)) return null;
  return q75 - q25;
}

function getScoreForAgainst(row) {
  const scoreFor = row.is_home ? row.home_score : row.away_score;
  const scoreAgainst = row.is_home ? row.away_score : row.home_score;
  if (!Number.isFinite(scoreFor) || !Number.isFinite(scoreAgainst)) {
    return { scoreFor: null, scoreAgainst: null };
  }
  return { scoreFor, scoreAgainst };
}

function buildTeamHistories(rows, shortWindow, longWindow) {
  const byTeam = new Map();
  for (const row of rows) {
    if (!byTeam.has(row.team_id)) byTeam.set(row.team_id, []);
    byTeam.get(row.team_id).push(row);
  }

  for (const teamRows of byTeam.values()) {
    teamRows.sort((a, b) => a.startsAtTs - b.startsAtTs || a.event_id.localeCompare(b.event_id));
  }

  const historyByRowKey = new Map();
  for (const teamRows of byTeam.values()) {
    for (let i = 0; i < teamRows.length; i += 1) {
      const row = teamRows[i];
      const prior = teamRows.slice(0, i);
      const priorShort = prior.slice(Math.max(0, prior.length - shortWindow));
      const priorLong = prior.slice(Math.max(0, prior.length - longWindow));
      const prev = i > 0 ? teamRows[i - 1] : null;

      const restDays = prev ? daysBetween(row.startsAtTs, prev.startsAtTs) : null;
      const isBackToBack = Number.isFinite(restDays) && restDays <= 1.5 ? 1 : 0;

      const pointsForShort = priorShort
        .map((g) => getScoreForAgainst(g).scoreFor)
        .filter((v) => Number.isFinite(v));
      const pointsAgainstShort = priorShort
        .map((g) => getScoreForAgainst(g).scoreAgainst)
        .filter((v) => Number.isFinite(v));

      const pointsForLong = priorLong
        .map((g) => getScoreForAgainst(g).scoreFor)
        .filter((v) => Number.isFinite(v));
      const pointsAgainstLong = priorLong
        .map((g) => getScoreForAgainst(g).scoreAgainst)
        .filter((v) => Number.isFinite(v));

      const pointDiffShort = priorShort
        .map((g) => {
          const scores = getScoreForAgainst(g);
          if (!Number.isFinite(scores.scoreFor) || !Number.isFinite(scores.scoreAgainst)) return null;
          return scores.scoreFor - scores.scoreAgainst;
        })
        .filter((v) => Number.isFinite(v));
      const pointDiffLong = priorLong
        .map((g) => {
          const scores = getScoreForAgainst(g);
          if (!Number.isFinite(scores.scoreFor) || !Number.isFinite(scores.scoreAgainst)) return null;
          return scores.scoreFor - scores.scoreAgainst;
        })
        .filter((v) => Number.isFinite(v));

      const rowKey = `${row.event_id}:${row.team_id}`;
      historyByRowKey.set(rowKey, {
        rest_days: restDays,
        is_back_to_back: isBackToBack,
        rolling_win_rate_5: mean(priorShort.map((g) => g.team_win).filter((v) => v === 0 || v === 1)),
        rolling_win_rate_10: mean(priorLong.map((g) => g.team_win).filter((v) => v === 0 || v === 1)),
        rolling_points_for_5: mean(pointsForShort),
        rolling_points_for_10: mean(pointsForLong),
        rolling_points_against_5: mean(pointsAgainstShort),
        rolling_points_against_10: mean(pointsAgainstLong),
        rolling_net_rating_5: mean(pointDiffShort),
        rolling_net_rating_10: mean(pointDiffLong)
      });
    }
  }

  return historyByRowKey;
}

function createFeatures(rows, shortWindow, longWindow) {
  const normalized = rows
    .map((r) => ({
      ...r,
      event_id: String(r.event_id || ""),
      team_id: String(r.team_id || ""),
      opponent_team_id: String(r.opponent_team_id || ""),
      split: String(r.split || "train").toLowerCase(),
      startsAtTs: new Date(r.starts_at).getTime(),
      is_home: toBoolInt(r.is_home),
      books_aggregated: toNum(r.books_aggregated, 0),
      implied_prob: toNum(r.implied_prob),
      implied_prob_stddev: toNum(r.implied_prob_stddev),
      odds_american_min: toNum(r.odds_american_min),
      odds_american_max: toNum(r.odds_american_max),
      home_score: toNum(r.home_score),
      away_score: toNum(r.away_score),
      team_win: toNum(r.team_win)
    }))
    .filter((r) => Number.isFinite(r.startsAtTs) && Number.isFinite(r.implied_prob) && (r.team_win === 0 || r.team_win === 1));

  normalized.sort((a, b) => a.startsAtTs - b.startsAtTs || a.event_id.localeCompare(b.event_id));

  const rowByEventTeam = new Map();
  const eventRows = new Map();
  for (const row of normalized) {
    rowByEventTeam.set(`${row.event_id}:${row.team_id}`, row);
    if (!eventRows.has(row.event_id)) eventRows.set(row.event_id, []);
    eventRows.get(row.event_id).push(row);
  }

  const historyByRowKey = buildTeamHistories(normalized, shortWindow, longWindow);
  const featured = [];

  for (const row of normalized) {
    const rowKey = `${row.event_id}:${row.team_id}`;
    const oppKey = `${row.event_id}:${row.opponent_team_id}`;
    const ownHistory = historyByRowKey.get(rowKey) || {};
    const oppHistory = historyByRowKey.get(oppKey) || {};
    const oppRow = rowByEventTeam.get(oppKey) || null;

    const teamRowsInEvent = eventRows.get(row.event_id) || [];
    const eventImpliedValues = teamRowsInEvent.map((r) => r.implied_prob).filter((v) => Number.isFinite(v));
    const eventStdValues = teamRowsInEvent.map((r) => r.implied_prob_stddev).filter((v) => Number.isFinite(v));

    const impliedProbOpp = oppRow ? oppRow.implied_prob : null;
    const impliedProbDiff = Number.isFinite(impliedProbOpp) ? (row.implied_prob - impliedProbOpp) : null;
    const restDaysDiff =
      Number.isFinite(ownHistory.rest_days) && Number.isFinite(oppHistory.rest_days)
        ? ownHistory.rest_days - oppHistory.rest_days
        : null;
    const backToBackDiff =
      Number.isFinite(ownHistory.is_back_to_back) && Number.isFinite(oppHistory.is_back_to_back)
        ? ownHistory.is_back_to_back - oppHistory.is_back_to_back
        : null;

    const rollingWinRateDiff5 =
      Number.isFinite(ownHistory.rolling_win_rate_5) && Number.isFinite(oppHistory.rolling_win_rate_5)
        ? ownHistory.rolling_win_rate_5 - oppHistory.rolling_win_rate_5
        : null;
    const rollingWinRateDiff10 =
      Number.isFinite(ownHistory.rolling_win_rate_10) && Number.isFinite(oppHistory.rolling_win_rate_10)
        ? ownHistory.rolling_win_rate_10 - oppHistory.rolling_win_rate_10
        : null;

    const rollingNetRatingDiff5 =
      Number.isFinite(ownHistory.rolling_net_rating_5) && Number.isFinite(oppHistory.rolling_net_rating_5)
        ? ownHistory.rolling_net_rating_5 - oppHistory.rolling_net_rating_5
        : null;
    const rollingNetRatingDiff10 =
      Number.isFinite(ownHistory.rolling_net_rating_10) && Number.isFinite(oppHistory.rolling_net_rating_10)
        ? ownHistory.rolling_net_rating_10 - oppHistory.rolling_net_rating_10
        : null;

    const rollingPointsForDiff10 =
      Number.isFinite(ownHistory.rolling_points_for_10) && Number.isFinite(oppHistory.rolling_points_for_10)
        ? ownHistory.rolling_points_for_10 - oppHistory.rolling_points_for_10
        : null;
    const rollingPointsAgainstDiff10 =
      Number.isFinite(ownHistory.rolling_points_against_10) && Number.isFinite(oppHistory.rolling_points_against_10)
        ? ownHistory.rolling_points_against_10 - oppHistory.rolling_points_against_10
        : null;

    const booksOpp = oppRow ? oppRow.books_aggregated : null;
    const booksTotal = (row.books_aggregated || 0) + (booksOpp || 0);

    const ownOddsRange = Number.isFinite(row.odds_american_min) && Number.isFinite(row.odds_american_max)
      ? Math.abs(row.odds_american_max - row.odds_american_min)
      : null;
    const oppOddsRange = oppRow && Number.isFinite(oppRow.odds_american_min) && Number.isFinite(oppRow.odds_american_max)
      ? Math.abs(oppRow.odds_american_max - oppRow.odds_american_min)
      : null;
    const lineDispersionOddsRangeAvg =
      Number.isFinite(ownOddsRange) && Number.isFinite(oppOddsRange)
        ? (ownOddsRange + oppOddsRange) / 2
        : null;

    const marketDispersionTotal =
      Number.isFinite(row.implied_prob_stddev) && Number.isFinite(oppRow?.implied_prob_stddev)
        ? row.implied_prob_stddev + oppRow.implied_prob_stddev
        : null;
    const consensusDisagreementSignal = Number.isFinite(marketDispersionTotal) && Number.isFinite(lineDispersionOddsRangeAvg)
      ? marketDispersionTotal * (1 + Math.log1p(lineDispersionOddsRangeAvg / 100))
      : null;

    const missingFormFeatures = (
      !Number.isFinite(rollingWinRateDiff5) ||
      !Number.isFinite(rollingWinRateDiff10) ||
      !Number.isFinite(rollingNetRatingDiff5) ||
      !Number.isFinite(rollingNetRatingDiff10)
    ) ? 1 : 0;
    const missingScheduleFeatures = (
      !Number.isFinite(ownHistory.rest_days) ||
      !Number.isFinite(oppHistory.rest_days) ||
      !Number.isFinite(backToBackDiff)
    ) ? 1 : 0;
    const missingMarketFeatures = (
      !Number.isFinite(marketDispersionTotal) ||
      !Number.isFinite(consensusDisagreementSignal) ||
      !Number.isFinite(impliedProbDiff)
    ) ? 1 : 0;

    featured.push({
      ...row,
      implied_prob_opp: impliedProbOpp,
      implied_prob_diff_vs_opp: impliedProbDiff,
      implied_prob_event_median: median(eventImpliedValues),
      implied_prob_event_iqr: iqr(eventImpliedValues),
      implied_prob_stddev_event_median: median(eventStdValues),
      books_aggregated_opp: booksOpp,
      books_total: booksTotal,
      low_liquidity_team: row.books_aggregated < 3 ? 1 : 0,
      low_liquidity_opp: Number.isFinite(booksOpp) && booksOpp < 3 ? 1 : 0,
      low_liquidity_total: booksTotal < 6 ? 1 : 0,
      rolling_win_rate_5: ownHistory.rolling_win_rate_5 ?? null,
      rolling_win_rate_10: ownHistory.rolling_win_rate_10 ?? null,
      rolling_net_rating_5: ownHistory.rolling_net_rating_5 ?? null,
      rolling_net_rating_10: ownHistory.rolling_net_rating_10 ?? null,
      rolling_points_for_10: ownHistory.rolling_points_for_10 ?? null,
      rolling_points_against_10: ownHistory.rolling_points_against_10 ?? null,
      rest_days: ownHistory.rest_days ?? null,
      is_back_to_back: ownHistory.is_back_to_back ?? null,
      opp_rest_days: oppHistory.rest_days ?? null,
      opp_is_back_to_back: oppHistory.is_back_to_back ?? null,
      rest_days_diff: restDaysDiff,
      is_back_to_back_diff: backToBackDiff,
      rolling_win_rate_diff_5: rollingWinRateDiff5,
      rolling_win_rate_diff_10: rollingWinRateDiff10,
      rolling_net_rating_diff_5: rollingNetRatingDiff5,
      rolling_net_rating_diff_10: rollingNetRatingDiff10,
      rolling_points_for_diff_10: rollingPointsForDiff10,
      rolling_points_against_diff_10: rollingPointsAgainstDiff10,
      line_dispersion_odds_range_avg: lineDispersionOddsRangeAvg,
      market_dispersion_total: marketDispersionTotal,
      consensus_disagreement_signal: consensusDisagreementSignal,
      home_implied_edge_interaction: (row.is_home || 0) * (impliedProbDiff || 0),
      missing_form_features: missingFormFeatures,
      missing_schedule_features: missingScheduleFeatures,
      missing_market_features: missingMarketFeatures
    });
  }

  return featured;
}

function filterValidPairedEvents(rows) {
  const byEvent = new Map();
  for (const row of rows) {
    if (!byEvent.has(row.event_id)) byEvent.set(row.event_id, []);
    byEvent.get(row.event_id).push(row);
  }

  const validEventIds = new Set();
  const droppedEventIds = [];
  for (const [eventId, eventRows] of byEvent.entries()) {
    if (eventRows.length !== 2) {
      droppedEventIds.push(eventId);
      continue;
    }
    const a = eventRows[0];
    const b = eventRows[1];
    const reciprocal =
      String(a.opponent_team_id || "") === String(b.team_id || "") &&
      String(b.opponent_team_id || "") === String(a.team_id || "");
    const sameStart = String(a.starts_at || "") === String(b.starts_at || "");
    if (reciprocal && sameStart) validEventIds.add(eventId);
    else droppedEventIds.push(eventId);
  }

  return {
    rows: rows.filter((r) => validEventIds.has(r.event_id)),
    droppedEventIds
  };
}

function toCsv(rows) {
  const header = [
    "event_id",
    "external_key",
    "starts_at",
    "sport",
    "league",
    "team_id",
    "team_name",
    "opponent_team_id",
    "opponent_team_name",
    "is_home",
    "books_aggregated",
    "implied_prob",
    "implied_prob_stddev",
    "odds_american_avg",
    "odds_american_min",
    "odds_american_max",
    "pulled_at_avg_minutes_to_start",
    "home_score",
    "away_score",
    "team_win",
    "split",
    "implied_prob_opp",
    "implied_prob_diff_vs_opp",
    "implied_prob_event_median",
    "implied_prob_event_iqr",
    "implied_prob_stddev_event_median",
    "books_aggregated_opp",
    "books_total",
    "low_liquidity_team",
    "low_liquidity_opp",
    "low_liquidity_total",
    "rolling_win_rate_5",
    "rolling_win_rate_10",
    "rolling_net_rating_5",
    "rolling_net_rating_10",
    "rolling_points_for_10",
    "rolling_points_against_10",
    "rest_days",
    "is_back_to_back",
    "opp_rest_days",
    "opp_is_back_to_back",
    "rest_days_diff",
    "is_back_to_back_diff",
    "rolling_win_rate_diff_5",
    "rolling_win_rate_diff_10",
    "rolling_net_rating_diff_5",
    "rolling_net_rating_diff_10",
    "rolling_points_for_diff_10",
    "rolling_points_against_diff_10",
    "line_dispersion_odds_range_avg",
    "market_dispersion_total",
    "consensus_disagreement_signal",
    "home_implied_edge_interaction",
    "missing_form_features",
    "missing_schedule_features",
    "missing_market_features"
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => csvEscape(row[key])).join(","));
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) {
    throw new Error(`Input file not found: ${args.input}. Run dataset:nba:export:event first.`);
  }

  const rawText = fs.readFileSync(args.input, "utf8");
  const rows = parseCsv(rawText);
  if (!rows.length) throw new Error("Input CSV has no rows.");

  const featured = createFeatures(rows, args.shortWindow, args.longWindow);
  const paired = filterValidPairedEvents(featured);
  if (!paired.rows.length) throw new Error("No rows survived parsing/filtering for v4 features.");

  ensureDirForFile(args.out);
  fs.writeFileSync(args.out, toCsv(paired.rows), "utf8");

  console.log("NBA Event Feature Build V4 Complete");
  console.log("-----------------------------------");
  console.log(`Input rows: ${rows.length}`);
  console.log(`Output rows: ${paired.rows.length}`);
  console.log(`Dropped malformed events: ${paired.droppedEventIds.length}`);
  console.log(`Input: ${args.input}`);
  console.log(`Output: ${args.out}`);
  console.log(`Windows: short=${args.shortWindow}, long=${args.longWindow}`);
}

main();
