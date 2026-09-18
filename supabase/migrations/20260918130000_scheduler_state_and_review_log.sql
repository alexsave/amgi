-- Scheduler state that the algorithm could not previously persist, plus the
-- per-answer log. Written idempotently so it is safe to re-apply.

-- Which learning step a card is waiting on. Deriving it from `repetitions`
-- would break the moment a card lapses, so it gets its own column.
alter table reviews add column if not exists learning_step int not null default 0;

-- Times a graduated card was forgotten. Anki tags a card as a leech at 8.
alter table reviews add column if not exists lapses int not null default 0;

-- One row per answer. The reviews row only ever holds the card's current
-- state, so without this there is no history to compute statistics from and
-- nothing an FSRS optimiser could ever be trained on.
create table if not exists review_logs (
  id uuid default uuid_generate_v4() primary key,
  card_id uuid references cards(id) on delete cascade not null,
  user_id uuid references auth.users on delete cascade not null,
  reviewed_at timestamptz not null default now(),
  -- The review loop is binary today, but the four Anki ratings are allowed so
  -- that adding buttons later does not need a migration of historical rows.
  rating text not null check (rating in ('again', 'hard', 'good', 'easy')),
  -- State as it was *before* this answer, which is what a scheduler has to be
  -- replayed against. The state after is recomputable from this plus rating.
  card_state text not null check (card_state in ('new', 'learning', 'review')),
  interval_days int not null,
  ease_factor real not null,
  repetitions int not null,
  -- Whole days actually waited since the previous answer (null for the
  -- first), and whole days the card had been asked to wait. They diverge on
  -- late reviews, which is the signal FSRS learns from.
  elapsed_days int,
  scheduled_days int
);

create index if not exists review_logs_user_reviewed_idx on review_logs(user_id, reviewed_at);
create index if not exists review_logs_card_reviewed_idx on review_logs(card_id, reviewed_at);

alter table review_logs enable row level security;

-- The log is append-only: there is no update or delete policy, because
-- rewriting history would silently corrupt any model trained on it.
drop policy if exists "Users can view their own review logs" on review_logs;
drop policy if exists "Users can insert their own review logs" on review_logs;

create policy "Users can view their own review logs"
  on review_logs for select
  using (auth.uid() = user_id);

create policy "Users can insert their own review logs"
  on review_logs for insert
  with check (auth.uid() = user_id);
