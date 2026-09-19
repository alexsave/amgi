-- Vendored from github.com/ankitects/anki at tag 26.09.2, commit bb0dd6d1310afe290dea5e5a440400f851789936.
-- Upstream path: rslib/src/storage/deck/alloc_id.sql
-- Do not hand-edit; see plusaudio/test/collection/vendor-drift.test.js.

SELECT CASE
    WHEN ?1 IN (
      SELECT id
      FROM decks
    ) THEN (
      SELECT max(id) + 1
      FROM decks
    )
    ELSE ?1
  END;