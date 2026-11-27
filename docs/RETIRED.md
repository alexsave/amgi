# Retired

What was taken out of amgi once its job was done, what it found, and why it went.
Each one is still in git history at the commit named.

## The UI's screenshot parity gate (tests/e2e/ui/parity.sh, compare.mjs, parity-allow.txt)

**What it was:** a check that a change moved nothing the page draws.
It compared the shots of a new run of the browser drives (tests/e2e/ui/e2e.sh) against a baseline run.
Every PNG had to match byte for byte or, decoded, pixel for pixel, and every DOM snapshot beside it had to be byte-identical.
parity-allow.txt listed 16 shots (cdom-31 to cdom-36) that legitimately differ between runs, because the fake Gemini answers concurrent lines in arrival order and the rate-limit countdown is wall-clock.

**Why it was built:** the port of the page from React to C on cdom (November 2026), where the C page had to draw what the React page drew.

**Its last run (2026-11-27):** before and after the removal of about 1,050 lines of CSS that only the React app used.
153 of 156 files were byte-identical.
The other 3 (cdom-30-one-card, cdom-64-fill-wait, cdom-64-fill-wait-phone) differed in their DOM as well as their pixels, so the cause was the drives' timing (a card count of 4 against 3, audio fill at step 1 against step 2), not the style sheet.
Those 3 were never in the allow list: the gate was flaky on them.

**Why it went:** no script, package.json entry or CI step ran it once the port was done, and compare.mjs needed sharp, which nothing installs.
Last at commit 5e521b0.

## The C port's planning docs (docs/AMGI_STAGE1_ROUTES.md, docs/C_PORT_FILEMAP.md)

**AMGI_STAGE1_ROUTES.md** was the survey taken before stage 1 of the C backend: every HTTP route of the Node server, keyed to line numbers in ui/server/serve.mjs, src/server/api/anki and plusaudioCli.js.
README.md's "The app's API" section now describes the routes the C server serves.

**C_PORT_FILEMAP.md** mapped each Node file to its C counterpart for the review of the L1 port.
Everything it listed as not yet ported (transport.js, bridgeClient.js, install.js) was ported later, and the Node files it mapped were deleted at L4 (cab61f4).

**Why they went:** every path in them was gone and nothing linked to them.

## The deck-name index repair (anki/addon/amgi_bridge/deck_index.py, tests/anki/addon/test_deck_index.py)

**What it was:** a `REINDEX decks` the add-on ran at every profile open.
The Node backend wrote decks through node:sqlite, which has no collation API, so it stripped `COLLATE unicase` from the schema for the length of the write.
Entries it added were then sorted in BINARY order, and Anki's unicase lookups missed them: a new deck showed a card count in the deck list and "Congratulations! You have finished this deck" when opened.

**What it found:** unicase equality is exactly Unicode full case folding (Python's `str.casefold()`), measured against Anki: "STRASSE" equals "straße", "ﬁle" equals "file", "Σ" equals "ς".

**Why it went:** the C core registers Anki's own unicase collation on its connections (server/collection/db.c), with the fold measured against Anki 26.09 (server/collection/util.c), so it never writes a misfiled entry.
tests/server/parity/unicase.test.mjs checks it against real Anki.
