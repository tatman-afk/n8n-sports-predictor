const { getSupabaseClient } = require("./lib/env");
const {
  teamsByEspnAbbreviation,
  getLocalDateParts,
  seasonDateRange,
  getSeasonLabel,
  dateKeysBetween
} = require("./lib/nba");

function parseArgs() {
  const yearArg = process.argv[2];
  if (!yearArg || !/^\d{4}$/.test(yearArg)) {
    throw new Error("Usage: node scripts/ingestNbaGames.js <seasonStartYear>");
  }
  return Number(yearArg);
}

function isPlayoffGame(seasonStartYear, gameDate) {
  const playoffsStart = new Date(Date.UTC(seasonStartYear + 1, 3, 10));
  return gameDate >= playoffsStart;
}

function normalizeCompetitors(event) {
  const competition = event?.competitions?.[0];
  const competitors = competition?.competitors || [];
  if (competitors.length !== 2) return null;

  const home = competitors.find((competitor) => competitor.homeAway === "home");
  const away = competitors.find((competitor) => competitor.homeAway === "away");
  if (!home || !away) return null;

  const homeTeam = teamsByEspnAbbreviation.get(
    String(home.team?.abbreviation || "").toUpperCase()
  );
  const awayTeam = teamsByEspnAbbreviation.get(
    String(away.team?.abbreviation || "").toUpperCase()
  );

  if (!homeTeam || !awayTeam) return null;

  return {
    home,
    away,
    homeTeam,
    awayTeam,
    competition
  };
}

function toGameRow(event, normalized, seasonStartYear, seasonLabel) {
  const gameDate = new Date(event.date || normalized.competition.date);
  const localParts = getLocalDateParts(
    gameDate.toISOString(),
    normalized.homeTeam.arena.timezone
  );
  const completed = Boolean(normalized.competition?.status?.type?.completed);
  const homeScore = completed ? Number(normalized.home.score) : null;
  const awayScore = completed ? Number(normalized.away.score) : null;
  const status = normalized.competition?.status?.type?.name || "STATUS_SCHEDULED";
  const detail = String(normalized.competition?.status?.type?.detail || "");
  const overtimeMatch = detail.match(/(\d+)\s*OT/i);
  const otPeriods = overtimeMatch ? Number(overtimeMatch[1]) : /OT/i.test(detail) ? 1 : 0;

  return {
    game_id: String(event.id),
    season: seasonLabel,
    status,
    game_date: localParts.gameDate,
    game_datetime_utc: gameDate.toISOString(),
    game_datetime_local: localParts.localDateTime,
    local_hour: localParts.localHour,
    day_of_week: localParts.dayOfWeek,
    home_team_id: normalized.homeTeam.id,
    away_team_id: normalized.awayTeam.id,
    home_arena_id: normalized.homeTeam.arena.id,
    away_arena_id: normalized.awayTeam.arena.id,
    home_score: Number.isFinite(homeScore) ? homeScore : null,
    away_score: Number.isFinite(awayScore) ? awayScore : null,
    home_win:
      Number.isFinite(homeScore) && Number.isFinite(awayScore) ? homeScore > awayScore : null,
    is_playoff: isPlayoffGame(seasonStartYear, gameDate),
    ot_periods: otPeriods
  };
}

async function fetchGamesForDate(dateKey) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateKey}&limit=200`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ESPN scoreboard for ${dateKey}: ${response.status}`);
  }

  const payload = await response.json();
  return payload.events || [];
}

async function main() {
  const seasonStartYear = parseArgs();
  const supabase = getSupabaseClient();
  const seasonLabel = getSeasonLabel(seasonStartYear);
  const { start, end } = seasonDateRange(seasonStartYear);
  const dateKeys = dateKeysBetween(start, end);
  const rowsByGameId = new Map();

  for (const dateKey of dateKeys) {
    const events = await fetchGamesForDate(dateKey);
    for (const event of events) {
      const normalized = normalizeCompetitors(event);
      if (!normalized) continue;
      const row = toGameRow(event, normalized, seasonStartYear, seasonLabel);
      rowsByGameId.set(row.game_id, row);
    }
  }

  const rows = Array.from(rowsByGameId.values()).sort((a, b) =>
    a.game_datetime_utc.localeCompare(b.game_datetime_utc)
  );

  if (rows.length === 0) {
    throw new Error(`No NBA games found for season ${seasonLabel}.`);
  }

  const result = await supabase.from("games").upsert(rows);
  if (result.error) throw result.error;

  console.log(`Upserted ${rows.length} NBA games for ${seasonLabel}.`);
  console.log("Run `npm run features:nba -- 2024` after ingest to build travel and rest features.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
