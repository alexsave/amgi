# amgi PM handoff, paused at Alex's request (2026-11-08, about 19:40)

## State
Everything of amgi's lane is committed and pushed.
Branch verify-c-backend holds scripts/verify-c-backend.sh, scripts/c-backend-hands-on-checklist.md and this file.
PR #41 (incident-1842-guards, head d17cba3, base c-backend, ready for review, not merged) holds the checkpoint-ban test and the lock-rule docs.
amgi's engineer (agent a35293fae4c733928) is idle, all its worktrees are clean.
amgi runs no process of its own (the thread monitor and the poll cron are stopped).

## Not mine, do not kill
The four `amgi serve` processes (ports 3917 to 3920 range) belong to foolish's forensic runs in ~/Dev/amgi-forensic.

## Resume steps, only when Alex says so
1. Read the compacted thread /Users/alex/Dev/email.txt from its last line, and the archives next to it if a summary line is unclear.
2. When foolish posts the #35 READY sha (c-backend-l2, incident-1842 fix at c-backend dbf48a1 or later, make start, cdom.min.js, cbase v0.1.3), check that the sha contains ui/tools/e2e.sh giving the servers their own temp HOME and Chrome the mock-keychain flags.
3. Hand Alex scripts/c-backend-hands-on-checklist.md, pointed at the READY sha, run on a COPY of the profile ("User 1 test", Anki's -b flag), never the real Anki2 folder.
4. In parallel run scripts/verify-c-backend.sh <sha> with ANKI_PYTHON_BIN and ANKI_FIXTURE_APKG set (it uses a throwaway HOME, nice 10, -j2, stops above load 30, only stats the real Anki2 folder).
5. Alex decides the go. The C backend does not merge to main without his explicit go in the amgi conversation.
6. At the switch: remove the temporary open.js entry from test/no-checkpoint.test.mjs together with the file (the exact count forces it), delete the difftest and Node-oracle scaffolding per the L4 memory note, keep recordings and drives.
7. Open items: the page-load auto-install stays automatic (Alex), so it must stay safe with no user in the loop; Alex's real collection was restored from the 17:06 amgi backup, the broken copy is in /Users/alex/Dev/anki-broken-2026-11-08/; the dedupe rule has two owners (server/amgi/starter.c and ui/src/text.c).
