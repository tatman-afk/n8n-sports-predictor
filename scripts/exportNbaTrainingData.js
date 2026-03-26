const fs = require("fs");
const path = require("path");
const { getSupabaseClient } = require("./lib/env");
const { buildModelFeatureObject, FEATURE_COLUMNS, getTeamWin } = require("./lib/nbaModel");

function csvEscape(value) {
  const stringValue = value == null ? "" : String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function buildSpot(row) {
  return {
    isHome: row.is_home,
    localHour: row.game.local_hour,
    dayOfWeek: row.game.day_of_week,
    daysRest: row.days_rest,
    backToBack: row.back_to_back,
    gamesLast3Days: row.games_last_3_days,
    gamesLast5Days: row.games_last_5_days,
    gamesLast7Days: row.games_last_7_days,
    travelDistanceFromPrevGame: row.travel_distance_from_prev_game,
    travelDistanceLast3Games: row.travel_distance_last_3_games,
    timezoneChangeHours: row.timezone_change_hours,
    eastToWestTravel: row.east_to_west_travel,
    westToEastTravel: row.west_to_east_travel
  };
}

async function main() {
  const supabase = getSupabaseClient();
  const season = process.argv[2] || null;
  const outputPath =
    process.argv[3] ||
    path.join(__dirname, "..", "model", "generated", `nba_training_${season || "all"}.csv`);

  const gamesQuery = supabase
    .from("games")
    .select("*")
    .not("home_win", "is", null)
    .order("game_datetime_utc", { ascending: true });
  const featuresQuery = supabase.from("team_game_features").select("*");

  if (season) {
    gamesQuery.eq("season", season);
  }

  const [{ data: games, error: gamesError }, { data: features, error: featuresError }] =
    await Promise.all([gamesQuery, featuresQuery]);

  if (gamesError) throw gamesError;
  if (featuresError) throw featuresError;

  const gamesById = new Map((games || []).map((game) => [game.game_id, game]));
  const featuresByGameId = new Map();

  for (const row of features || []) {
    const game = gamesById.get(row.game_id);
    if (!game) continue;
    const bucket = featuresByGameId.get(row.game_id) || [];
    bucket.push({ ...row, game });
    featuresByGameId.set(row.game_id, bucket);
  }

  const historyByTeam = new Map();
  const datasetRows = [];

  for (const game of games || []) {
    const gameRows = (featuresByGameId.get(game.game_id) || []).sort((left, right) =>
      left.is_home === right.is_home ? 0 : left.is_home ? -1 : 1
    );
    if (gameRows.length !== 2) continue;

    for (const row of gameRows) {
      const opponentRow = gameRows.find((candidate) => candidate.team_id !== row.team_id);
      if (!opponentRow) continue;

      const teamHistory = (historyByTeam.get(row.team_id) || []).slice();
      const opponentHistory = (historyByTeam.get(opponentRow.team_id) || []).slice();
      const featureObject = buildModelFeatureObject({
        teamSpot: buildSpot(row),
        opponentSpot: buildSpot(opponentRow),
        teamRows: teamHistory,
        opponentRows: opponentHistory,
        isPlayoff: game.is_playoff
      });
      const wonGame = getTeamWin(row);
      if (wonGame == null) continue;

      datasetRows.push({
        game_id: game.game_id,
        game_datetime_utc: game.game_datetime_utc,
        season: game.season,
        team_id: row.team_id,
        opponent_team_id: opponentRow.team_id,
        won_game: wonGame ? 1 : 0,
        ...featureObject
      });
    }

    for (const row of gameRows) {
      const history = historyByTeam.get(row.team_id) || [];
      history.push(row);
      historyByTeam.set(row.team_id, history);
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const header = [
    "game_id",
    "game_datetime_utc",
    "season",
    "team_id",
    "opponent_team_id",
    "won_game",
    ...FEATURE_COLUMNS
  ];
  const lines = [header.join(",")];

  for (const row of datasetRows) {
    lines.push(header.map((column) => csvEscape(row[column])).join(","));
  }

  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Exported ${datasetRows.length} training rows to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
