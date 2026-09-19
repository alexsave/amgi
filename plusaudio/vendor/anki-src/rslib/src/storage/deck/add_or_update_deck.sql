-- Vendored from github.com/ankitects/anki at tag 26.09.2, commit bb0dd6d1310afe290dea5e5a440400f851789936.
-- Upstream path: rslib/src/storage/deck/add_or_update_deck.sql
-- Do not hand-edit; see plusaudio/test/collection/vendor-drift.test.js.

INSERT
  OR REPLACE INTO decks (id, name, mtime_secs, usn, common, kind)
VALUES (?, ?, ?, ?, ?, ?)