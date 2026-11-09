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
- **LLVM's clang**, for the page, which is C built to WebAssembly (`brew install llvm`; Apple's clang has no WebAssembly target).
  `brew install binaryen brotli` is optional: a smaller build, and its sizes in the build's last line.
- **The server's C libraries**: sqlite, ICU 78 and OpenSSL from Homebrew (`brew install sqlite icu4c@78 openssl@3`).
  The server is C, on [cbase](https://github.com/alexsave/cbase), and `make start` builds it with Xcode's command line tools (`xcode-select --install`).
- No Node: building and starting amgi is make, clang and the shell. Node (24.12, 25.1 or 26 and later) is for the tests and the linter only.
- **A Gemini API key** from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
  The free tier allows 10 requests per day per model, and a card needs five to seven, so enable billing on the key's project for real use.

```bash
git clone --recurse-submodules https://github.com/alexsave/amgi.git && cd amgi
```

Put the key in a file called `.env.local` at the top of the repo:

```
GEMINI_API_KEY=...
```

The server reads it strictly (`KEY=VALUE`, no blank around the `=`, a value in quotes loses them), and says which line it could not read.
Updating an existing clone: `git pull` and then `make start`; it checks out any submodule a pull added (the server's `cbase/`), and `git submodule update --init --recursive` does the same by hand.
Then build it and start it:

```bash
make start
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

- **Direct**, when Anki is closed: straight off `collection.anki2` through the server's collection code (`server/collection/`).
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
make start      # builds ui/out and server/build/amgi, then serves http://127.0.0.1:3000 (CBASE_LISTEN or PORT to move it)
make build      # the same, not started
npm install     # once, for the tests and the linter (dev only)
npm run lint
npm test        # builds, then the C unit tests (ASan, UBSan), the node:test suites (the server's contract, plusaudio, anki, ui) and the add-on's Python tests
npm run e2e     # builds, then every browser drive against fresh servers (see .claude/skills/e2e-ui)
make -C server check   # cbase's whole check with amgi as its product (its gates, unit tests and smokes)
```

The page is C, compiled to WebAssembly on [cdom](https://github.com/alexsave/cdom) (the submodule at `cdom/`) by `ui/Makefile`, which builds on cdom's own make fragment (`cdom.mk`) and which `ui/build.sh` runs: the C owns the DOM, one call per change, and there is no JavaScript framework.
The server is C: `server/build/amgi`, the amgi app (`server/app/`, `server/amgi/`) on [cbase](https://github.com/alexsave/cbase)'s `serve` (the submodule at `cbase/`), with the Anki collection code (`server/collection/`), the rate gate and the Gemini client (gRPC over HTTP/2, cbase's) in the same process, and no Node.
`make start` starts it through cbase's `make serve` (`make -C server serve`, run from the repository root): it listens on `CBASE_LISTEN` (`127.0.0.1:3000` by default, or `PORT`), says `cbase: listening <host>:<port>` on stdout, answers only a `Host` of `127.0.0.1`, `localhost` or `[::1]` at that port (against DNS rebinding), sends no CORS headers, and reads `.env.local` through cbase's `CBASE_ENV_FILE`.
`.claude/skills/e2e-ui/` and `ui/tools/` drive the app in headless Chrome against a fixture Anki collection.
`anki/test/harness/drive.js` does the same for the card template.
`test/parity/` holds the server's contract: an HTTP suite over every route and error shape, compared byte for byte with a recording (made from the Node server the C one replaced), and a collection runner that applies one operation list to schema 11 and 18 fixtures through the C core and compares every row afterwards.
`test/bridge/` runs the C bridge client against the add-on's real server.

```
ui/src/          The page, in C: decks, deck view, card form and panel, bulk run, settings, first run
ui/css/          Its stylesheets
ui/wire/         The wire format between the page and the server
ui/tools/        Browser drives and their fixture
ui/test/         Tests of the C against what it must agree with
test/parity/     The server's contract: the HTTP and collection suites, their fixtures and recordings (each suite's header says how it compares)
test/bridge/     The bridge client against the add-on's real server
server/          The C server (make -C server): the amgi app on cbase (app/, amgi/), the collection core (collection/, json/), their tests (test/)
src/utils/       The review loop and voice-activity detection the card template shares
plusaudio/       CLI for .apkg files and the card generation policy (lib/cardGeneration/)
anki/            Card template plus the mic and bridge add-ons
skills/amgi/     Agent skill: how an LLM runs and drives amgi (linked from .claude/skills, beside e2e-ui)
```

### The app's API

Everything the page and the server say to each other is in amgi's wire format, so a second server (in C, say) could be written from these four things alone, and the page would not change.

- **Layouts**: `ui/wire/wire.h` describes the bytes (little-endian, length-prefixed UTF-8 strings, counted lists, a `AMW2` magic and a kind byte per message).
  `ui/wire/wire.c` holds the one schema table: each kind's fields in order, their types and their names.
  The page's C and the server's C both walk that table, so there is no second copy of a layout.
  Every answer is `application/x-amgi-wire`, and a request body must be sent as that type.
- **Routes**: `ROUTES` in `server/amgi/routes.c` names, for each method and path under `/api/anki/`, the kind of its request body and of its answer.
  Any 4xx or 5xx answer is the `error` kind.
  A route that cannot reach the collection answers 409 with `mode` (`locked`, `unconfigured`, ...), and `GET` or `DELETE /decks/:id` for a deck that is not there answers 404.
  `DELETE /decks/:id` deletes a deck as Anki does (its subdecks, their cards, the notes left with no card, with graves so a sync deletes the same on every device), and `GET /decks/:id` says beforehand what it would take; the Default deck is refused, since Anki only empties it.
- **Settings**: every request carries the five `X-Amgi-*` headers (Anki folder, collection, profile, bridge address and token; `server/amgi/web.c` reads them), each percent-encoded.
- **Rate limits**: a refused Gemini call is a 429 `error` with `retryAfterMs` (wait, then the same request again), `notStarted` (nothing was done), `dailyCap` (nothing will work until the daily cap resets) and `maxWaitMs` (the longest wait worth making).
  The generator scripts report the same two cases as exit codes 3 (rate limited, the wait on stdout) and 4 (daily cap), from `plusaudio/lib/cliExit.js`.

### JSON that remains and why

amgi's own boundaries are binary layouts, the Anki bridge's included; JSON stays only where something outside amgi forces it.
`test/no-json.test.mjs` scans every shipped source file and fails on any JSON call not listed here (its `ALLOWED` list holds the exact counts and reasons, and the test checks this section names the same files).
amgi's own JSON lives in one folder, `plusaudio/lib/json/`, behind one named function per use.

- `plusaudio/lib/json/modelAnswer.js`: Gemini's structured answers are JSON text, and nothing else is offered ([plusaudio/ANSWER_FORMAT.md](plusaudio/ANSWER_FORMAT.md) says what was measured against the alternatives).
- `server/json/model_answer.c`, `server/json/model_answer.h`, `server/amgi/cards.c`: the same answers read by the C server, through `model_answer_parse` in the C quarantine (the quarantine's one parser under its own name), called once by `cards.c`'s port of `readStructured`.
- `server/json/anki_json.c`, `server/json/anki_json.h`, `server/collection/decks.c`, `server/collection/notes.c`: the collection core in C, which reads and writes the same Anki formats; its one JSON reader and writer is quarantined in `server/json/` behind named functions, and the scan fails on JSON parsed or formatted anywhere else in C.
- `plusaudio/lib/deck.js`, `plusaudio/lib/package.js`: Anki's own formats in the `.apkg` CLI (a schema 11 package's `col.models`, an older `.apkg`'s media map), read and written as Anki defines them.

See [ROADMAP.md](ROADMAP.md) for what is still open.

## License

amgi is licensed under the GNU Affero General Public License, version 3 or later: see [LICENSE](LICENSE).
Copyright 2026 Alex Saveliev.
The agent skills in `skills/` and `.claude/skills/` are under the MIT License instead, so they can be copied freely: see [skills/LICENSE](skills/LICENSE).
cdom, the C DOM library at `cdom/`, is a git submodule under the MIT License.
The notices for code and assets that came from elsewhere are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
