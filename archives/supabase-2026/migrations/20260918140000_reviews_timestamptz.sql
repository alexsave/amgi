-- The scheduler writes UTC ISO strings, but next_review_date and
-- last_reviewed_at were `timestamp without time zone`, so PostgREST handed
-- them back without a zone and the browser re-read them as local time. A card
-- scheduled one minute out came back four hours out in New York, and the same
-- shift applied to every due-date comparison.
--
-- The stored values are naive UTC, so reinterpreting them as UTC is lossless.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'reviews'
      and column_name = 'next_review_date'
      and data_type = 'timestamp without time zone'
  ) then
    alter table reviews
      alter column next_review_date type timestamptz
      using next_review_date at time zone 'UTC';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'reviews'
      and column_name = 'last_reviewed_at'
      and data_type = 'timestamp without time zone'
  ) then
    alter table reviews
      alter column last_reviewed_at type timestamptz
      using last_reviewed_at at time zone 'UTC';
  end if;
end $$;
