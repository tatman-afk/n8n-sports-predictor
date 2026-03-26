const BASE_FEATURE_COLUMNS = [
  "team_is_home",
  "game_local_hour",
  "game_day_of_week",
  "game_is_weekend",
  "game_is_playoff",
  "team_days_rest",
  "team_back_to_back",
  "team_games_last_3_days",
  "team_games_last_5_days",
  "team_games_last_7_days",
  "team_travel_distance_from_prev_game",
  "team_travel_distance_last_3_games",
  "team_timezone_change_hours",
  "team_east_to_west_travel",
  "team_west_to_east_travel",
  "opp_days_rest",
  "opp_back_to_back",
  "opp_games_last_3_days",
  "opp_games_last_5_days",
  "opp_games_last_7_days",
  "opp_travel_distance_from_prev_game",
  "opp_travel_distance_last_3_games",
  "opp_timezone_change_hours",
  "opp_east_to_west_travel",
  "opp_west_to_east_travel",
  "rest_diff",
  "travel_diff",
  "timezone_diff",
  "team_last_5_win_pct",
  "team_last_10_win_pct",
  "team_last_5_point_diff",
  "team_last_10_point_diff",
  "opp_last_5_win_pct",
  "opp_last_10_win_pct",
  "opp_last_5_point_diff",
  "opp_last_10_point_diff",
  "win_pct_5_diff",
  "win_pct_10_diff",
  "point_diff_5_diff",
  "point_diff_10_diff"
];

const STAT_DEFINITIONS = [
  { key: "points", offenseKey: "points", defenseKey: "pointsAllowed" },
  { key: "field_goal_pct", offenseKey: "fieldGoalPct", defenseKey: "oppFieldGoalPct" },
  { key: "three_point_pct", offenseKey: "threePointPct", defenseKey: "oppThreePointPct" },
  { key: "free_throw_pct", offenseKey: "freeThrowPct", defenseKey: "oppFreeThrowPct" },
  { key: "rebounds", offenseKey: "rebounds", defenseKey: "oppRebounds" },
  { key: "offensive_rebounds", offenseKey: "offensiveRebounds", defenseKey: "oppOffensiveRebounds" },
  { key: "defensive_rebounds", offenseKey: "defensiveRebounds", defenseKey: "oppDefensiveRebounds" },
  { key: "assists", offenseKey: "assists", defenseKey: "oppAssists" },
  { key: "steals", offenseKey: "steals", defenseKey: "oppSteals" },
  { key: "blocks", offenseKey: "blocks", defenseKey: "oppBlocks" },
  { key: "turnovers", offenseKey: "turnovers", defenseKey: "oppTurnovers" },
  { key: "fouls", offenseKey: "fouls", defenseKey: "oppFouls" }
];

const WINDOW_SIZES = [5, 10];

const STAT_FEATURE_COLUMNS = [];
for (const stat of STAT_DEFINITIONS) {
  for (const window of WINDOW_SIZES) {
    STAT_FEATURE_COLUMNS.push(
      `team_last_${window}_${stat.key}_offense`,
      `team_last_${window}_${stat.key}_defense_allowed`,
      `opp_last_${window}_${stat.key}_offense`,
      `opp_last_${window}_${stat.key}_defense_allowed`,
      `${stat.key}_offense_diff_last_${window}`,
      `${stat.key}_defense_diff_last_${window}`,
      `${stat.key}_matchup_edge_last_${window}`
    );
  }
}

const FEATURE_COLUMNS = [...BASE_FEATURE_COLUMNS, ...STAT_FEATURE_COLUMNS];

function toNumber(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function isWeekend(dayOfWeek) {
  return dayOfWeek === 0 || dayOfWeek === 6 ? 1 : 0;
}

function getTeamWin(row) {
  if (!row?.game || row.game.home_win == null) return null;
  return row.is_home ? Boolean(row.game.home_win) : !row.game.home_win;
}

function getTeamPointDiff(row) {
  if (!row?.game) return 0;
  const homeScore = Number(row.game.home_score);
  const awayScore = Number(row.game.away_score);
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return 0;
  return row.is_home ? homeScore - awayScore : awayScore - homeScore;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function extractBoxscoreStats(row) {
  const box = row?.boxscore || {};
  return {
    points: toNumber(box.points),
    pointsAllowed: toNumber(box.pointsAllowed),
    fieldGoalPct: toNumber(box.fieldGoalPct),
    oppFieldGoalPct: toNumber(box.oppFieldGoalPct),
    threePointPct: toNumber(box.threePointPct),
    oppThreePointPct: toNumber(box.oppThreePointPct),
    freeThrowPct: toNumber(box.freeThrowPct),
    oppFreeThrowPct: toNumber(box.oppFreeThrowPct),
    rebounds: toNumber(box.rebounds),
    oppRebounds: toNumber(box.oppRebounds),
    offensiveRebounds: toNumber(box.offensiveRebounds),
    oppOffensiveRebounds: toNumber(box.oppOffensiveRebounds),
    defensiveRebounds: toNumber(box.defensiveRebounds),
    oppDefensiveRebounds: toNumber(box.oppDefensiveRebounds),
    assists: toNumber(box.assists),
    oppAssists: toNumber(box.oppAssists),
    steals: toNumber(box.steals),
    oppSteals: toNumber(box.oppSteals),
    blocks: toNumber(box.blocks),
    oppBlocks: toNumber(box.oppBlocks),
    turnovers: toNumber(box.turnovers),
    oppTurnovers: toNumber(box.oppTurnovers),
    fouls: toNumber(box.fouls),
    oppFouls: toNumber(box.oppFouls)
  };
}

function buildRollingSummary(historyRows) {
  const completedRows = historyRows.filter((row) => getTeamWin(row) != null);
  const last5 = completedRows.slice(-5);
  const last10 = completedRows.slice(-10);
  const summary = {
    last5WinPct: average(last5.map((row) => (getTeamWin(row) ? 1 : 0))),
    last10WinPct: average(last10.map((row) => (getTeamWin(row) ? 1 : 0))),
    last5PointDiff: average(last5.map((row) => getTeamPointDiff(row))),
    last10PointDiff: average(last10.map((row) => getTeamPointDiff(row)))
  };

  for (const stat of STAT_DEFINITIONS) {
    for (const window of WINDOW_SIZES) {
      const sample = completedRows.slice(-window).map(extractBoxscoreStats);
      summary[`last${window}${stat.offenseKey}`] = average(sample.map((row) => row[stat.offenseKey]));
      summary[`last${window}${stat.defenseKey}`] = average(sample.map((row) => row[stat.defenseKey]));
    }
  }

  return summary;
}

function buildModelFeatureObject({ teamSpot, opponentSpot, teamRows, opponentRows, isPlayoff }) {
  const teamSummary = buildRollingSummary(teamRows);
  const opponentSummary = buildRollingSummary(opponentRows);

  const featureObject = {
    team_is_home: teamSpot.isHome ? 1 : 0,
    game_local_hour: toNumber(teamSpot.localHour),
    game_day_of_week: toNumber(teamSpot.dayOfWeek),
    game_is_weekend: isWeekend(teamSpot.dayOfWeek),
    game_is_playoff: isPlayoff ? 1 : 0,
    team_days_rest: toNumber(teamSpot.daysRest),
    team_back_to_back: teamSpot.backToBack ? 1 : 0,
    team_games_last_3_days: toNumber(teamSpot.gamesLast3Days),
    team_games_last_5_days: toNumber(teamSpot.gamesLast5Days),
    team_games_last_7_days: toNumber(teamSpot.gamesLast7Days),
    team_travel_distance_from_prev_game: toNumber(teamSpot.travelDistanceFromPrevGame),
    team_travel_distance_last_3_games: toNumber(teamSpot.travelDistanceLast3Games),
    team_timezone_change_hours: toNumber(teamSpot.timezoneChangeHours),
    team_east_to_west_travel: teamSpot.eastToWestTravel ? 1 : 0,
    team_west_to_east_travel: teamSpot.westToEastTravel ? 1 : 0,
    opp_days_rest: toNumber(opponentSpot.daysRest),
    opp_back_to_back: opponentSpot.backToBack ? 1 : 0,
    opp_games_last_3_days: toNumber(opponentSpot.gamesLast3Days),
    opp_games_last_5_days: toNumber(opponentSpot.gamesLast5Days),
    opp_games_last_7_days: toNumber(opponentSpot.gamesLast7Days),
    opp_travel_distance_from_prev_game: toNumber(opponentSpot.travelDistanceFromPrevGame),
    opp_travel_distance_last_3_games: toNumber(opponentSpot.travelDistanceLast3Games),
    opp_timezone_change_hours: toNumber(opponentSpot.timezoneChangeHours),
    opp_east_to_west_travel: opponentSpot.eastToWestTravel ? 1 : 0,
    opp_west_to_east_travel: opponentSpot.westToEastTravel ? 1 : 0,
    rest_diff: toNumber(teamSpot.daysRest) - toNumber(opponentSpot.daysRest),
    travel_diff:
      toNumber(teamSpot.travelDistanceFromPrevGame) -
      toNumber(opponentSpot.travelDistanceFromPrevGame),
    timezone_diff:
      toNumber(teamSpot.timezoneChangeHours) - toNumber(opponentSpot.timezoneChangeHours),
    team_last_5_win_pct: teamSummary.last5WinPct,
    team_last_10_win_pct: teamSummary.last10WinPct,
    team_last_5_point_diff: teamSummary.last5PointDiff,
    team_last_10_point_diff: teamSummary.last10PointDiff,
    opp_last_5_win_pct: opponentSummary.last5WinPct,
    opp_last_10_win_pct: opponentSummary.last10WinPct,
    opp_last_5_point_diff: opponentSummary.last5PointDiff,
    opp_last_10_point_diff: opponentSummary.last10PointDiff,
    win_pct_5_diff: teamSummary.last5WinPct - opponentSummary.last5WinPct,
    win_pct_10_diff: teamSummary.last10WinPct - opponentSummary.last10WinPct,
    point_diff_5_diff: teamSummary.last5PointDiff - opponentSummary.last5PointDiff,
    point_diff_10_diff: teamSummary.last10PointDiff - opponentSummary.last10PointDiff
  };

  for (const stat of STAT_DEFINITIONS) {
    for (const window of WINDOW_SIZES) {
      const teamOffense = teamSummary[`last${window}${stat.offenseKey}`];
      const teamDefense = teamSummary[`last${window}${stat.defenseKey}`];
      const oppOffense = opponentSummary[`last${window}${stat.offenseKey}`];
      const oppDefense = opponentSummary[`last${window}${stat.defenseKey}`];

      featureObject[`team_last_${window}_${stat.key}_offense`] = teamOffense;
      featureObject[`team_last_${window}_${stat.key}_defense_allowed`] = teamDefense;
      featureObject[`opp_last_${window}_${stat.key}_offense`] = oppOffense;
      featureObject[`opp_last_${window}_${stat.key}_defense_allowed`] = oppDefense;
      featureObject[`${stat.key}_offense_diff_last_${window}`] = teamOffense - oppOffense;
      featureObject[`${stat.key}_defense_diff_last_${window}`] = oppDefense - teamDefense;
      featureObject[`${stat.key}_matchup_edge_last_${window}`] = teamOffense - oppDefense;
    }
  }

  return featureObject;
}

function featureRowFromObject(featureObject) {
  return FEATURE_COLUMNS.map((column) => toNumber(featureObject[column]));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function scoreFeatureObject(featureObject, artifact) {
  if (!artifact || !Array.isArray(artifact.feature_columns) || !Array.isArray(artifact.coefficients)) {
    return null;
  }

  const vector = artifact.feature_columns.map((column) => toNumber(featureObject[column]));
  const means = Array.isArray(artifact.means) ? artifact.means : [];
  const scales = Array.isArray(artifact.scales) ? artifact.scales : [];
  let linear = toNumber(artifact.intercept);

  for (let index = 0; index < vector.length; index += 1) {
    const scale = toNumber(scales[index], 1) || 1;
    const mean = toNumber(means[index], 0);
    const standardized = (vector[index] - mean) / scale;
    linear += standardized * toNumber(artifact.coefficients[index], 0);
  }

  return sigmoid(linear);
}

module.exports = {
  FEATURE_COLUMNS,
  STAT_DEFINITIONS,
  WINDOW_SIZES,
  getTeamWin,
  getTeamPointDiff,
  buildRollingSummary,
  buildModelFeatureObject,
  featureRowFromObject,
  scoreFeatureObject
};
