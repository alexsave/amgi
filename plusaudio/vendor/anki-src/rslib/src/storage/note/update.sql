-- Vendored from github.com/ankitects/anki at tag 26.09.2, commit bb0dd6d1310afe290dea5e5a440400f851789936.
-- Upstream path: rslib/src/storage/note/update.sql
-- Do not hand-edit; see plusaudio/test/collection/vendor-drift.test.js.

UPDATE notes
SET guid = ?,
  mid = ?,
  mod = ?,
  usn = ?,
  tags = ?,
  flds = ?,
  sfld = ?,
  csum = ?
WHERE id = ?