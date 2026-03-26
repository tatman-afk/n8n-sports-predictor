const { getSupabaseClient } = require("./lib/env");
const { getSeasonLabel, teamsByEspnAbbreviation } = require("./lib/nba");

function parseArgs() {
  const yearArg = process.argv[2];
  if (!yearArg || !/^\d{4}$/.test(yearArg)) {
    throw new Error("Usage: node scripts/ingestNbaBoxscores.js <seasonStartYear>");
  }
  return getSeasonLabel(Number(yearArg));
}

function statValue(entry) {
  if (!entry) return null;
  const raw = entry.displayValue ?? entry.value ?? entry.stat ?? entry.display ?? null;
  if (raw == null) return null;
  const normalized = String(raw).replace("%", "").trim();
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function buildStatMap(teamStats) {
  const map = new Map();
  for (const entry of teamStats || []) {
    const keys = [
      entry.name,
      entry.shortDisplayName,
      entry.displayName,
      entry.abbreviation,
      entry.label
    ]
      .filter(Boolean)
      .map((value) =>
        String(value)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "")
      );

    for (const key of keys) {
      map.set(key, statValue(entry));
    }
  }
  return map;
}

function readStat(statMap, aliases) {
  for (const alias of aliases) {
    const key = alias.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (statMap.has(key)) return statMap.get(key);
  }
  return null;
}

function buildBoxscoreRow(game, competitor, opponent, statMap, opponentStatMap) {
  const teamAbbreviation = String(
    competitor.team?.abbreviation || competitor.team?.shortDisplayName || ""
  ).toUpperCase();
  const opponentAbbreviation = String(
    opponent.team?.abbreviation || opponent.team?.shortDisplayName || ""
  ).toUpperCase();
  const teamId = teamsByEspnAbbreviation.get(teamAbbreviation)?.id || teamAbbreviation;
  const opponentId = teamsByEspnAbbreviation.get(opponentAbbreviation)?.id || opponentAbbreviation;

  const fieldGoalsMade = readStat(statMap, ["fieldGoalsMade", "fgm"]);
  const fieldGoalsAttempted = readStat(statMap, ["fieldGoalAttempts", "fga"]);
  const threePointersMade = readStat(statMap, ["threePointFieldGoalsMade", "3ptmade", "tpm"]);
  const threePointersAttempted = readStat(statMap, ["threePointFieldGoalAttempts", "3ptattempts", "tpa"]);
  const freeThrowsMade = readStat(statMap, ["freeThrowsMade", "ftm"]);
  const freeThrowsAttempted = readStat(statMap, ["freeThrowAttempts", "fta"]);

  return {
    game_id: String(game.game_id),
    team_id: String(teamId).toUpperCase(),
    opponent_team_id: String(opponentId).toUpperCase(),
    is_home: competitor.homeAway === "home",
    points: readStat(statMap, ["points", "pts", "score"]),
    points_allowed: readStat(opponentStatMap, ["points", "pts", "score"]),
    field_goals_made: fieldGoalsMade,
    field_goals_attempted: fieldGoalsAttempted,
    field_goal_pct: readStat(statMap, ["fieldGoalPct", "fgpct", "fg%"]),
    three_pointers_made: threePointersMade,
    three_pointers_attempted: threePointersAttempted,
    three_point_pct: readStat(statMap, ["threePointPct", "3ptpct", "3p%", "3pt%"]),
    free_throws_made: freeThrowsMade,
    free_throws_attempted: freeThrowsAttempted,
    free_throw_pct: readStat(statMap, ["freeThrowPct", "ftpct", "ft%"]),
    rebounds: readStat(statMap, ["rebounds", "reb", "totalRebounds"]),
    offensive_rebounds: readStat(statMap, ["offensiveRebounds", "oreb"]),
    defensive_rebounds: readStat(statMap, ["defensiveRebounds", "dreb"]),
    assists: readStat(statMap, ["assists", "ast"]),
    steals: readStat(statMap, ["steals", "stl"]),
    blocks: readStat(statMap, ["blocks", "blk"]),
    turnovers: readStat(statMap, ["turnovers", "to"]),
    fouls: readStat(statMap, ["fouls", "pf", "personalFouls"])
  };
}

async function fetchSummary(gameId) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ESPN summary for ${gameId}: ${response.status}`);
  }
  return response.json();
}

async function main() {
  const season = parseArgs();
  const supabase = getSupabaseClient();

  const gamesResult = await supabase
    .from("games")
    .select("game_id, season, status")
    .eq("season", season)
    .not("home_win", "is", null)
    .order("game_id", { ascending: true });

  if (gamesResult.error) throw gamesResult.error;

  const rows = [];

  for (const game of gamesResult.data || []) {
    const summary = await fetchSummary(game.game_id);
    const competitors = summary?.boxscore?.teams || summary?.header?.competitions?.[0]?.competitors || [];
    if (competitors.length !== 2) continue;

    const teamA = competitors[0];
    const teamB = competitors[1];
    const statMapA = buildStatMap(teamA.statistics);
    const statMapB = buildStatMap(teamB.statistics);
    const rowA = buildBoxscoreRow(game, teamA, teamB, statMapA, statMapB);
    const rowB = buildBoxscoreRow(game, teamB, teamA, statMapB, statMapA);

    if (rowA.team_id && rowB.team_id) {
      rows.push(rowA, rowB);
    }
  }

  if (!rows.length) {
    throw new Error(`No team boxscores parsed for ${season}.`);
  }

  const result = await supabase.from("team_boxscores").upsert(rows);
  if (result.error) throw result.error;

  console.log(`Upserted ${rows.length} team boxscore rows for ${season}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
