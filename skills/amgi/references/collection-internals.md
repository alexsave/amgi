# How an Anki collection works, for when something misbehaves

## Where things live

One base folder per machine ([docs](https://docs.ankiweb.net/files.html#file-locations)):

| OS | Base folder |
| --- | --- |
| macOS | `~/Library/Application Support/Anki2` |
| Windows | `%APPDATA%\Anki2` |
| Linux | `~/.local/share/Anki2` (or `$XDG_DATA_HOME/Anki2`) |

Each profile is a subfolder (`User 1`, ...) holding `collection.anki2` (SQLite), the `collection.media/` folder, `collection.media.db2` (the media sync tracker) and `backups/`. amgi's `baseDirOverride` setting points it at a different base folder.

## Locking

Anki opens `collection.anki2` with `locking_mode=exclusive`, WAL and a zero busy timeout ([rslib/src/storage/sqlite.rs](https://github.com/ankitects/anki/blob/main/rslib/src/storage/sqlite.rs)). While a profile is open, a second process **cannot even read** the file: every attempt fails at once with `database is locked`, and waiting does not help.
The reverse is also true: a process that leaves the file open stops Anki from opening the profile ("Anki already open, or media currently syncing").
So open, do one unit of work, and close. amgi's direct transport does that on every request, closing on error paths too.
A profile that is `locked` while Anki looks closed usually means Anki is still running in the background, or a crashed Python process still has the file open.

The rule the C server follows before it lets SQLite near the file (`collection_openable` and `conn_open` in `server/collection/db.c`), because Anki's exclusive lock is not held for the whole time Anki uses the file:
- A file without SQLite's 16-byte header (`SQLite format 3` and a NUL) is `damaged`, and amgi does not open it.
- A `collection.anki2-wal` or a `collection.anki2-shm` beside it, either one, means someone else's SQLite has the file, so amgi reports `locked` and does not open it, to read or to write.
  A `-wal` alone is Anki (it keeps its WAL index in memory, so it never makes a `-shm`), or an Anki that crashed, whose `-wal` holds the only copy of its newest pages.
  A `-wal` with a `-shm` is another SQLite user in normal mode, and a `-shm` alone is what one left; amgi cannot tell a live one from a dead one, and refusing costs only a retry.
- amgi checks again right after `sqlite3_open_v2`, before any statement, in case Anki arrived in between.
- amgi opens with `SQLITE_OPEN_READWRITE` and never `SQLITE_OPEN_CREATE`, so a collection that went away is never made anew, empty.
- amgi never asks for a checkpoint (`wal_checkpoint`, `sqlite3_wal_checkpoint`), and `server/test/no_checkpoint.c` holds that for all of amgi's shipped code.
  The only checkpoint left is SQLite's own as amgi's connection closes, which, with no `-wal` there when it opened, folds back only amgi's own commit.
- Why: Anki's own backup on close drops its exclusive lock while its `-wal` is still live.
  The server's checkpoint then cut that `-wal` to nothing, and Anki's next frames left a hole that its close wrote into the collection as zero pages.
  That happened on 2026-11-08: a real collection was left with 56 of its 58 pages zero (`docs/INCIDENT_1842.md`).
- The race no check can close is Anki opening the file between the second check and amgi's first statement; then Anki's exclusive lock refuses amgi's read (`locked`), or amgi's shared lock briefly delays Anki's.

## Schemas

- **Schema 11** (Anki before about 2.1.28): note types, decks and deck config are JSON blobs in the `col` row.
- **Schema 18** (current): `notetypes`, `fields`, `templates`, `decks` and `tags` are real tables, and the name columns are declared `COLLATE unicase`. That is a collation Anki registers in Rust with full Unicode case folding ("straße" = "STRASSE"). Generic SQLite clients cannot resolve it, so a plain `SELECT * FROM fields` fails with "no query solution", and inserting a deck from outside Anki needs schema surgery. This is the strongest reason to write only through Anki's own library.
- Opening an old collection with a modern `anki` library upgrades it to 18. Keep the library's version in line with the user's desktop Anki.

## Notes, cards and ids

- A **note** holds the fields. Its **cards** are derived from the note type's templates (or from cloze numbers). Scheduling lives on cards, and history lives in `revlog`, keyed by card id.
- Ids are epoch milliseconds, bumped to max+1 on collision. Every note also has a **GUID**, which is what identifies it across devices and imports.
- Deleting a note deletes its cards and makes their review history orphaned. "Update in place" is always safer than "delete and re-add".
- `mod` (modification time) and `usn` (update sequence number, where -1 means "changed locally, needs sync") are how sync decides what changed. Anki's library stamps them, and hand-written SQL usually forgets.

## `.apkg` import matching

If you produce a `.apkg` for the user to import rather than editing in place ([rslib/src/import_export/package/apkg/import/](https://github.com/ankitects/anki/tree/main/rslib/src/import_export/package/apkg/import)):

- Notes are matched **by GUID only**. A matched note is updated only if the incoming copy's `mod` is newer, and an existing card's scheduling is never touched by an update.
- Decks are matched by name and note types by id.
- So a tool that re-numbers notes or note types produces a second copy of the deck, and a tool that bumps `mod` on every note overwrites any edits the user made in Anki since the export. Bump `mod` only on notes you actually changed, and work from a fresh export.
- A package comes in three layouts: legacy `collection.anki2`, legacy-2 `collection.anki21`, and modern `collection.anki21b`, which is zstd-compressed and has a protobuf media map. Which one it is comes from the `meta` member, not from which files happen to be present.

## Media

- Files go straight into `collection.media/`. With Anki closed, writing the file there is enough: Anki notices the folder's mtime changed and rescans on its next media sync or Check Media. Never hand-edit `collection.media.db2`.
- Filenames are what fields reference. Keep them ASCII-safe and unique. Hashing the content or source text into the name gives you idempotency for free.
- A file is "used" only if a field or template references it in a form Anki recognises (see the audio table in `card-templates.md`), or if its name starts with `_`. Anything else is deleted by Check Media.

## Sync after an edit

AnkiWeb sync is incremental, using `usn`. Some changes force a **full sync**, which asks the user to upload or download the whole collection: changing a note type's fields or templates (a schema change), or restoring a backup. When asked, the user must choose the side that has the changes. After a direct-mode edit on this computer, that is **upload**. Choosing download throws the edits away.

## Backups

Anki makes rolling backups only while it is open, plus one when a profile closes ([rslib/src/collection/backup.rs](https://github.com/ankitects/anki/blob/main/rslib/src/collection/backup.rs)). Edits with Anki closed happen outside that, so amgi's direct transport copies `collection.anki2` into `amgi-collection-backups/` next to it before writing (`server/collection/backup.c`).
