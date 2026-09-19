---
name: e2e-ui
description: Run amgi locally against a fixture Anki collection (no environment variables, no login, no hosted backend) and drive it in headless Chrome - screenshot the deck list, a deck's notes, deck creation and adding a note, prove the locked-collection path against a real Anki-shaped lock, and test the local HTTP bridge's token/Origin rules over real HTTP. Use when asked to check how something looks, prove a UI or transport change works in the real app, hunt for visual weirdness, or debug the direct-file/bridge transport picker.
---

# Driving amgi end to end

amgi is local-first: no account, no hosted backend, no environment variable required to run it.
Everything here runs against a **fixture** Anki collection you build yourself, on disk, and drives with `puppeteer-core` and real HTTP - never against a real personal collection, and never against anything that needs a network credential.

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
cd /Users/alex/Dev/amgi
export ANKI_PYTHON_BIN=/path/to/venv/bin/python
export ANKI_FIXTURE_APKG=/path/to/SomeDeck.apkg
node --test plusaudio/test/collection/open-lock.test.js   # confirms both actually work together
```

That test is not part of this skill - it is `plusaudio`'s own proof that its collection reader agrees with the real Anki library - but it exercises exactly the same `ANKI_PYTHON_BIN`/`ANKI_FIXTURE_APKG` machinery this skill's scripts reuse (`scripts/fixture.js` wraps `plusaudio/test/collection/helpers/anki-python.js` rather than re-implementing it), so a green run here means the fixture-building and lock-holding steps below will work too.

## Building the fixture

```bash
node .claude/skills/e2e-ui/scripts/fixture.js .e2e/fixture
```

Wipes and rebuilds `.e2e/fixture/collection.anki2` (gitignored) every run: a couple of hand-made decks/notes, plus everything in `ANKI_FIXTURE_APKG` imported on top, using the real `anki` library end to end - not a hand-rolled `.anki2` writer.
Safe to re-run as often as you like; nothing about it is idempotent-sensitive because it always starts from nothing.

## Running the app against it

```bash
cd /Users/alex/Dev/amgi
npx next dev --webpack -p 3111
```

No environment variables.
`--webpack` matters: Turbopack cannot yet resolve `plusaudio`'s use of `node:sqlite` through the workspace package (see `next.config.js`'s own comment on `serverExternalPackages`), so plain `next dev` fails differently than this does.
A different port than 3000 keeps this from colliding with a real dev server you might already have running; check it is up with `curl -s -o /dev/null -w "%{http_code}" http://localhost:3111/decks`.

The app is not pointed at the fixture yet - that happens per-script below, by seeding the `amgi:anki-settings` localStorage key before navigation (`scripts/ankiSettings.js`), the same way `scripts/fakevoice.js` seeds a synthetic microphone.
There is no click-through of the Settings page's profile scanner in any of this; if you need to prove that UI specifically, drive it by hand.

## Driving it

```bash
ANKI_COLLECTION=.e2e/fixture/collection.anki2 node .claude/skills/e2e-ui/scripts/shoot.js
```

Screenshots, in order: the deck list, a deck's notes, the create-deck modal filled in, the new (empty) deck it lands on, the add-note form filled in, the generated-audio confirmation, and the deck's notes again with the new note in it.
With no `OPENAI_API_KEY` set, the audio-generation step exercises the mocked-stub-clip path every first-run user without a key also hits (see `src/server/anki/audio.js`) - that is expected, not a failure.

Prints every console error, failed request and 4xx/5xx it saw at the end.
That output is usually where the real bugs are, so read it even when the screenshots look fine.

**Always open the PNGs with the Read tool.** Layout defects do not show up in the DOM.
When judging alignment, also measure: `page.evaluate(() => el.getBoundingClientRect())` and compare against `window.innerWidth/innerHeight`, then state the numbers.

## Proving the locked path

```bash
ANKI_COLLECTION=.e2e/fixture/collection.anki2 node .claude/skills/e2e-ui/scripts/prove-locked.js
```

Opens the fixture with the real `anki` library and holds it open - the same exclusive lock a running Anki desktop client holds on its own collection (`locking_mode=exclusive`, zero busy timeout; see `plusaudio/lib/collection/open.js`'s module comment for the experiments this is built from) - then polls the app's own mode badge (`nav.navbar span[title]`, fed by `src/utils/ankiModeText.js`) until it reports **locked** and checks the explanation text matches what a person actually sees, not just the mode string.
Releases the lock and checks the badge flips back.
This is a real lock, not a simulated `SQLITE_BUSY`, for the same reason `plusaudio/test/collection/open-lock.test.js` insists on one: an assertion that only your own reader agrees with your own writer proves nothing.

## Testing the bridge transport

```bash
node .claude/skills/e2e-ui/scripts/bridge-http.js .e2e/fixture/collection.anki2
```

No puppeteer here - this is a backend test.
`scripts/bridge_server_entry.py` starts a real `anki/addon/amgi_bridge` HTTP server (real `bridge_server.py` routing and `bridge_auth.py` auth, a real `anki.collection.Collection` behind `bridge_ops.py`) with no Qt and no running Anki process - see that file's own module comment for exactly what that does and does not prove, and why it is a legitimate stand-in rather than a shortcut.
`scripts/bridge-http.js` then does real HTTP requests against it: missing token, wrong token, correct token with no `Origin` header (the shape `src/server/anki/bridgeClient.js`'s own server-side `fetch()` calls always have), correct token with an allowed vs. a foreign `Origin`, a CORS preflight from each, and a real `POST /decks` mutation that a follow-up `GET /decks` has to actually see - proving a write lands in the collection, not just that the server answers 200.

## Gotchas worth remembering

- The app has no login and no signed-in state to wait for - `amgi:anki-settings` in localStorage is the entire "session," and it has to be seeded with `page.evaluateOnNewDocument` **before** the first navigation, or the app's first render reads the defaults and you are debugging a race, not your change.
- Clicking a deck row goes to `/deck/<id>`, which shows the note list **and** the add-note form on the same page - there is no separate "add a card" screen to navigate to.
- The three unlabeled `<select>`s in the add-note form (which field to read aloud, which to write audio into, language) have no id or class - `scripts/shoot.js`'s `fieldSelects()` finds them by DOM order (`form.card-form select`, in the order CardForm.js renders them) rather than by a selector that does not exist.
  If CardForm.js's JSX order ever changes, that helper breaks loudly (wrong field gets audio written into it), not silently.
- `AnkiModeBadge` has no stable class or test id either - it is the only `<span title="...">` in the app, which `prove-locked.js` relies on.
  The mode's one-line label (`presentation.label`, e.g. "Anki locked") and its full explanation (`presentation.title`) are two different strings - assert on `.title` for the explanation, not `.label`.
- `next dev` occasionally dies between runs.
  Re-check the port before blaming the app.
- Chrome's `--use-file-for-fake-audio-capture` is a **no-op on this machine** - the captured stream is digital silence.
  This no longer matters for the amgi app (it has no microphone of its own), but it still matters for the Anki card template's mic path, which `anki/test/harness/drive.js` drives with `scripts/fakevoice.js` instead.
  Do not spend time regenerating wav files for that harness; it is not a format problem.
