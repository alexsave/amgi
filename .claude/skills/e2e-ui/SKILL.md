---
name: e2e-ui
description: Run amgi locally against a fixture Anki collection (no environment variables, no login, no hosted backend) and drive it in headless Chrome - screenshot the deck list, a deck's notes, deck creation and adding a note, prove the locked-collection path against a real Anki-shaped lock, and test the local HTTP bridge's token/Origin rules over real HTTP. Use when asked to check how something looks, prove a UI or transport change works in the real app, hunt for visual weirdness, or debug the direct-file/bridge transport picker.
---

# Driving amgi end to end

amgi is local-first: no account, no hosted backend, no environment variable required to run it.
Everything here runs against a **fixture** Anki collection you build yourself, on disk, and drives headless Chrome over the DevTools protocol (`cdom/tools/cdp.mjs`) and real HTTP - never against a real personal collection, and never against anything that needs a network credential.

For the review loop itself - the card template's hands-free listen-then-speak flow - see `anki/test/harness/drive.js` and `anki/README.md` instead.
This skill covers the app: the deck browser and card builder, and the two transports it reaches an Anki collection through.

## One-time setup

You need two things, neither of which this repo can vendor:

1. **A Python with the `anki` library importable.**
   It does not need Anki itself installed, and does not need `aqt` (Anki's Qt/GUI package).

   ```bash
   python3 -m venv .venv && .venv/bin/pip install anki   # or: uv venv && uv pip install anki
   ```

   Point `ANKI_PYTHON_BIN` at that interpreter for every command below.
2. **A real `.apkg` to seed the fixture from.**
   Any shared deck works - grab a small one from [AnkiWeb's shared decks](https://ankiweb.net/shared/decks/), or export one from your own Anki (File > Export, "Anki Package").
   Point `ANKI_FIXTURE_APKG` at its path.

```bash
export ANKI_PYTHON_BIN=/path/to/venv/bin/python
export ANKI_FIXTURE_APKG=/path/to/SomeDeck.apkg
node --test tests/server/parity/collection.test.mjs   # confirms both actually work together (make -C server first)
```

That test is not part of this skill - it is the proof that the C collection core writes what the real Anki library writes - but it exercises exactly the same `ANKI_PYTHON_BIN`/`ANKI_FIXTURE_APKG` machinery this skill's scripts reuse (`scripts/fixture.js` wraps `tests/server/plusaudio/collection/helpers/anki-python.js` rather than re-implementing it), so a green run here means the fixture-building and lock-holding steps below will work too.

`npm test` needs only `ANKI_PYTHON_BIN`: the collection tests that import a shared deck build their own small one with Anki (`buildSharedDeckPackage` in that helper), so no test depends on what is in your package.
`ANKI_FIXTURE_APKG` is for the browser drives: `ui/tools/fixture.sh` imports it into the UI fixture every drive copies (its decks are the list the screens show), and `states.mjs` builds its "before amgi" collection the same way (`scripts/fixture.js`).

## Building the fixture

```bash
ui/tools/fixture.sh            # .e2e/fixture/collection.anki2
```

Wipes and rebuilds `.e2e/fixture` (gitignored) every run, from nothing, with the real `anki` library end to end - not a hand-rolled `.anki2` writer:
`scripts/fixture.js`'s hand-made decks and notes with everything in `ANKI_FIXTURE_APKG` imported on top, then amgi installed into it the way the **Install into Anki** button does (`ui/tools/fixture-install.mjs`, with the fixture folder as the Anki folder, so nothing lands in a real Anki), then `ui/tools/fixture-extra.py`'s Korean decks, a 26-note deck for paging, and amgi notes with clips.

## Running every drive

```bash
make build && ui/tools/e2e.sh           # or: npm run e2e
```

`ui/tools/e2e.sh` starts what the drives need, each on a free port, and stops it all on exit: the fake Gemini and three app servers (`server/build/amgi serve`, started with `CBASE_LISTEN=127.0.0.1:0`, their `cbase: listening <host>:<port>` line read for the port) that differ only in their key - any key (the screens), none (the starter deck is offered), and one pointed at the fake.
Then `ui/tools/drives.sh` runs the drives one at a time, one headless Chrome each, every one on a fresh copy of the fixture, and prints each drive's `ok` count and every `FAIL` line:

- `shoot.mjs`: the deck list, settings, a deck, its language picker, paging through a long deck, the back button, and first-paint timings.
- `flows.mjs`: first run, install, the create-deck modal, the card-design notice, the starter deck.
- `edit.mjs`: the card panel (edit, redo, a failed redo), deleting through the confirm dialog, renaming a deck.
- `deckdelete.mjs`: deleting a deck from the bottom of its page: not offered for Default, the confirmation's counts, Cancel and Escape, a deck with a subdeck, an empty one, Anki holding the file (the failure under the button), a deck deleted underneath the page and a gone deck's address ("This deck no longer exists"), each delete checked in the file with Anki itself.
- `bulk.mjs`: making cards against the fake Gemini, including a per-minute limit (the countdown), a failure, and a spent daily cap.
- `limits.mjs`: text one byte too long for each box (a new deck's name and a rename past 512 bytes, a paste past 64 KB, a card field past 4096 bytes, a bridge token past 2048, an Anki data folder path of 1500 bytes refused by Save and Scan alike), each refused with a message and nothing kept.
- `states.mjs`: the decks screen in each setup state: ready, card type missing, locked (a real lock, see below) and released again, no profile, no Anki folder.

Then `ui/tools/incident1842.sh` (also runnable alone, one command, building what it needs) replays incident 18:42 in a browser: `server/build/anki_standin` plays Anki holding a temp-HOME copy of the schema18 fixture after its own backup dropped its lock, the page loads `/decks` twice with the add-on files behind (so each load's template check would reinstall into the collection), and after Anki closes the file must have SQLite's header, no zero page, integrity ok, the same notes and cards, and pass the anki library's Check Database (with `ANKI_PYTHON_BIN`).
During the window the page must say **Anki locked** and send no `POST /api/anki/install`.
Chrome keeps the real HOME (a temp one has no keychain, and macOS shows a dialog); only the server and the stand-in get the temp one.

Screenshots land in `.e2e/shots` (or the folder given to `e2e.sh`), the logs in `.e2e/drives` and `.e2e/servers`.
A whole run takes about six minutes, most of it the bulk drive waiting out the fake's per-minute limit, as a real one would.

Nothing is real Gemini: the fake is the tests' own, `tests/server/plusaudio/helpers/fake-gemini.js`, a gRPC server for `GenerativeService/GenerateContent` over cleartext HTTP/2 that answers speech, transcription and structured requests the way the tests expect.
The bulk drive switches its limits through its `POST /control` endpoint.
A fresh fake and server matter: the fake's "broken line" fails once only, and a server's rate gate remembers the limits it met, which is why `e2e.sh` starts both every run.

The page keeps its settings in cdom's store (IndexedDB, key `amgi:anki-settings:1`, a block of `X-Amgi-*` header lines), and each drive seeds it before the first navigation (`flows.mjs`'s and `states.mjs`'s `open`).

**Always open the PNGs with the Read tool.** Layout defects do not show up in the DOM.
When judging alignment, also measure: `getBoundingClientRect()` through the drive's `evaluate`, compared against `innerWidth` and `innerHeight`, and state the numbers.

## The locked path

`states.mjs` opens a fixture copy with the real `anki` library and holds it open - the same exclusive lock a running Anki desktop client holds on its own collection (`locking_mode=exclusive`, zero busy timeout; see `server/collection/db.c`'s openCollection comment, ported from what was `plusaudio/lib/collection/open.js`) - and checks the mode badge (`nav.navbar span[title]`) says **Anki locked** and the list's place says why.
Then it lets go and checks the badge and the list come back on the next status poll.
amgi also reports **locked**, without opening the file, whenever a `-wal` or a `-shm` sits beside the collection, says **damaged** for a file without SQLite's header, and never checkpoints a collection: the rule and the incident behind it are in `skills/amgi/references/collection-internals.md`, "Locking".
Never point a drive, a probe or `sqlite3` at a real profile's `collection.anki2`: even a read's close can checkpoint into Anki's live `-wal`.
This is a real lock, not a simulated `SQLITE_BUSY`, for the same reason `tests/server/plusaudio/collection/open-lock.test.js` insists on one: an assertion that only your own reader agrees with your own writer proves nothing.

## Testing the bridge transport

```bash
node .claude/skills/e2e-ui/scripts/bridge-http.js .e2e/fixture/collection.anki2
```

No browser here - this is a backend test.
`scripts/bridge_server_entry.py` starts a real `anki/addon/amgi_bridge` HTTP server (real `bridge_server.py` routing and `bridge_auth.py` auth, a real `anki.collection.Collection` behind `bridge_ops.py`) with no Qt and no running Anki process - see that file's own module comment for exactly what that does and does not prove, and why it is a legitimate stand-in rather than a shortcut.
`scripts/bridge-http.js` then does real HTTP requests against it: missing token, wrong token, correct token with no `Origin` header (the shape the C server's bridge client, `server/collection/bridge.c`, always sends), a request in another bridge protocol (refused with 409), correct token with an allowed vs. a foreign `Origin`, a CORS preflight from each, and a real `POST /decks` mutation that a follow-up `GET /decks` has to actually see - proving a write lands in the collection, not just that the server answers 200.

## Gotchas worth remembering

- The app has no login and no signed-in state to wait for - the settings in cdom's store are the entire "session," and they have to be seeded before the first navigation to an app page, or the first render reads the defaults and you are debugging a race, not your change.
  The drives seed them from a page of the app's origin that is not the app (`/__seed__`, a 404), so the app never runs on empty settings.
- Never leave the Anki folder setting empty in a drive: empty means the user's real Anki folder.
- Clicking a deck row goes to `/deck/<id>`, which shows the note list **and** the add-card form on the same page - there is no separate "add a card" screen to navigate to.
- The mode badge has no stable class or test id - it is the only `<span title="...">` in the nav, which the drives rely on.
  Its one-line label (e.g. "Anki locked") and its full explanation (its `title`) are two different strings - assert on the title for the explanation.
- `cdp.mjs` gives every Chrome its own free debugging port, and the drives close theirs on exit; one Chrome at a time keeps timings honest on a loaded machine.
- Chrome's `--use-file-for-fake-audio-capture` is a **no-op on this machine** - the captured stream is digital silence.
  This does not matter for the amgi app (it has no microphone of its own), but it matters for the Anki card template's mic path, which `anki/test/harness/drive.js` drives with `scripts/fakevoice.js` instead (through `scripts/lib.js` and `puppeteer-core`).
  Do not spend time regenerating wav files for that harness; it is not a format problem.
