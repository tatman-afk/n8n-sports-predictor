const { getSupabaseClient } = require("./lib/env");
const { teams } = require("./lib/nba");

async function main() {
  const supabase = getSupabaseClient();

  const teamRows = teams.map((team) => ({
    id: team.id,
    name: team.name,
    abbreviation: team.abbreviation
  }));

  const arenaRows = teams.map((team) => ({
    id: team.arena.id,
    team_id: team.id,
    arena_name: team.arena.name,
    city: team.arena.city,
    state: team.arena.state,
    timezone: team.arena.timezone,
    latitude: team.arena.latitude,
    longitude: team.arena.longitude
  }));

  const teamResult = await supabase.from("teams").upsert(teamRows);
  if (teamResult.error) throw teamResult.error;

  const arenaResult = await supabase.from("arenas").upsert(arenaRows);
  if (arenaResult.error) throw arenaResult.error;

  console.log(`Seeded ${teamRows.length} teams and ${arenaRows.length} arenas.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
