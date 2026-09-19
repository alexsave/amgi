-- Vendored from github.com/ankitects/anki at tag 26.09.2, commit bb0dd6d1310afe290dea5e5a440400f851789936.
-- Upstream path: rslib/src/storage/card/add_card.sql
-- Do not hand-edit; see plusaudio/test/collection/vendor-drift.test.js.

INSERT INTO cards (
    id,
    nid,
    did,
    ord,
    mod,
    usn,
    type,
    queue,
    due,
    ivl,
    factor,
    reps,
    lapses,
    left,
    odue,
    odid,
    flags,
    data
  )
VALUES (
    (
      CASE
        WHEN ?1 IN (
          SELECT id
          FROM cards
        ) THEN (
          SELECT max(id) + 1
          FROM cards
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
    ?,
    ?,
    ?,
    ?,
    ?,
    ?,
    ?,
    ?,
    ?
  )