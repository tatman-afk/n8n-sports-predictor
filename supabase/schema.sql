create table if not exists public.predictions (
  id bigint generated always as identity primary key,
  title text not null default 'Daily Sports Predictions',
  league text not null default 'Mixed',
  games jsonb not null default '[]'::jsonb,
  ai_summary text not null default '',
  raw_message text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists predictions_created_at_idx
  on public.predictions (created_at desc);

create table if not exists public.teams (
  id text primary key,
  name text not null,
  abbreviation text not null unique
);

create table if not exists public.arenas (
  id text primary key,
  team_id text not null references public.teams (id),
  arena_name text not null,
  city text not null,
  state text not null,
  timezone text not null,
  latitude double precision not null,
  longitude double precision not null
);

create table if not exists public.games (
  game_id text primary key,
  season text not null,
  status text not null,
  game_date date not null,
  game_datetime_utc timestamptz not null,
  game_datetime_local timestamp not null,
  local_hour integer not null,
  day_of_week integer not null,
  home_team_id text not null references public.teams (id),
  away_team_id text not null references public.teams (id),
  home_arena_id text not null references public.arenas (id),
  away_arena_id text not null references public.arenas (id),
  home_score integer,
  away_score integer,
  home_win boolean,
  is_playoff boolean not null default false,
  ot_periods integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists games_season_game_date_idx
  on public.games (season, game_date);

create index if not exists games_home_team_date_idx
  on public.games (home_team_id, game_date);

create index if not exists games_away_team_date_idx
  on public.games (away_team_id, game_date);

create table if not exists public.arena_distances (
  from_arena_id text not null references public.arenas (id),
  to_arena_id text not null references public.arenas (id),
  distance_miles double precision not null,
  distance_km double precision not null,
  flight_time_est_minutes integer,
  created_at timestamptz not null default now(),
  primary key (from_arena_id, to_arena_id)
);

create table if not exists public.team_game_features (
  game_id text not null references public.games (game_id) on delete cascade,
  team_id text not null references public.teams (id),
  is_home boolean not null,
  previous_game_id text references public.games (game_id),
  previous_arena_id text references public.arenas (id),
  days_rest integer,
  back_to_back boolean not null default false,
  games_last_3_days integer not null default 0,
  games_last_5_days integer not null default 0,
  games_last_7_days integer not null default 0,
  travel_distance_from_prev_game double precision,
  travel_distance_last_3_games double precision,
  timezone_change_hours integer,
  east_to_west_travel boolean not null default false,
  west_to_east_travel boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (game_id, team_id)
);

create index if not exists team_game_features_team_id_idx
  on public.team_game_features (team_id, game_id);
