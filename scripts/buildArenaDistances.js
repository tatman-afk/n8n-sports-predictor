const { getSupabaseClient } = require("./lib/env");
const {
  teams,
  haversineMiles,
  estimateFlightMinutes
} = require("./lib/nba");

async function main() {
  const supabase = getSupabaseClient();
  const arenas = teams.map((team) => team.arena);
  const rows = [];

  for (const fromArena of arenas) {
    for (const toArena of arenas) {
      const distanceMiles = haversineMiles(
        fromArena.latitude,
        fromArena.longitude,
        toArena.latitude,
        toArena.longitude
      );

      rows.push({
        from_arena_id: fromArena.id,
        to_arena_id: toArena.id,
        distance_miles: Number(distanceMiles.toFixed(2)),
        distance_km: Number((distanceMiles * 1.60934).toFixed(2)),
        flight_time_est_minutes: estimateFlightMinutes(distanceMiles)
      });
    }
  }

  const result = await supabase.from("arena_distances").upsert(rows);
  if (result.error) throw result.error;

  console.log(`Upserted ${rows.length} arena distance rows.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
