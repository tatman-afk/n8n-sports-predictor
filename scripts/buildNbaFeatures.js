const { getSupabaseClient } = require("./lib/env");
const { arenasById, timezoneOffsetHours } = require("./lib/nba");

function parseArgs() {
  const yearArg = process.argv[2];
  if (!yearArg || !/^\d{4}$/.test(yearArg)) {
    throw new Error("Usage: node scripts/buildNbaFeatures.js <seasonStartYear>");
  }
  const startYear = Number(yearArg);
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

function diffDays(currentDate, previousDate) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.round((currentDate - previousDate) / millisecondsPerDay);
}

function countGamesWithinWindow(history, currentDate, days) {
  const windowStart = new Date(currentDate);
  windowStart.setUTCDate(windowStart.getUTCDate() - days);
  return history.filter((game) => game.date > windowStart && game.date < currentDate).length;
}

async function main() {
  const season = parseArgs();
  const supabase = getSupabaseClient();

  const gamesResult = await supabase
    .from("games")
    .select("*")
    .eq("season", season)
    .order("game_datetime_utc", { ascending: true });

  if (gamesResult.error) throw gamesResult.error;

  const distanceResult = await supabase.from("arena_distances").select("*");
  if (distanceResult.error) throw distanceResult.error;

  const distanceMap = new Map(
    distanceResult.data.map((row) => [`${row.from_arena_id}:${row.to_arena_id}`, row])
  );

  const teamSchedules = new Map();

  for (const game of gamesResult.data) {
    for (const side of [
      { teamId: game.home_team_id, isHome: true, arenaId: game.home_arena_id },
      { teamId: game.away_team_id, isHome: false, arenaId: game.home_arena_id }
    ]) {
      const schedule = teamSchedules.get(side.teamId) || [];
      schedule.push({
        gameId: game.game_id,
        date: new Date(game.game_datetime_utc),
        arenaId: side.arenaId,
        isHome: side.isHome
      });
      teamSchedules.set(side.teamId, schedule);
    }
  }

  const rows = [];

  for (const [teamId, schedule] of teamSchedules.entries()) {
    schedule.sort((a, b) => a.date - b.date);

    for (let index = 0; index < schedule.length; index += 1) {
      const current = schedule[index];
      const previous = index > 0 ? schedule[index - 1] : null;
      const recentGames = schedule.slice(Math.max(0, index - 3), index + 1);
      const currentTimezone = arenasById.get(current.arenaId)?.timezone || "UTC";
      const previousTimezone = previous
        ? arenasById.get(previous.arenaId)?.timezone || currentTimezone
        : currentTimezone;
      const timezoneChangeHours = previous
        ? timezoneOffsetHours(currentTimezone, current.date) -
          timezoneOffsetHours(previousTimezone, previous.date)
        : 0;
      const distance =
        previous && distanceMap.get(`${previous.arenaId}:${current.arenaId}`)
          ? distanceMap.get(`${previous.arenaId}:${current.arenaId}`).distance_miles
          : null;

      const recentTravel = recentGames.reduce((sum, game, recentIndex) => {
        if (recentIndex === 0) return sum;
        const prior = recentGames[recentIndex - 1];
        const leg = distanceMap.get(`${prior.arenaId}:${game.arenaId}`);
        return sum + (leg ? leg.distance_miles : 0);
      }, 0);

      rows.push({
        game_id: current.gameId,
        team_id: teamId,
        is_home: current.isHome,
        previous_game_id: previous ? previous.gameId : null,
        previous_arena_id: previous ? previous.arenaId : null,
        days_rest: previous ? Math.max(diffDays(current.date, previous.date) - 1, 0) : null,
        back_to_back: previous ? diffDays(current.date, previous.date) === 1 : false,
        games_last_3_days: countGamesWithinWindow(schedule.slice(0, index), current.date, 3),
        games_last_5_days: countGamesWithinWindow(schedule.slice(0, index), current.date, 5),
        games_last_7_days: countGamesWithinWindow(schedule.slice(0, index), current.date, 7),
        travel_distance_from_prev_game: distance,
        travel_distance_last_3_games: recentTravel,
        timezone_change_hours: timezoneChangeHours,
        east_to_west_travel: timezoneChangeHours < 0,
        west_to_east_travel: timezoneChangeHours > 0
      });
    }
  }

  const upsertResult = await supabase.from("team_game_features").upsert(rows);
  if (upsertResult.error) throw upsertResult.error;

  console.log(`Upserted ${rows.length} team feature rows for ${season}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
