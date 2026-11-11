# Incident 18:42 (2026-11-08): collection.anki2 zero-filled

Investigator: foolish (investigator, incident-1842).
Everything below was reproduced in sandboxes only (temp HOME, copies of the 18:40 amgi .bak, Anki's 18:42:33 colpkg and the broken file).
Nothing under ~/Library/Application Support/Anki2 was opened with SQLite or Anki, or written.

## Verdict

The original hypothesis is confirmed, with one correction.
The main file was not emptied first.
Anki's own close wrote zeros over it, copying from a hole in its -wal that an amgi server had made.

1. Anki holds the collection in WAL mode with `locking_mode=EXCLUSIVE`, so its WAL index lives in its own heap (no -shm), and every other process is told "database is locked".
2. **Anki's `create_backup` drops Anki's own lock.**
   Right after `col.create_backup(...)`, a separate sqlite3 process can read the collection while Anki still has it open.
   This is the POSIX rule that close() of any fd on a file releases every fcntl lock the process holds on it.
   It most likely comes from the backup reading collection.anki2 with a plain file open.
   Anki desktop runs this backup on close: the 18:42:33 colpkg.
3. Anki keeps writing to its -wal.
   It still believes it owns the file, and its WAL index is still in its heap.
4. An amgi server opens the collection for a page load or a status poll, and the open now succeeds.
   The C server's conn_open runs `PRAGMA wal_checkpoint(TRUNCATE)` (server/collection/db.c:172 at 3523487, db.c:165 on c-backend-l2).
   Even without that line, the plain close-time checkpoint of any second SQLite connection does the same job here.
   Either way, Anki's frames are backfilled and Anki's live -wal inode is reset to 0 bytes underneath it.
5. Anki writes its next small transaction (col.mod plus the config row: pages 2 and 7) at the frame offset it remembers.
   Its -wal now has a hole of zeros where all its earlier frames were.
6. Anki's close checkpoints from its heap index.
   Every page whose newest frame lies in the hole goes into collection.anki2 as 4096 zero bytes.
   Only the pages of the last transaction survive, and the file is truncated or extended to the WAL's page count.

## Evidence

- Alex's broken file: 58 pages, pages 2 and 7 non-zero, header gone (read raw only).
- Page 2 of the broken file is the col row from the 18:42:33 colpkg, byte for byte, except that col.mod is 22 s later: 18:42:35, after the colpkg.
- Page 7 is the config page from the colpkg, except that curDeck is changed to the deck created at 18:41:01.
  So the surviving pages are Anki's own last transaction, written after its backup.
  amgi's code never writes curDeck: grep finds no curDeck in server/collection or in plusaudio/lib.
- The colpkg's database is 58 pages, the same size as the broken file.
- The file's mtime is 18:42:48, which fits Anki's close-time checkpoint (step 6), 15 s after the colpkg.
- Sandbox reproduction with the anki library (Anki 26.09's rslib) and the 3523487 C server driving a real page load (GET /install, POST /install, GET /install, status, decks).
  The sequence was: open, add, create_backup, a whole-file write, the page load, set curDeck, close.
  Result: 57 pages, 55 zero, header gone, only pages 2 and 7 non-zero.
  With smaller post-backup writes, only those pages are zeroed (8 of 57 in one run).
- The same result with no amgi server at all, using the sqlite3 CLI as the second process.
  Any second SQLite opener does it once Anki's lock is gone.
- Mutation check: with the explicit TRUNCATE removed from conn_open, the shape is the same.
  The explicit line is not needed; the second open is.
- Ruled out:
  - Two or three concurrent automatic POST /install requests right after a clean Anki close: 20 rounds, no damage.
  - Polls while Anki holds its lock: they get "locked" and are harmless.
  - The silent base-dir fallback.
    Without X-Amgi-Collection the transport is "unconfigured" (server/collection/transport.c:36) and no collection is opened.
    The fallback only reaches addons21.
  - The O_TRUNC opens in install.c:131 and media.c:90: their targets are under addons21 and collection.media only.
  - backup.c's copy at 3523487 (copy_excl): it reads the collection and writes only into amgi-collection-backups.

## Could it have happened to the real collection at 18:42? Yes, and the timings fit

- 18:40:26: the C server writes (amgi .bak).
- 18:41:01: Anki is open, and a deck is made in it (the deck id).
- 18:41:52: the page's automatic POST /install rewrote the add-on files (addons21 mtimes).
  Anki held its lock then, so the collection was not touched.
- 18:42:13: Anki's last pre-backup change (the colpkg's col.mod).
- 18:42:33: Anki's backup on close (colpkg). Anki's lock is gone from here on.
- 18:42:33 to 18:42:35: a server open resets Anki's -wal.
  Candidates: the C server on 3000 (Alex reloading after cdom's restart, plus the page's status polling), or the Node server on 3111, which runs the same `wal_checkpoint(TRUNCATE)` on every open (plusaudio/lib/collection/open.js:91).
  I can't tell which from the evidence: there is no server log for the window.
- 18:42:35: Anki's last transaction (curDeck, col.mod), which lands after the hole.
- 18:42:48: Anki's close writes the hole as zeros (mtime). The page then shows "file is not a database".

Open sub-question: for all 56 pages to be zeroed, Anki's -wal must have held every page between its backup and the reset.
Something in Anki's close path between 18:42:33 and 18:42:35 must have rewritten the whole file.
I couldn't identify it without the desktop (aqt) source.
In the sandbox a VACUUM stands in for it.
Smaller writes give the same mechanism with fewer zero pages.

## The failing test

- Branch `incident-1842` off origin/c-backend-l2 (3e122fa), commit 26a94e7, pushed, no PR.
- `tests/server/c/incident_1842.c`, built and run by `make -C server build/incident_1842 && server/build/incident_1842 <repo>`.
  It is also part of `make -C server check-collection`.
- The test needs no Anki.
  A child process plays Anki through SQLite: an exclusive-mode WAL, then the lock loss as a raw open and close of the file, then a whole-file write.
  The parent runs the server's own col_status and col_list_notetypes.
  Then the child writes its last transaction and closes.
- Red on 3e122fa, 5 of 5 runs: 34 pages, 32 zero, header gone, and the file does not open.
- Green with a trial rule in conn_open: a -wal with no -shm beside it returns OPEN_LOCKED.
  That trial was reverted, and the product code is unchanged.

## Proposed fix

1. One rule with one owner, conn_open (and its Node twin, open.js): a collection whose -wal exists with no -shm is held by an exclusive-mode owner (Anki, or an Anki that crashed).
   Report it as locked and never open it, for reads as well as writes.
   Check again after sqlite3_open_v2, before the first read, to close the race with Anki starting.
   After a clean Anki close both files are gone, and after an Anki crash Anki recovers the -wal itself on its next open.
2. Remove `PRAGMA wal_checkpoint(TRUNCATE)` from every read open (db.c, open.js).
   It is not the root cause, but a read must never rewrite or truncate the collection's files.
3. Optionally, prefer the bridge as the authority.
   While Anki's process is alive (bridge answering, or Anki running), no direct-mode access at all.
4. Report upstream to Anki: create_backup releases the collection's exclusive lock while the collection stays open.
5. Separately, as amgi asked: the default base-dir fallback should warn, and refuse in non-interactive mode.
   It played no part here.

## Confidence

- Mechanism: high.
  It is reproduced exactly (header gone, only pages 2 and 7 left) with the real anki library and the real 3523487 server, and in a self-contained C test.
- That this is what happened at 18:42: high-moderate.
  Pages 2 and 7 are Anki's post-backup transaction, and the timings fit.
- Which amgi server made the reset (C on 3000 or Node on 3111): not determined.
- What Anki wrote over the whole file right after its backup: not determined.
