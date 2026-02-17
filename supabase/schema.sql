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
