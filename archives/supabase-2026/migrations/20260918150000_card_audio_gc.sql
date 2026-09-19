-- Deleting a card or a deck has to take the card's audio out of the
-- `card-audio` bucket too, or every deletion leaks publicly readable mp3s
-- forever.
--
-- The catch is that a translation pair is two card rows that share the same
-- two objects (CardModal builds A as front=X/back=Y and B as front=Y/back=X),
-- so an object may only be removed once no row anywhere still points at it.
-- These functions delete the rows and report back exactly which paths just
-- became unreferenced; the caller is then responsible for removing those
-- objects from storage.
--
-- Why the row delete and the reference check live here rather than in the
-- caller: they have to see the same transaction, so the check observes the
-- world as it is after the delete and cannot be fooled by a stale read.
--
-- Why security definer: the "is anyone still using this?" scan must see every
-- card row, not just the caller's. A row hidden by RLS is still a row whose
-- audio must survive. Each function therefore takes the acting user id
-- explicitly and enforces ownership itself, and execute is granted to
-- service_role only, so the sole way in is the delete-cards edge function
-- (which also owns the storage removal the client cannot perform).

-- The orphan check filters cards by audio path, which is otherwise a full
-- scan of every card in the system on each delete.
create index if not exists cards_front_audio_path_idx
  on public.cards (front_audio_path)
  where front_audio_path is not null;

create index if not exists cards_back_audio_path_idx
  on public.cards (back_audio_path)
  where back_audio_path is not null;

-- Paths referenced by the given cards that no remaining card references.
create or replace function public.delete_cards_returning_orphaned_audio(
  p_user_id uuid,
  p_card_ids uuid[]
)
returns setof text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidates text[];
begin
  select array_agg(distinct v.path) into v_candidates
  from public.cards c
  join public.decks d on d.id = c.deck_id
  cross join lateral (values (c.front_audio_path), (c.back_audio_path)) as v(path)
  where c.id = any(p_card_ids)
    and d.user_id = p_user_id
    and v.path is not null;

  delete from public.cards c
  using public.decks d
  where d.id = c.deck_id
    and c.id = any(p_card_ids)
    and d.user_id = p_user_id;

  return query
  select path
  from unnest(coalesce(v_candidates, array[]::text[])) as path
  where not exists (
    select 1 from public.cards c2
    where c2.front_audio_path = path
       or c2.back_audio_path = path
  );
end;
$$;

-- Same, for every card in a deck. Deleting the deck row cascades to its
-- cards, so the candidate paths are collected before the delete.
create or replace function public.delete_deck_returning_orphaned_audio(
  p_user_id uuid,
  p_deck_id uuid
)
returns setof text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidates text[];
begin
  select array_agg(distinct v.path) into v_candidates
  from public.cards c
  join public.decks d on d.id = c.deck_id
  cross join lateral (values (c.front_audio_path), (c.back_audio_path)) as v(path)
  where c.deck_id = p_deck_id
    and d.user_id = p_user_id
    and v.path is not null;

  delete from public.decks
  where id = p_deck_id
    and user_id = p_user_id;

  return query
  select path
  from unnest(coalesce(v_candidates, array[]::text[])) as path
  where not exists (
    select 1 from public.cards c2
    where c2.front_audio_path = path
       or c2.back_audio_path = path
  );
end;
$$;

revoke execute on function public.delete_cards_returning_orphaned_audio(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.delete_deck_returning_orphaned_audio(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_cards_returning_orphaned_audio(uuid, uuid[]) to service_role;
grant execute on function public.delete_deck_returning_orphaned_audio(uuid, uuid) to service_role;
