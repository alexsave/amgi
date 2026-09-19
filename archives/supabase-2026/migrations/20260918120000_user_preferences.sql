-- The settings page has always read and written user_preferences, but no
-- migration ever created the table, so loading settings errored and saving
-- them failed in any environment built from this repo. Written idempotently
-- so it is safe to apply to a project where the table was created by hand.

create table if not exists user_preferences (
  user_id uuid primary key references auth.users on delete cascade,
  daily_goal int not null default 50,
  preferred_language text not null default 'en',
  notifications_enabled boolean not null default true,
  dark_mode boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table user_preferences enable row level security;

drop policy if exists "Users can view their own preferences" on user_preferences;
drop policy if exists "Users can insert their own preferences" on user_preferences;
drop policy if exists "Users can update their own preferences" on user_preferences;

create policy "Users can view their own preferences"
  on user_preferences for select
  using (auth.uid() = user_id);

create policy "Users can insert their own preferences"
  on user_preferences for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own preferences"
  on user_preferences for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
