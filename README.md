# amgi

https://github.com/user-attachments/assets/731cb0b9-276a-4f10-89d0-6e3fdefa2896

Flashcards that make you **speak**, built on top of Anki instead of next to it.

amgi reaches into your real Anki collection to generate cards with native-sounding audio.
Anki does the scheduling, sync and review.
Reviewing uses a card template this repo ships: the prompt plays, the microphone opens by itself, and your voice is played back against the native recording.

There is no login and no hosted backend.
Card text, speech and the check that each clip says what the card says all come from Google Gemini, with your own key, from your own machine.

## Quick start

You need:

- **Anki** (desktop), from [apps.ankiweb.net](https://apps.ankiweb.net).
  Open it once so it creates a profile, then quit it.
- **Node** 24.12, 25.1, or 26 and later (`node --version`).
  25.0.x does not work.
- **LLVM's clang**, for the page, which is C built to WebAssembly (`brew install llvm`; Apple's clang has no WebAssembly target).
  `brew install binaryen brotli` is optional: a smaller build, and its sizes in the build's last line.
- **A Gemini API key** from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
  The free tier allows 10 requests per day per model, and a card needs five to seven, so enable billing on the key's project for real use.

```bash
git clone --recurse-submodules <this repo> amgi && cd amgi
npm install
```

Put the key in a file called `.env.local` at the top of the repo:

```
GEMINI_API_KEY=...
```

Then build it and start it:

```bash
npm start
```

1. Open <http://localhost:3000> and press **Install into Anki**.
   That copies two add-ons and the card template into your Anki data folder.
   With Anki closed it also adds the `amgi Listening` note type right away.
   With Anki open, restart Anki once instead.
2. Create a deck and paste in the phrases you want cards for, one per line.
   amgi writes the target-language side, records both sides, and keeps a clip only if transcribing it back matches the card.
3. Review in Anki as with any deck.
   Every note makes two cards, one in each direction.

No key yet?
Without one, amgi offers a starter deck of ten everyday phrases, already recorded, in any pair of its 18 languages.

The hands-free loop runs on Anki desktop and AnkiDroid 2.25+ (turn on Advanced > "Allow templates to record audio").
AnkiMobile plays the audio but needs one tap to end your turn.
See [anki/README.md](anki/README.md) for the per-client table.

## What the add-ons do

- **`amgi_mic`** lets a card's JavaScript open your microphone, which Anki refuses on its own.
  It is 90 lines in one file.
- **`amgi_bridge`** lets amgi edit your collection while Anki is open.

Press **Install into Anki** again after pulling a newer amgi to update both.
Your notes and bridge token are left alone.
To install by hand, see [anki/README.md](anki/README.md).

## Two transports

The app never talks to a database.
It reads and writes your Anki collection one of two ways:

- **Direct**, when Anki is closed: straight off `collection.anki2` through `plusaudio/lib/collection/`.
- **Bridge**, when Anki is open: Anki locks the file, so the `amgi_bridge` add-on runs a small local HTTP server and the app talks to that (endpoints in [anki/addon/amgi_bridge/README.md](anki/addon/amgi_bridge/README.md)).

The badge shows **Anki connected** either way, and explains itself when neither works.
Settings (`/settings`) holds the profile and the bridge address and token.

## Command line

`plusaudio/` adds generated audio to an existing `.apkg` in place, without touching note identity or review history:

```bash
cd plusaudio
node add-audio.js "My Deck.apkg" --dry-run   # what would be generated, no key needed
node add-audio.js "My Deck.apkg"             # needs GEMINI_API_KEY
```

See [plusaudio/README.md](plusaudio/README.md) for the options.

## Development

```bash
npm start       # builds ui/out, then serves http://localhost:3000 (PORT=0 takes a free port)
npm run lint
npm test        # builds, then the node:test suites (server, plusaudio, anki, ui) and the add-on's Python tests
npm run e2e     # builds, then every browser drive against fresh servers (see .claude/skills/e2e-ui)
```

The page is C, compiled to WebAssembly by `ui/build.sh`, on [cdom](https://github.com/alexsave/cdom) (the submodule at `cdom/`): the C owns the DOM, one call per change, and there is no JavaScript framework.
The server is one plain Node HTTP server, `ui/server/serve.mjs`, that serves the page and runs the `/api/anki` routes.
`.claude/skills/e2e-ui/` and `ui/tools/` drive the app in headless Chrome against a fixture Anki collection.
`anki/test/harness/drive.js` does the same for the card template.

```
ui/src/          The page, in C: decks, deck view, card form and panel, bulk run, settings, first run
ui/css/          Its stylesheets
ui/wire/         The wire format between the page and the server
ui/server/       The HTTP server
ui/tools/        Browser drives and their fixture
ui/test/         Tests of the C against what it must agree with
src/server/      The /api/anki routes and the server-only transport, resolved on every request
src/utils/       The review loop and voice-activity detection the card template shares
plusaudio/       CLI for .apkg files and the card generation policy (lib/cardGeneration/)
anki/            Card template plus the mic and bridge add-ons
skills/amgi/     Agent skill: how an LLM runs and drives amgi (linked from .claude/skills, beside e2e-ui)
```

### The app's API

Everything the page and the server say to each other is in amgi's wire format, so a second server (in C, say) could be written from these four things alone, and the page would not change.

- **Layouts**: `ui/wire/wire.h` describes the bytes (little-endian, length-prefixed UTF-8 strings, counted lists, a `AMW2` magic and a kind byte per message).
  `ui/wire/wire.c` holds the one schema table: each kind's fields in order, their types and their names.
  The page's C and the Node server both walk that table, so there is no second copy of a layout.
  Every answer is `application/x-amgi-wire`, and a request body must be sent as that type.
- **Routes**: `ROUTES` in `ui/server/serve.mjs` names, for each method and path under `/api/anki/`, the kind of its request body and of its answer.
  Any 4xx or 5xx answer is the `error` kind.
  A route that cannot reach the collection answers 409 with `mode` (`locked`, `unconfigured`, ...), and `GET` or `DELETE /decks/:id` for a deck that is not there answers 404.
  `DELETE /decks/:id` deletes a deck as Anki does (its subdecks, their cards, the notes left with no card, with graves so a sync deletes the same on every device), and `GET /decks/:id` says beforehand what it would take; the Default deck is refused, since Anki only empties it.
- **Settings**: every request carries the five `X-Amgi-*` headers from `src/server/anki/settings.js` (Anki folder, collection, profile, bridge address and token), each percent-encoded.
- **Rate limits**: a refused Gemini call is a 429 `error` with `retryAfterMs` (wait, then the same request again), `notStarted` (nothing was done), `dailyCap` (nothing will work until the daily cap resets) and `maxWaitMs` (the longest wait worth making).
  The generator scripts report the same two cases as exit codes 3 (rate limited, the wait on stdout) and 4 (daily cap), from `plusaudio/lib/cliExit.js`.

### JSON that remains and why

amgi's own boundaries are binary layouts; JSON stays only where something outside amgi forces it, or while work in flight replaces it.
`test/no-json.test.mjs` scans every shipped source file and fails on any JSON call not listed here (its `ALLOWED` list holds the exact counts and reasons, and the test checks this section names the same files).
amgi's own JSON lives in one folder, `plusaudio/lib/json/`, behind one named function per use.

- `plusaudio/lib/json/modelAnswer.js`: Gemini's structured answers are JSON text, and nothing else is offered ([plusaudio/ANSWER_FORMAT.md](plusaudio/ANSWER_FORMAT.md) says what was measured against the alternatives).
- `plusaudio/lib/json/bridgeBody.js` and the add-on's `anki/addon/amgi_bridge/bridge_server.py` (leaving): the bridge protocol, which moves to a binary layout with a version check.
- `src/server/anki/plusaudioCli.js` (leaving): the generator scripts' IPC channel, which Node serializes as JSON; it carries the rate gate's messages.
- `plusaudio/lib/collection/decks.js`, `plusaudio/lib/collection/deck-remove.js`, `plusaudio/lib/collection/notes.js`, `plusaudio/lib/collection/notetypes.js`, `plusaudio/lib/deck.js`, `plusaudio/lib/package.js`: Anki's own formats (a schema 11 collection's `col` columns, the config table's values, an older `.apkg`'s media map), read and written as Anki defines them.

See [ROADMAP.md](ROADMAP.md) for what is still open.
