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