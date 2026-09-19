-- Vendored from github.com/ankitects/anki at tag 26.09.2, commit bb0dd6d1310afe290dea5e5a440400f851789936.
-- Upstream path: rslib/src/storage/note/add.sql
-- Do not hand-edit; see plusaudio/test/collection/vendor-drift.test.js.

INSERT INTO notes (
    id,
    guid,
    mid,
    mod,
    usn,
    tags,
    flds,
    sfld,
    csum,
    flags,
    data
  )
VALUES (
    (
      CASE
        WHEN ?1 IN (
          SELECT id
          FROM notes
        ) THEN (
          SELECT max(id) + 1
          FROM notes
        )
        ELSE ?1
      END
    ),
    ?,
    ?,
    ?,
    ?,
    ?,
    ?,
    ?,
    ?,
    0,
    ""
  )