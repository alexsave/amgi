-- Create tables for flashcard app
create extension if not exists "uuid-ossp";

-- Decks table
create table decks (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users not null,
  name text not null,
  created_at timestamp default now()
);

-- Cards table
create table cards (
  id uuid default uuid_generate_v4() primary key,
  deck_id uuid references decks(id) not null,
  front_text text not null,
  back_text text not null,
  front_audio_url text,  -- TTS for front
  back_audio_url text,   -- TTS for back
  created_at timestamp default now()
);

-- Reviews table for spaced repetition
create table reviews (
  id uuid default uuid_generate_v4() primary key,
  card_id uuid references cards(id) not null,
  user_id uuid references auth.users not null,
  scheduled_date date not null,
  interval_days int default 1,
  ease_factor float default 2.5,
  repetitions int default 0,
  last_reviewed_at timestamp,
  next_review_date date
);

-- Add indexes for better query performance
create index cards_deck_id_idx on cards(deck_id);
create index reviews_card_id_idx on reviews(card_id);
create index reviews_user_id_idx on reviews(user_id);
create index reviews_next_review_date_idx on reviews(next_review_date);

-- Add RLS (Row Level Security) policies
alter table decks enable row level security;
alter table cards enable row level security;
alter table reviews enable row level security;

-- Deck policies
create policy "Users can view their own decks"
  on decks for select
  using (auth.uid() = user_id);

create policy "Users can insert their own decks"
  on decks for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own decks"
  on decks for update
  using (auth.uid() = user_id);

create policy "Users can delete their own decks"
  on decks for delete
  using (auth.uid() = user_id);

-- Card policies
create policy "Users can view cards in their decks"
  on cards for select
  using (exists (
    select 1 from decks
    where decks.id = cards.deck_id
    and decks.user_id = auth.uid()
  ));

create policy "Users can insert cards in their decks"
  on cards for insert
  with check (exists (
    select 1 from decks
    where decks.id = cards.deck_id
    and decks.user_id = auth.uid()
  ));

create policy "Users can update cards in their decks"
  on cards for update
  using (exists (
    select 1 from decks
    where decks.id = cards.deck_id
    and decks.user_id = auth.uid()
  ));

create policy "Users can delete cards in their decks"
  on cards for delete
  using (exists (
    select 1 from decks
    where decks.id = cards.deck_id
    and decks.user_id = auth.uid()
  ));

-- Review policies
create policy "Users can view their own reviews"
  on reviews for select
  using (auth.uid() = user_id);

create policy "Users can insert their own reviews"
  on reviews for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own reviews"
  on reviews for update
  using (auth.uid() = user_id);

create policy "Users can delete their own reviews"
  on reviews for delete
  using (auth.uid() = user_id);

-- Subscription tiers table
create table subscription_tiers (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  realtime_minutes_limit int not null,
  voice_evaluations_limit int not null,
  stripe_price_id text not null,
  created_at timestamp default now()
);

-- User subscriptions table
create table user_subscriptions (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users not null,
  tier_id uuid references subscription_tiers(id) not null,
  stripe_subscription_id text,
  stripe_customer_id text,
  current_period_start timestamp not null,
  current_period_end timestamp not null,
  status text not null,
  created_at timestamp default now(),
  updated_at timestamp default now()
);

-- Usage tracking table
create table usage_tracking (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users not null,
  realtime_sessions_started int default 0,
  voice_evaluations_used int default 0,
  period_start timestamp not null,
  period_end timestamp not null,
  created_at timestamp default now(),
  updated_at timestamp default now()
);

-- Add indexes
create index user_subscriptions_user_id_idx on user_subscriptions(user_id);
create index usage_tracking_user_id_idx on usage_tracking(user_id);
create index usage_tracking_period_idx on usage_tracking(period_start, period_end);

-- RLS policies for new tables
alter table subscription_tiers enable row level security;
alter table user_subscriptions enable row level security;
alter table usage_tracking enable row level security;

-- Subscription tiers policies (admin only for modifications)
create policy "Anyone can view subscription tiers"
  on subscription_tiers for select
  to authenticated
  using (true);

-- User subscriptions policies
create policy "Users can view their own subscription"
  on user_subscriptions for select
  using (auth.uid() = user_id);

-- Usage tracking policies
create policy "Users can view their own usage"
  on usage_tracking for select
  using (auth.uid() = user_id);

-- Insert initial subscription tiers (now using session counts)
insert into subscription_tiers (name, realtime_minutes_limit, voice_evaluations_limit, stripe_price_id) values
  ('Free', 5, 100, 'price_free'),           -- 5 sessions/month
  ('Standard', 60, 1000, 'price_standard_monthly'),  -- 60 sessions/month
  ('Pro', -1, -1, 'price_pro_monthly');     -- Unlimited sessions 