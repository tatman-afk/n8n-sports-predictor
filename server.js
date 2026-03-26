const express = require("express");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const nbaTeams = require("./data/nba-teams.json");
const { buildModelFeatureObject, scoreFeatureObject } = require("./scripts/lib/nbaModel");
const { fetchAllRows } = require("./scripts/lib/supabasePagination");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const INGEST_KEY = process.env.INGEST_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Update your .env file."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const NBA_TEAM_LOOKUP = buildNbaTeamLookup(nbaTeams);
const NBA_ARENAS_BY_TEAM_ID = new Map(nbaTeams.map((team) => [team.id, team.arena]));
const NBA_MODEL_ARTIFACT_PATH = path.join(__dirname, "model", "nba-logistic-model.json");
const ESPN_LEAGUES = [
  { sport: "basketball", league: "nba" },
  { sport: "baseball", league: "mlb" },
  { sport: "icehockey", league: "nhl" },
  { sport: "football", league: "nfl" }
];

function mapRow(row) {
  return {
    id: row.id,
    title: row.title,
    league: row.league,
    games: Array.isArray(row.games) ? row.games : [],
    aiSummary: row.ai_summary || "",
    rawMessage: row.raw_message || "",
    createdAt: row.created_at
  };
}

function normalizeTeamName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|fc|cf|sc)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function teamMatch(candidate, aliases) {
  const normalized = normalizeTeamName(candidate);
  if (!normalized) return false;
  if (aliases.has(normalized)) return true;
  for (const alias of aliases) {
    if (alias.length >= 5 && normalized.includes(alias)) return true;
    if (normalized.length >= 5 && alias.includes(normalized)) return true;
  }
  return false;
}

function buildNbaTeamLookup(teams) {
  const lookup = new Map();
  const manualAliases = {
    "atlanta": "ATL",
    "boston": "BOS",
    "brooklyn": "BKN",
    "charlotte": "CHA",
    "chicago": "CHI",
    "cleveland": "CLE",
    "dallas": "DAL",
    "denver": "DEN",
    "detroit": "DET",
    "golden state": "GSW",
    "warriors": "GSW",
    "houston": "HOU",
    "indiana": "IND",
    "clippers": "LAC",
    "la clippers": "LAC",
    "los angeles clippers": "LAC",
    "lakers": "LAL",
    "la lakers": "LAL",
    "los angeles lakers": "LAL",
    "memphis": "MEM",
    "miami": "MIA",
    "milwaukee": "MIL",
    "minnesota": "MIN",
    "new orleans": "NOP",
    "pelicans": "NOP",
    "knicks": "NYK",
    "new york": "NYK",
    "oklahoma city": "OKC",
    "thunder": "OKC",
    "orlando": "ORL",
    "philadelphia": "PHI",
    "76ers": "PHI",
    "phoenix": "PHX",
    "portland": "POR",
    "trail blazers": "POR",
    "blazers": "POR",
    "sacramento": "SAC",
    "san antonio": "SAS",
    "toronto": "TOR",
    "utah": "UTA",
    "washington": "WAS",
    "wizards": "WAS"
  };

  for (const team of teams) {
    const normalizedName = normalizeTeamName(team.name);
    const words = team.name.split(" ");
    const city = normalizeTeamName(words.slice(0, -1).join(" "));
    const nickname = normalizeTeamName(words.slice(-1).join(" "));
    const aliases = [
      team.id,
      team.abbreviation,
      team.espnAbbreviation,
      team.name,
      normalizedName,
      city,
      nickname
    ];

    if (team.id === "POR") aliases.push("portland trail blazers");
    if (team.id === "PHI") aliases.push("philadelphia 76ers", "sixers");
    if (team.id === "GSW") aliases.push("golden state warriors");
    if (team.id === "NOP") aliases.push("new orleans pelicans");

    for (const alias of aliases) {
      const normalized = normalizeTeamName(alias);
      if (normalized) lookup.set(normalized, team);
    }
  }

  for (const [alias, teamId] of Object.entries(manualAliases)) {
    const team = teams.find((item) => item.id === teamId);
    if (team) lookup.set(normalizeTeamName(alias), team);
  }

  return lookup;
}

function findNbaTeam(name) {
  const normalized = normalizeTeamName(name);
  return NBA_TEAM_LOOKUP.get(normalized) || null;
}

function moneylineToProb(odds) {
  if (typeof odds !== "number" || !Number.isFinite(odds)) return null;
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

function avg(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getLocalDateParts(dateInput, timeZone) {
  const date = new Date(dateInput);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short"
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    localDateTime: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
    localHour: Number(parts.hour),
    dayOfWeek: weekdayMap[parts.weekday]
  };
}

function localHourBucket(hour) {
  if (!Number.isFinite(hour)) return "unknown";
  if (hour < 16) return "matinee";
  if (hour < 19) return "early_evening";
  if (hour < 22) return "prime_time";
  return "late_night";
}

function restBucket(daysRest) {
  if (daysRest == null || !Number.isFinite(daysRest)) return "unknown";
  if (daysRest <= 0) return "0_days";
  if (daysRest === 1) return "1_day";
  if (daysRest === 2) return "2_days";
  return "3_plus_days";
}

function travelBucket(distanceMiles) {
  if (distanceMiles == null || !Number.isFinite(distanceMiles)) return "unknown";
  if (distanceMiles === 0) return "no_travel";
  if (distanceMiles < 500) return "short_haul";
  if (distanceMiles < 1000) return "medium_haul";
  return "long_haul";
}

function diffDays(dateA, dateB) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((dateA - dateB) / msPerDay);
}

function countRecentGames(rows, currentDate, days) {
  const windowStart = new Date(currentDate);
  windowStart.setUTCDate(windowStart.getUTCDate() - days);
  return rows.filter((row) => {
    const rowDate = new Date(row.game.game_datetime_utc);
    return rowDate > windowStart && rowDate < currentDate;
  }).length;
}

function parseTimeZoneOffsetHours(timeZone, date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset"
  });
  const zoneName =
    formatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value || "GMT";
  const match = zoneName.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/i);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) / 60 : 0;
  return hours >= 0 ? hours + minutes : hours - minutes;
}

function getTeamWin(row) {
  if (!row?.game || row.game.home_win == null) return null;
  return row.is_home ? Boolean(row.game.home_win) : !row.game.home_win;
}

function summarizeRows(rows) {
  const wins = rows.reduce((count, row) => count + (getTeamWin(row) ? 1 : 0), 0);
  const games = rows.length;
  return {
    games,
    wins,
    losses: games - wins,
    winPct: games ? Number(((wins / games) * 100).toFixed(1)) : null
  };
}

function pickSample(rows, predicate) {
  return summarizeRows(rows.filter(predicate));
}

function formatRecord(label, stats) {
  if (!stats.games) return `${label}: no sample`;
  return `${label}: ${stats.wins}-${stats.losses} (${stats.winPct}%) in ${stats.games} games`;
}

function parseOddsGame(game) {
  if (game && Array.isArray(game.teams) && game.teams.length === 2) {
    const [teamA, teamB] = game.teams;
    return {
      homeTeamName: game.home_team || game.homeTeam || teamA.name,
      awayTeamName: game.away_team || game.awayTeam || teamB.name,
      commenceTime: game.commence_time || game.commenceTime || new Date().toISOString(),
      teams: [
        {
          name: teamA.name,
          avgMoneyline: Number.isFinite(teamA.avgMoneyline) ? teamA.avgMoneyline : null,
          impliedWinPct:
            Number.isFinite(teamA.impliedWinPct) ? teamA.impliedWinPct : null
        },
        {
          name: teamB.name,
          avgMoneyline: Number.isFinite(teamB.avgMoneyline) ? teamB.avgMoneyline : null,
          impliedWinPct:
            Number.isFinite(teamB.impliedWinPct) ? teamB.impliedWinPct : null
        }
      ]
    };
  }

  const homeTeamName = game?.home_team || game?.homeTeam || null;
  const awayTeamName = game?.away_team || game?.awayTeam || null;
  const priceMap = new Map();

  for (const book of game?.bookmakers || []) {
    const market = (book.markets || []).find((entry) => entry.key === "h2h");
    for (const outcome of market?.outcomes || []) {
      if (typeof outcome.price !== "number") continue;
      if (!priceMap.has(outcome.name)) priceMap.set(outcome.name, []);
      priceMap.get(outcome.name).push(outcome.price);
    }
  }

  const teams = [awayTeamName, homeTeamName]
    .filter(Boolean)
    .map((name) => {
      const prices = priceMap.get(name) || [];
      const averageMoneyline = avg(prices);
      const impliedProb = moneylineToProb(averageMoneyline);
      return {
        name,
        avgMoneyline:
          typeof averageMoneyline === "number" ? Number(averageMoneyline.toFixed(0)) : null,
        impliedWinPct:
          typeof impliedProb === "number" ? Number((impliedProb * 100).toFixed(1)) : null
      };
    });

  return {
    homeTeamName,
    awayTeamName,
    commenceTime: game?.commence_time || game?.commenceTime || new Date().toISOString(),
    teams
  };
}

function loadNbaModelArtifact() {
  if (!fs.existsSync(NBA_MODEL_ARTIFACT_PATH)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(NBA_MODEL_ARTIFACT_PATH, "utf8"));
  } catch (_error) {
    return null;
  }
}

async function loadNbaWarehouse() {
  const [games, features, distances, boxscores] = await Promise.all([
    fetchAllRows(() => supabase.from("games").select("*")),
    fetchAllRows(() => supabase.from("team_game_features").select("*")),
    fetchAllRows(() => supabase.from("arena_distances").select("*")),
    fetchAllRows(() => supabase.from("team_boxscores").select("*"))
  ]);

  const gamesById = new Map((games || []).map((game) => [game.game_id, game]));
  const boxscoresByKey = new Map(
    (boxscores || []).map((row) => [`${row.game_id}:${row.team_id}`, row])
  );
  const featureRows = (features || [])
    .map((row) => ({
      ...row,
      game: gamesById.get(row.game_id) || null,
      boxscore: boxscoresByKey.get(`${row.game_id}:${row.team_id}`) || null
    }))
    .filter((row) => row.game);
  const completedRows = featureRows.filter((row) => row.game.home_win != null);
  const rowsByTeam = new Map();

  for (const row of completedRows) {
    const bucket = rowsByTeam.get(row.team_id) || [];
    bucket.push(row);
    rowsByTeam.set(row.team_id, bucket);
  }

  for (const rows of rowsByTeam.values()) {
    rows.sort(
      (left, right) => new Date(left.game.game_datetime_utc) - new Date(right.game.game_datetime_utc)
    );
  }

  const distanceMap = new Map(
    (distances || []).map((row) => [`${row.from_arena_id}:${row.to_arena_id}`, row])
  );

  const latestSeason = (games || [])
    .map((game) => game.season)
    .sort()
    .slice(-1)[0] || null;

  return { rowsByTeam, completedRows, distanceMap, latestSeason };
}

function buildUpcomingTeamSpot(team, opponentTeam, isHome, commenceTime, history, distanceMap) {
  const currentArena = opponentTeam ? NBA_ARENAS_BY_TEAM_ID.get(isHome ? team.id : opponentTeam.id) : null;
  const currentDate = new Date(commenceTime);
  const teamRows = (history.rowsByTeam.get(team.id) || []).filter(
    (row) => new Date(row.game.game_datetime_utc) < currentDate
  );
  const previous = teamRows.length ? teamRows[teamRows.length - 1] : null;
  const previousArenaId = previous ? previous.game.home_arena_id : null;
  const currentArenaId = currentArena?.id || null;
  const travelDistance =
    previousArenaId && currentArenaId
      ? distanceMap.get(`${previousArenaId}:${currentArenaId}`)?.distance_miles ?? null
      : null;
  const restDays =
    previous ? Math.max(diffDays(currentDate, new Date(previous.game.game_datetime_utc)) - 1, 0) : null;
  const backToBack = previous ? diffDays(currentDate, new Date(previous.game.game_datetime_utc)) === 1 : false;
  const timezoneChangeHours =
    previous && previousArenaId && currentArena
      ? parseTimeZoneOffsetHours(currentArena.timezone, currentDate) -
        parseTimeZoneOffsetHours(
          nbaTeams.find((nbaTeam) => nbaTeam.arena.id === previousArenaId)?.arena.timezone || currentArena.timezone,
          new Date(previous.game.game_datetime_utc)
        )
      : 0;
  const local = currentArena
    ? getLocalDateParts(commenceTime, currentArena.timezone)
    : { localDateTime: null, localHour: null, dayOfWeek: null };

  return {
    teamId: team.id,
    teamName: team.name,
    isHome,
    localDateTime: local.localDateTime,
    localHour: local.localHour,
    dayOfWeek: local.dayOfWeek,
    hourBucket: localHourBucket(local.localHour),
    restDays,
    restBucket: restBucket(restDays),
    backToBack,
    gamesLast3Days: countRecentGames(teamRows, currentDate, 3),
    gamesLast5Days: countRecentGames(teamRows, currentDate, 5),
    gamesLast7Days: countRecentGames(teamRows, currentDate, 7),
    travelDistanceFromPrevGame:
      typeof travelDistance === "number" ? Number(travelDistance.toFixed(1)) : null,
    travelDistanceLast3Games: (() => {
      const recentGames = teamRows.slice(-3);
      let miles = typeof travelDistance === "number" ? travelDistance : 0;
      for (let index = 1; index < recentGames.length; index += 1) {
        const priorArenaIdFromHistory = recentGames[index - 1].game.home_arena_id;
        const currentArenaIdFromHistory = recentGames[index].game.home_arena_id;
        miles +=
          distanceMap.get(`${priorArenaIdFromHistory}:${currentArenaIdFromHistory}`)?.distance_miles || 0;
      }
      return Number(miles.toFixed(1));
    })(),
    travelBucket: travelBucket(travelDistance),
    timezoneChangeHours: Number.isFinite(timezoneChangeHours)
      ? Number(timezoneChangeHours.toFixed(1))
      : 0,
    eastToWestTravel: timezoneChangeHours < 0,
    westToEastTravel: timezoneChangeHours > 0
  };
}

function buildHistoricalCategories(teamRows, opponentId, spot, history) {
  const teamStats = {
    overall: summarizeRows(teamRows),
    homeAway: pickSample(teamRows, (row) => row.is_home === spot.isHome),
    rest: pickSample(teamRows, (row) => restBucket(row.days_rest) === spot.restBucket),
    backToBack: pickSample(teamRows, (row) => Boolean(row.back_to_back) === spot.backToBack),
    travel: pickSample(
      teamRows,
      (row) => travelBucket(row.travel_distance_from_prev_game) === spot.travelBucket
    ),
    dayOfWeek: pickSample(teamRows, (row) => row.game.day_of_week === spot.dayOfWeek),
    tipoffWindow: pickSample(
      teamRows,
      (row) => localHourBucket(row.game.local_hour) === spot.hourBucket
    ),
    headToHead: pickSample(teamRows, (row) => {
      const opponentTeamId =
        row.game.home_team_id === row.team_id ? row.game.away_team_id : row.game.home_team_id;
      return opponentTeamId === opponentId;
    }),
    similarSpot: pickSample(
      teamRows,
      (row) =>
        row.is_home === spot.isHome &&
        restBucket(row.days_rest) === spot.restBucket &&
        Boolean(row.back_to_back) === spot.backToBack &&
        travelBucket(row.travel_distance_from_prev_game) === spot.travelBucket
    )
  };

  const leagueRows = history.completedRows.filter(
    (row) =>
      row.is_home === spot.isHome &&
      restBucket(row.days_rest) === spot.restBucket &&
      Boolean(row.back_to_back) === spot.backToBack &&
      travelBucket(row.travel_distance_from_prev_game) === spot.travelBucket
  );

  return {
    team: teamStats,
    leagueBaseline: summarizeRows(leagueRows)
  };
}

function blendScore(stats) {
  const weights = {
    overall: 1,
    homeAway: 1.5,
    rest: 1.25,
    backToBack: 1,
    travel: 1,
    dayOfWeek: 0.5,
    tipoffWindow: 0.5,
    headToHead: 0.75,
    similarSpot: 2
  };
  let score = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const sample = stats[key];
    if (!sample || !sample.games || sample.winPct == null) continue;
    const confidence = Math.min(sample.games, 20) / 20;
    score += sample.winPct * weight * confidence;
    totalWeight += weight * confidence;
  }

  return totalWeight ? Number((score / totalWeight).toFixed(1)) : null;
}

function buildPromptBlock(matchups) {
  const header = [
    "You are making NBA moneyline picks using a trained baseline model plus historical team performance by situation.",
    "Prioritize the model probabilities first, then use the historical category context as supporting evidence.",
    "Prioritize larger samples over tiny samples and avoid overreacting to sparse head-to-head data.",
    "Choose one side per game and explain the categories driving the pick."
  ].join(" ");

  const body = matchups
    .map((matchup) => {
      const lines = [
        `Matchup: ${matchup.awayTeam.teamName} @ ${matchup.homeTeam.teamName}`,
        `Scheduled tip: ${matchup.homeTeam.localDateTime} ${matchup.homeArena.timezone}`,
        `Odds: ${matchup.awayTeam.teamName} ML ${matchup.awayOdds.avgMoneyline ?? "N/A"} (${matchup.awayOdds.impliedWinPct ?? "N/A"}% implied), ${matchup.homeTeam.teamName} ML ${matchup.homeOdds.avgMoneyline ?? "N/A"} (${matchup.homeOdds.impliedWinPct ?? "N/A"}% implied)`,
        matchup.modelPrediction
          ? `Model probability: ${matchup.homeTeam.teamName} ${matchup.modelPrediction.homeWinPct}% vs ${matchup.awayTeam.teamName} ${matchup.modelPrediction.awayWinPct}%`
          : "Model probability: no trained model artifact loaded",
        `Historical lean: ${matchup.historicalLean.team}${matchup.historicalLean.edgePct == null ? "" : ` by ${matchup.historicalLean.edgePct} pts`}`,
        formatRecord(`${matchup.homeTeam.teamName} overall`, matchup.homeHistory.team.overall),
        formatRecord(`${matchup.homeTeam.teamName} home/away split`, matchup.homeHistory.team.homeAway),
        formatRecord(`${matchup.homeTeam.teamName} rest bucket (${matchup.homeTeam.restBucket})`, matchup.homeHistory.team.rest),
        formatRecord(`${matchup.homeTeam.teamName} travel bucket (${matchup.homeTeam.travelBucket})`, matchup.homeHistory.team.travel),
        formatRecord(`${matchup.homeTeam.teamName} back-to-back=${matchup.homeTeam.backToBack}`, matchup.homeHistory.team.backToBack),
        formatRecord(`${matchup.homeTeam.teamName} head-to-head vs ${matchup.awayTeam.teamName}`, matchup.homeHistory.team.headToHead),
        formatRecord(`${matchup.awayTeam.teamName} overall`, matchup.awayHistory.team.overall),
        formatRecord(`${matchup.awayTeam.teamName} home/away split`, matchup.awayHistory.team.homeAway),
        formatRecord(`${matchup.awayTeam.teamName} rest bucket (${matchup.awayTeam.restBucket})`, matchup.awayHistory.team.rest),
        formatRecord(`${matchup.awayTeam.teamName} travel bucket (${matchup.awayTeam.travelBucket})`, matchup.awayHistory.team.travel),
        formatRecord(`${matchup.awayTeam.teamName} back-to-back=${matchup.awayTeam.backToBack}`, matchup.awayHistory.team.backToBack),
        formatRecord(`${matchup.awayTeam.teamName} head-to-head vs ${matchup.homeTeam.teamName}`, matchup.awayHistory.team.headToHead),
        formatRecord("League baseline for this home-team spot", matchup.homeHistory.leagueBaseline),
        formatRecord("League baseline for this away-team spot", matchup.awayHistory.leagueBaseline)
      ];

      return lines.join("\n");
    })
    .join("\n\n");

  return `${header}\n\n${body}`;
}

function toDateKey(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function dateRangeKeys(startDate, endDate) {
  const keys = [];
  const current = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
  );
  const end = new Date(
    Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
  );

  while (current <= end) {
    keys.push(toDateKey(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return keys;
}

function buildAliases(competitor) {
  const aliases = new Set();
  const team = competitor?.team || {};
  const values = [
    competitor?.displayName,
    competitor?.shortDisplayName,
    team?.displayName,
    team?.shortDisplayName,
    team?.name,
    team?.abbreviation
  ];

  for (const value of values) {
    const normalized = normalizeTeamName(value);
    if (normalized) aliases.add(normalized);
  }

  return aliases;
}

async function fetchCompletedGames(startDate, endDate) {
  const dates = dateRangeKeys(startDate, endDate);
  const games = [];

  for (const { sport, league } of ESPN_LEAGUES) {
    for (const dateKey of dates) {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${dateKey}`;

      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        const payload = await response.json();

        for (const event of payload?.events || []) {
          const competition = event?.competitions?.[0];
          const competitors = competition?.competitors || [];
          if (competitors.length !== 2) continue;
          if (!competition?.status?.type?.completed) continue;

          const a = competitors[0];
          const b = competitors[1];
          const aAliases = buildAliases(a);
          const bAliases = buildAliases(b);

          let winner = null;
          if (a?.winner === true) winner = "a";
          if (b?.winner === true) winner = "b";
          if (!winner) continue;

          games.push({
            date: new Date(event?.date || competition?.date || Date.now()),
            aAliases,
            bAliases,
            winner,
            loser: winner === "a" ? "b" : "a"
          });
        }
      } catch (_err) {
        // Ignore a failed league/date pull and continue with others.
      }
    }
  }

  return games;
}

function findGameForMatchup(games, pickTeam, opponentTeam) {
  for (const game of games) {
    const pickIsA = teamMatch(pickTeam, game.aAliases);
    const pickIsB = teamMatch(pickTeam, game.bAliases);
    const oppIsA = teamMatch(opponentTeam, game.aAliases);
    const oppIsB = teamMatch(opponentTeam, game.bAliases);

    if ((pickIsA && oppIsB) || (pickIsB && oppIsA)) {
      return {
        outcome: pickIsA ? (game.winner === "a" ? "win" : "loss") : game.winner === "b" ? "win" : "loss"
      };
    }
  }
  return null;
}

function findTeamOutcome(games, teamName) {
  for (const game of games) {
    if (teamMatch(teamName, game.aAliases)) {
      return game.winner === "a" ? "win" : "loss";
    }
    if (teamMatch(teamName, game.bAliases)) {
      return game.winner === "b" ? "win" : "loss";
    }
  }
  return null;
}

function upsertResult(line, outcome) {
  const label = outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : "Pending";
  if (/\|\s*Result:\s*(Win|Loss|Pending)/i.test(line)) {
    return line.replace(/\|\s*Result:\s*(Win|Loss|Pending)/i, `| Result: ${label}`);
  }
  return `${line} | Result: ${label}`;
}

function settlePredictionMessage(rawMessage, createdAt, allGames) {
  if (!rawMessage || typeof rawMessage !== "string") {
    return { message: rawMessage || "", changed: false, settledItems: 0 };
  }

  const predictionDate = new Date(createdAt || Date.now());
  const windowStart = new Date(predictionDate);
  windowStart.setUTCDate(windowStart.getUTCDate() - 1);
  const windowEnd = new Date(predictionDate);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 2);

  const gamesWindow = allGames
    .filter((g) => g.date >= windowStart && g.date <= windowEnd)
    .sort((a, b) => a.date - b.date);

  const lines = rawMessage.split("\n");
  let currentSection = "";
  let changed = false;
  let settledItems = 0;

  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    const headerMatch = trimmed.match(
      /^(Safe Bets|Best Value Bets|Long Shots|2-Leg Parlays|3-Leg Parlays)\b/i
    );
    if (headerMatch) {
      currentSection = headerMatch[1].toLowerCase();
      return line;
    }

    if (!currentSection) return line;

    const cleaned = trimmed.replace(/^\d+\)\s*/, "").replace(/^-\s*/, "");
    let outcome = null;

    if (currentSection.includes("parlays")) {
      const mainPart = cleaned.split("|")[0];
      const teams = [...mainPart.matchAll(/([^+|]+?)\s+MoneyLine/gi)]
        .map((m) => m[1].trim())
        .filter(Boolean);

      if (teams.length > 0) {
        const outcomes = teams.map((team) => findTeamOutcome(gamesWindow, team));
        if (outcomes.some((r) => r === "loss")) outcome = "loss";
        else if (outcomes.every((r) => r === "win")) outcome = "win";
        else if (outcomes.some(Boolean)) outcome = "pending";
      }
    } else {
      const pickMatch = cleaned.match(/(.+?)\s+MoneyLine\s+vs\s+(.+?)(?:\s*\||$)/i);
      if (pickMatch) {
        const pickTeam = pickMatch[1].trim();
        const opponentTeam = pickMatch[2].trim();
        const match = findGameForMatchup(gamesWindow, pickTeam, opponentTeam);
        outcome = match?.outcome || null;
      }
    }

    if (!outcome) return line;
    const updatedLine = upsertResult(line, outcome);
    if (updatedLine !== line) changed = true;
    if (outcome === "win" || outcome === "loss") settledItems += 1;
    return updatedLine;
  });

  return {
    message: updatedLines.join("\n"),
    changed,
    settledItems
  };
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/predictions", async (_req, res) => {
  const { data, error } = await supabase
    .from("predictions")
    .select("id,title,league,games,ai_summary,raw_message,created_at")
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    return res.status(500).json({ error: "Failed to fetch predictions." });
  }

  const rows = (data || []).map(mapRow);
  const latest = rows[0] || null;

  res.json({
    latest,
    history: rows,
    updatedAt: latest ? latest.createdAt : null
  });
});

app.post("/api/predictions", async (req, res) => {
  if (INGEST_KEY) {
    const key = req.header("x-ingest-key");
    if (key !== INGEST_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const { title, league, games, aiSummary, rawMessage } = req.body || {};

  if ((!Array.isArray(games) || games.length === 0) && !rawMessage) {
    return res.status(400).json({
      error: "Provide either a non-empty games array or rawMessage text."
    });
  }

  const insertPayload = {
    title: title || "Daily Sports Predictions",
    league: league || "Mixed",
    games: Array.isArray(games) ? games : [],
    ai_summary: aiSummary || "",
    raw_message: rawMessage || ""
  };

  const { data, error } = await supabase
    .from("predictions")
    .insert(insertPayload)
    .select("id,title,league,games,ai_summary,raw_message,created_at")
    .single();

  if (error) {
    return res.status(500).json({ error: "Failed to save prediction." });
  }

  res.status(201).json({ ok: true, entry: mapRow(data) });
});

app.post("/api/settle", async (req, res) => {
  if (INGEST_KEY) {
    const key = req.header("x-ingest-key");
    if (key !== INGEST_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const daysBack = Number(req.body?.daysBack || 4);
  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - daysBack);
  const endDate = new Date();

  const { data: rows, error } = await supabase
    .from("predictions")
    .select("id,raw_message,created_at")
    .gte("created_at", startDate.toISOString())
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return res.status(500).json({ error: "Failed to load predictions for settlement." });
  }

  const completedGames = await fetchCompletedGames(startDate, endDate);
  let updatedCount = 0;
  let settledItemCount = 0;

  for (const row of rows || []) {
    const result = settlePredictionMessage(row.raw_message, row.created_at, completedGames);
    if (!result.changed) continue;

    const { error: updateError } = await supabase
      .from("predictions")
      .update({ raw_message: result.message })
      .eq("id", row.id);

    if (!updateError) {
      updatedCount += 1;
      settledItemCount += result.settledItems;
    }
  }

  res.json({
    ok: true,
    scannedPredictions: (rows || []).length,
    updatedPredictions: updatedCount,
    settledItems: settledItemCount,
    fetchedGames: completedGames.length
  });
});

app.post("/api/nba/pick-context", async (req, res) => {
  if (INGEST_KEY) {
    const key = req.header("x-ingest-key");
    if (key !== INGEST_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const inputGames = Array.isArray(req.body?.games) ? req.body.games : [];
  if (!inputGames.length) {
    return res.status(400).json({ error: "Provide a non-empty games array." });
  }

  try {
    const history = await loadNbaWarehouse();
    const modelArtifact = loadNbaModelArtifact();
    const matchups = [];
    const unresolved = [];

    for (const rawGame of inputGames) {
      const parsed = parseOddsGame(rawGame);
      const homeTeam = findNbaTeam(parsed.homeTeamName);
      const awayTeam = findNbaTeam(parsed.awayTeamName);

      if (!homeTeam || !awayTeam) {
        unresolved.push({
          homeTeamName: parsed.homeTeamName,
          awayTeamName: parsed.awayTeamName
        });
        continue;
      }

      const homeSpot = buildUpcomingTeamSpot(
        homeTeam,
        awayTeam,
        true,
        parsed.commenceTime,
        history,
        history.distanceMap
      );
      const awaySpot = buildUpcomingTeamSpot(
        awayTeam,
        homeTeam,
        false,
        parsed.commenceTime,
        history,
        history.distanceMap
      );
      const homeRows = history.rowsByTeam.get(homeTeam.id) || [];
      const awayRows = history.rowsByTeam.get(awayTeam.id) || [];
      const homeHistory = buildHistoricalCategories(homeRows, awayTeam.id, homeSpot, history);
      const awayHistory = buildHistoricalCategories(awayRows, homeTeam.id, awaySpot, history);
      const filteredHomeRows = homeRows.filter(
        (row) => new Date(row.game.game_datetime_utc) < new Date(parsed.commenceTime)
      );
      const filteredAwayRows = awayRows.filter(
        (row) => new Date(row.game.game_datetime_utc) < new Date(parsed.commenceTime)
      );
      const homeFeatureObject = buildModelFeatureObject({
        teamSpot: homeSpot,
        opponentSpot: awaySpot,
        teamRows: filteredHomeRows,
        opponentRows: filteredAwayRows,
        isPlayoff: false
      });
      const awayFeatureObject = buildModelFeatureObject({
        teamSpot: awaySpot,
        opponentSpot: homeSpot,
        teamRows: filteredAwayRows,
        opponentRows: filteredHomeRows,
        isPlayoff: false
      });
      const rawHomeProb = modelArtifact ? scoreFeatureObject(homeFeatureObject, modelArtifact) : null;
      const rawAwayProb = modelArtifact ? scoreFeatureObject(awayFeatureObject, modelArtifact) : null;
      const modelPrediction =
        rawHomeProb != null && rawAwayProb != null && rawHomeProb + rawAwayProb > 0
          ? {
              homeWinPct: Number(((rawHomeProb / (rawHomeProb + rawAwayProb)) * 100).toFixed(1)),
              awayWinPct: Number(((rawAwayProb / (rawHomeProb + rawAwayProb)) * 100).toFixed(1))
            }
          : null;
      const homeScore = blendScore(homeHistory.team);
      const awayScore = blendScore(awayHistory.team);
      const homeOdds =
        parsed.teams.find((team) => normalizeTeamName(team.name) === normalizeTeamName(parsed.homeTeamName)) ||
        parsed.teams[1] ||
        {};
      const awayOdds =
        parsed.teams.find((team) => normalizeTeamName(team.name) === normalizeTeamName(parsed.awayTeamName)) ||
        parsed.teams[0] ||
        {};

      matchups.push({
        matchup: `${awayTeam.name} @ ${homeTeam.name}`,
        commenceTimeUtc: parsed.commenceTime,
        season: history.latestSeason,
        homeArena: NBA_ARENAS_BY_TEAM_ID.get(homeTeam.id),
        homeTeam: homeSpot,
        awayTeam: awaySpot,
        homeOdds,
        awayOdds,
        modelPrediction,
        homeHistory,
        awayHistory,
        historicalLean: {
          team:
            homeScore == null || awayScore == null
              ? "No lean"
              : homeScore >= awayScore
                ? homeTeam.name
                : awayTeam.name,
          edgePct:
            homeScore == null || awayScore == null
              ? null
              : Number(Math.abs(homeScore - awayScore).toFixed(1)),
          homeScore,
          awayScore
        }
      });
    }

    if (!matchups.length) {
      return res.status(400).json({
        error: "None of the provided games could be mapped to NBA teams.",
        unresolvedTeams: unresolved
      });
    }

    res.json({
      ok: true,
      season: history.latestSeason,
      generatedAt: new Date().toISOString(),
      modelAvailable: Boolean(modelArtifact),
      unresolvedTeams: unresolved,
      games: matchups,
      prompt: buildPromptBlock(matchups)
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to build NBA pick context.",
      details: error?.message || "Unknown error"
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Sports dashboard running on http://localhost:${PORT}`);
});
