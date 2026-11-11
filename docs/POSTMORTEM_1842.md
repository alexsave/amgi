# Post-mortem: incident-1842 and the amgi switch to C (2026-11-08 to 2026-11-09)

Draft by foolish (dispatcher, "manager of the week"), for Alex.
Blameless: it names teams and mechanisms, not faults of character.
Every time below is local (EST); GitHub times were converted from UTC (UTC-5).
Sources: docs/INCIDENT_1842.md, the safety section of foolish's docs/ARCHITECTURE.md, a private note on Anki's backup lock, the day's standings post, the thread (~/Dev/email.txt and the two archives), git and `gh pr view`.
Where a source is silent, this doc says "not recorded".

## 1. Summary

At 18:42:48 on 2026-11-08, Alex's real Anki collection (`~/Library/Application Support/Anki2/User 1/collection.anki2`) was destroyed: 56 of its 58 pages were zeroed, header included.
It happened during Alex's hands-on check of the amgi C server (c-backend-l2 at 3523487), which cdom was running for him against his real profile.
The mechanism is Anki's and ours together: Anki's backup on close drops Anki's own exclusive lock, then a second SQLite connection from an amgi server reset Anki's live `-wal`, and Anki's own close copied the resulting hole of zeros into the file.
Both amgi servers had the exposure (the Node server on 3111 and its C port on 3000); which one made the reset is not determined.
cdom restored the collection on Alex's say-so from amgi's 17:06 backup (91 notes, 182 cards).
The fix (never open a collection with a `-wal` or `-shm` beside it, never open one without a SQLite header, never checkpoint, a fresh backup before the automatic write, a temp HOME for every test) was committed at 19:16, re-tested with real Anki on a copied profile at 21:24, and merged to amgi main with the C switch (#35) at 21:53.
Status now: amgi main runs on C with no Node server, the rules are enforced by tests, and the incident is closed.
Three follow-ups from the investigation are still open (section 7).

## 2. Timeline

### Before

- ~13:20: the coordination thread starts (cdom's first status post).
- 15:54: cbase v0.1.0 tagged (commit date); public at "17:0x" on v0.1.1 (cbase's post).
- 18:08: amgi relays the owner's ask to "speed up and parallelise the remaining C work"; at 18:10 foolish runs four executors split by file ownership.
- ~18:26: the owner: "20:00 is not acceptable. parallelize the work" (for #35).
- 18:25:07: a test (cli-fuzz) wrote `~/Dev/amgi-collection-backups` outside its sandbox (found and fixed later in 37fe99e).
- 18:29: 3523487 committed; the owner's hands-on check starts on it (cdom's try server, PID 39693, 127.0.0.1:3000, real HOME, Safari).
- ~18:39: the #35 executor has 3 `amgi serve` processes up for its final run (cdom's URGENT post).
- Alex's check: "seems fine to me", no bugs (time of the post not recorded, after 18:34 and before 18:42).

### The incident (from the files, incident-1842.md)

- 18:40:26: the C server writes amgi's own backup (`...23-40-26-860Z.bak`, valid header).
- 18:41:01: Anki is open; a deck is made in it.
- 18:41:52: the page's automatic POST /install rewrites the add-on files; Anki holds its lock, so the collection is not touched.
- 18:41 to 18:43: cdom restarts the try server (PID 39693 to 65810) on a UI rebuilt against cdom cbfcf6f; Alex reloads Safari, and the page says "amgi's server sent an answer this page cannot read".
- 18:42:13: Anki's last change before its backup (the colpkg's col.mod).
- 18:42:33: Anki's backup on close (`backup-2026-11-08-18.42.33.colpkg`); Anki's lock is gone from here on.
- 18:42:33 to 18:42:35: an amgi server opens the collection and resets Anki's live `-wal` (C on 3000 or Node on 3111; no server log exists for the window).
- 18:42:35: Anki's last transaction (col.mod and curDeck, pages 2 and 7) lands after the hole.
- 18:42:48: Anki's close writes the hole as zeros (the file's mtime); the page then says "file is not a database".

### Detection, restore and investigation

- Detection: Alex, through the page ("file is not a database"); cdom posts URGENT and freezes the Anki2 folder (exact post time not recorded; amgi's reply is stamped 18:47).
- 18:47: amgi confirms nothing of its own ran against the real folder since 18:30; cbase confirms nothing of cbase touches it.
- Before 18:49: cdom restores from the 17:06 backup on Alex's choice, keeping the broken file at ~/Dev/anki-broken-2026-11-08/ (exact time not recorded).
  The restore point predates the deck made at 18:41:01; whether anything Alex cared about was lost is not recorded.
- ~18:50: foolish's investigator starts a sandbox-only replay (temp HOME, copies only).
- 18:54: amgi splits the hunt into lanes A (foolish, replay), B (cbase, fd audit), C (cdom, what the page sent), D (amgi's engineer, pure SQLite), E (amgi PM, collect).
- 18:57: lane D reproduces the end state in pure SQLite; lane C rules out the client.
- 19:04: the investigator's red test commit (26a94e7); FOUND is posted before the 19:10 thread compaction, ahead of its 19:30 ETA.
- 19:0x to after 19:10: lane B's verdict, after FOUND: cbase is clean (7,567 closes checked, zero bad closes). It confirmed cbase was out of the causal chain; it did not help find the cause.

### Fix, verification and merge

- 19:13: the red test cherry-picked onto c-backend (7be5120).
- 19:16: the fix, dbf48a1 (`collection_openable`: header check, `-wal`/`-shm` means locked, re-check after open, no checkpoint, no OPEN_CREATE), red without the rule and green with it, six mutants killed.
- 19:18 to 19:24: amgi's guards PR #41 (no-checkpoint scan) and cdom's 18:42 browser drive PR #42, both red before and green after.
- 19:20: 1bd5cff, a fresh backup before the automatic install write; 19:23: 6b0f93d.
- 19:30 to 20:30: the owner paused every lane (then an internet outage); all lanes wrote handoffs.
- 20:32: #35 head 693b49c (rebased on the fix, #41 and #42 cherry-picked); READY posted (cdom later cites "READY at 20:39").
- 21:24: cdom reruns the 18:42 sequence with real Anki 26.09 on a copied profile: "Anki locked" while open, and after Anki's close the file is whole (57 pages, 0 zero, 91 notes, 182 cards).
- After that: Alex's own re-test on the copy: "seems to work!"; then his "go" (times not recorded).
- 21:46 to 21:51: amgi's verify-c-backend.sh on 693b49c from a fresh clone: green on every product step (one script expectation wrong, see 5.7).
- 21:53:46: Alex merges #35 (amgi main aa67fb5); an agent merge was blocked by the harness permission check.

## 3. Root cause and contributing factors

### Root cause

1. Anki holds its collection in WAL mode with `locking_mode=EXCLUSIVE`, so its WAL index lives in Anki's heap and no `-shm` exists.
2. Anki's `create_backup` reads the collection through a second plain file handle (`read_locked_db_file`, `std::fs::read`) and closes it; on POSIX, that close drops every fcntl lock the process holds on the file, Anki's exclusive lock included.
3. Anki keeps writing to its `-wal`, believing it still owns the file.
4. Any second SQLite connection can now open the file, and its checkpoint resets Anki's live `-wal` to 0 bytes.
5. Anki's next transaction lands after a hole of zeros, and Anki's close copies every page in the hole into `collection.anki2` as zero bytes.

Evidence: the surviving pages 2 and 7 are Anki's own post-backup transaction (col.mod at 18:42:35, curDeck set to the 18:41:01 deck), and the sandbox reproduction with the real anki library and the 3523487 server gives the same shape (header gone, only pages 2 and 7 left).

### Contributing factors

- **A faithful port copies its original's bugs.** The Node server (`plusaudio/lib/collection/open.js:91`) and its C port (`server/collection/db.c`) both ran `PRAGMA wal_checkpoint(TRUNCATE)` on every open.
- **Dropping the checkpoint alone did not fix it.** The mutation check showed any second connection's ordinary close-time checkpoint does the same, even the `sqlite3` CLI; only refusing to open a file with a `-wal` or `-shm` beside it fixes it.
- **The page writes on its own.** The page-load auto-install opens and writes the collection without a user action; the owner kept it automatic ("I dont want users to think about it"), so it had to be safe with no user in the loop.
- **Tests ran with the real HOME.** `test/parity/servers.mjs` started the C server with the real HOME, and the C server's default profile folder is `$HOME/Library/Application Support/Anki2`; this exposure turned out not to be the path at 18:42 (no request without `X-Amgi-Collection` opens a collection), but it was live, and one test (cli-fuzz) did write outside its sandbox at 18:25:07.
- **Nothing simulated Anki's close.** No suite had a process playing Anki that loses its lock while still open, so the exact path (Anki just closed, the page reloading) was never exercised.
- **No server log for the window.** The try server logged at warn and printed only its listening line, so which server made the reset cannot be told.
- **A real user found it in minutes.** Alex's words at the restore: "well theres your bug, found much faster than your method".

Not determined: which server reset the `-wal`, and what Anki wrote over the whole file between 18:42:33 and 18:42:35 (smaller writes give the same mechanism with fewer zero pages).

## 4. What went right

- **The blast radius was contained at once.** Within minutes every team confirmed nothing of theirs held the folder open (lsof, ps), nobody wrote there, and two good copies (the 18:40 .bak and the 18:42:33 colpkg) were named before the restore.
- **Backups existed and worked.** amgi's own backup policy produced the 17:06 file Alex restored from.
- **Parallel lanes split by hypothesis and file ownership.** The 18:54 split (A to E) meant no two teams read the same file; lane C ruled out the client, lane B ruled cbase out with a measured audit (after FOUND, so it closed the "is it cbase?" question with evidence rather than helping find the cause), and lane D reproduced the end state in pure SQLite within three minutes of starting.
- **A sandbox reproduction settled it.** The investigator reproduced the exact shape with the real anki library and the real server under a temp HOME, without ever opening the real folder with SQLite.
- **It corrected the early theories.** The first reads ("a positioned write at offset 0", "a file emptied first", "the write points at cdom's try server", and cdom's reading of Anki's source that Anki was "very unlikely" to be involved, when its lock drop in read_locked_db_file was half the cause) were replaced by evidence: Anki's own close wrote the zeros.
- **Red first, mutation-checked.** `incident_1842.c` was red 5 of 5 before the rule; the fix killed all six mutants; the guards scan and the browser drive were each shown red without the fix; removing only the `-wal` half lets the automatic install write into the live file again.
- **The fix has one owner.** `collection_openable` in db.c owns every open rule, and checks again right after the open to close the race with Anki starting.
- **The temp-HOME rule is enforced by a test.** `test/sandbox-home.test.mjs` parses the test code and fails on any child process started without a sandboxed env.
- **The fix beat its ETA.** Committed at 19:16 against an executor ETA of ~19:40 and a dispatcher ETA of ~19:50, with the owner's target 19:40.
- **The re-test never touched real data.** It ran on a copied profile (Anki with `-b ~/Dev/anki-retest-base`), with real Anki doing a real backup on close.
- **The rules were written down.** ARCHITECTURE.md section 6b (s6-safety.md) records each rule, its owner in code, and how it is proven.

## 5. What went wrong

1. **Serial work early.** Parallel executors came at the owner's push, not by default: L2 started in parallel with L3 only at 16:55, the four-executor split came after the 18:08 ask to "speed up and parallelise", and #35 was "one serial list" until the owner rejected its ~20:00 ETA at ~18:26.
2. **ETA drift on #35.** Posted READY ETAs: ~20:00 (before 18:26), ~19:15 (~18:27), "60 to 75 minutes" (~18:37, after the no-npm start was added), ~20:15 (after the incident), ~20:10 (~19:28), ~21:15 (after the 20:30 resume); actual READY was 20:32 to 20:39.
   Some moves were scope changes or the pause, but the 19:15 promise assumed merges outside foolish's control; foolish's own standings call these "padded ETAs".
   Investigation ETAs went the other way: lane A promised 19:30 and found it before 19:10.
3. **Imprecise wording the owner had to correct.**
   - "host" for the SDK browser adapter, which reads as a server; renamed "SDK browser adapter".
   - "plain HTTP" added by foolish to the hello-world plan, which the owner never said; corrected the same evening.
   - The wrong port: foolish's 18:34 note told Alex to stop the Node server "on 3000 (PID 11741)", while that Node server (PID 11741) was on 3111 and 3000 was free.
4. **The test-HOME exposure.** Test servers inherited the real HOME, so any request without the base-dir header could have reached the real Anki2 folder; foolish's standings say it "should have caught [it] before the first run".
   The fix then caused a side effect: Chrome under a temp HOME popped a macOS keychain dialog at Alex (fixed with `--use-mock-keychain --password-store=basic`).
5. **A rebase dropped a test file silently.** #35's rebase lost `test/parity/envfile.test.mjs`; foolish's post-merge cleanup check found it, and it was restored as amgi #43 (merged 2026-11-09 10:23).
6. **A PR merged before its follow-up commit was pushed.** foolish #474 (ARCHITECTURE.md) merged at 00:54:40, and the commit recording the x1 ruling, announced as "Pushed" on #474, became #475 (opened 00:55:36, merged 10:24).
7. **A verify script with a wrong expectation.** verify-c-backend.sh required `GET /` to answer 200, but `/` answers 307 to /decks, as Node did; it failed on that step until amgi fixed it (amgi #44).
8. **Files kept in /tmp.** amgi's verify script and checklist lived in a session scratchpad under /private/tmp until the owner said "dont keep things in tmp where we could lose them" (~18:26); foolish's run scripts moved to ~/Dev/foolish-reports only at 20:31.
9. **Lint skipped on a PR.** amgi #29 passed npm test but shipped an unused import that broke eslint on main; lint is now in every executor brief.
10. **The first hands-on check ran on the real profile.** cdom brought up Alex's first hands-on check (18:29) against his real Anki profile and HOME. The re-test later used a copied base folder (`open -a Anki --args -b ~/Dev/anki-retest-base`) and a fake HOME; that should have been the rule from the first run.
11. **Two things changed at once during a live check.** cdom restarted the try server on a UI rebuilt against a newer cdom in the middle of Alex's check (18:41 to 18:43). Not causal, but a live check should change one thing at a time.

## 6. The switch overall

What shipped:
- cbase is its own public MIT repo (alexsave/cbase), tagged v0.1.0 at 15:54 on 2026-11-08 through v0.1.9 at 10:47 on 2026-11-09.
- amgi runs on `cbase serve` in C with no Node server: #35 (83 commits, L2 and L4) merged at 21:53 on 2026-11-08; the UI is C on cdom in wasm; `make start` needs no Node.
- Follow-ups merged on 2026-11-09: #43 (envfile test), #44 (verify script), #46 to #53 (pins, settings fixes, and the last bump to cdom 386cc82 and cbase v0.1.9 at 11:07).
- cdom gained a starter (`make -C cdom new`, cdom #24) and cbase a starter (cbase #18).

Hello-world rounds (a fresh agent each time, a cdom page calling a cbase serve route through the C SDK):

| Round | Help | Time | First end to end |
|---|---|---|---|
| 1 | none | 18:26 | 5:38 |
| 2 | none | 11:33 | 4:54 |
| 3 | none | 10:58 | 5:28 |
| 4 | none | 12:03 | 4:36 |
| 5 | both starters | 11:05 | 6:12 |

No round hit a framework bug; every round's friction list went to cdom and cbase as fixes.
For scale, the same app on Next.js plus Node took 6:33 including installs; the C page was about 18 KB gzipped against Next's 194,834 bytes (136 KB of it gzipped JS), and the C server idled at 4.7 MB in one process against about 200 MB in three.

Friction: the owner's corrections on wording and scope, the incident, a one-hour pause, and agents blocked from merging by the harness (every merge waited on Alex's hand).

## 7. Action items

| # | Action | Owner | Status |
|---|---|---|---|
| 1 | Never open a collection with a `-wal` or `-shm` beside it; re-check after the open | foolish | Done: dbf48a1, in amgi main via #35 (aa67fb5) |
| 2 | Never open a file without a SQLite header; show "damaged" in the UI | foolish | Done: dbf48a1 and #35 |
| 3 | Never checkpoint, enforced by `test/no-checkpoint.test.mjs` | amgi | Done: #41's commits, in main via #35 |
| 4 | A fresh backup before the automatic install write | foolish | Done: 1bd5cff, in main via #35 |
| 5 | `incident_1842.c` (unit) and `ui/tools/incident1842.sh` (browser drive) in the suites | foolish, cdom | Done: 7be5120 and #42's commits, in main via #35 |
| 6 | A temp HOME for every test process, enforced by `test/sandbox-home.test.mjs` | foolish | Done: #35 |
| 7 | Chrome launches with `--use-mock-keychain --password-store=basic` | cdom, foolish | Done: cdom's tools/cdp.mjs and amgi 693b49c |
| 8 | cli-fuzz writes only inside its scratch folder | foolish | Done: 37fe99e |
| 9 | Delete the Node server (it carried the same checkpoint) | foolish | Done: #35 |
| 10 | Restore the test dropped by the rebase | foolish | Done: amgi #43 |
| 11 | verify-c-backend.sh accepts `/` answering 307 and uses make start | amgi | Done: amgi #44 |
| 12 | Record the rules and their proofs | foolish | Done: ARCHITECTURE.md 6b (foolish #474) |
| 13 | Anki upstream bug (backup drops the exclusive lock) | Alex | Decided: kept private (anki-lock-bug-private.md), not filed |
| 14 | No silent base-dir fallback: a request with no collection or base dir answers "unconfigured" for install too, with a test | amgi | Open, amgi recommends it; waits for Alex's go (main still falls back at install.c:261) |
| 15 | Log each collection open and write (path, transport, request id; never settings headers or the key) at a level that survives the default | amgi | Open, amgi recommends it; waits for Alex's go |
| 16 | Treat the bridge as the authority while Anki's process is alive | amgi | Not recommended: the -wal/-shm rule already refuses a file Anki owns, and a second check would be a second owner; Alex decides |
| 17 | After a large rebase, compare the file list against the pre-rebase head before force-pushing | foolish | Open (proposed here, from 5.5) |
| 18 | Say "final, no more pushes" before asking for a merge; never push to a branch whose PR may merge | foolish | Open (proposed here, from 5.6) |
| 19 | ETAs: post a time only for work in our own hands, and re-post when scope changes | foolish | Open (proposed here, from 5.2) |
| 20 | Durable files only (no /tmp), lint plus tests on every PR | all | Done as rules (thread decision and memory); keep in every brief |
| 21 | Replace the add-on's Node `generate-clip.js` with a C tool | foolish | Open (follow-up recorded at the 19:32 handoff) |
| 22 | Deck rename onto a taken name: refuse, or Anki's "+" (branch decks-anki-names) | Alex | Open decision |
| 23 | Every hands-on check of a build that writes a collection runs on a copied profile and a fake HOME, never the real one, until merged and verified | cdom, all | Done as a rule (in place since the re-test) |
| 24 | During a live check, change one thing at a time (no server restart or rebuild mid-check) | all | Done as a rule |
| 25 | A unit test never reaches the network | cbase, foolish | Done: cbase #21, foolish #477 |
