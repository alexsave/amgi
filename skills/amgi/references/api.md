# amgi: the raw API, the page, the bridge, the Node scripts and the rules

The command line in `../SKILL.md` covers adding decks and cards; this is everything else, for reference.

amgi is one app in this repo: a page written in C (built to WebAssembly on cdom) and a server in C, the amgi app on cbase serve (the submodules `cdom/` and `cbase/`).
`server/build/amgi` is both: `amgi serve` is the server in the foreground (the same one `make start` runs as `server/build/amgi-serve`), and its other commands are the command line (`../SKILL.md`), a client of that server on loopback.
The server says `cbase: listening <host>:<port>` on stdout, takes `CBASE_LISTEN=127.0.0.1:0` for a free port, and answers only a `Host` of `127.0.0.1`, `localhost` or `[::1]` at that port.
Its server reads and writes the user's real Anki collection, directly from `collection.anki2` when Anki is closed, or through the `amgi_bridge` add-on's local HTTP server when Anki is open.
Card text, speech and the check that each clip says what the card says all come from Google Gemini, with the user's own key.
There is no login and no hosted backend.

Drive it through the command line, the page in a browser, or the server's API (`/api/anki/*`) from a script.
Every way, the server picks the transport on every request, writes through the same code, and enforces the rate limits.
Never edit `collection.anki2` with sqlite3 or any other tool: see `collection-internals.md` for why.

## Run it

Needs make and LLVM's clang (`brew install llvm`) to build the page, Homebrew's sqlite, ICU 78 and OpenSSL (`brew install sqlite icu4c@78 openssl@3`) and Xcode's command line tools to build the server, desktop Anki opened once so it has a profile, and a Gemini key.
The command line needs only `make server` (no LLVM, no Node); `make build` and `make start` also build the page, which needs LLVM.
Node (24.12, 25.1 or 26+) is for the tests, the linter, and a script that calls the raw API through `ui/wire/wire.mjs` (below).

```bash
git submodule update --init --recursive     # cdom (the page's DOM library) and cbase (the server's platform)
echo 'GEMINI_API_KEY=...' > .env.local     # read by the app's server: KEY=VALUE, no blank around the =
make start                                  # builds ui/out and the server, serves http://127.0.0.1:3000 in the foreground
```

Keep port 3000 if the user will use the UI with Anki open: the `amgi_bridge` add-on only accepts browser origins listed in its `bridge_allowed_origins` config, which defaults to port 3000.
Calls from the app's server to the bridge send no `Origin` and are not affected.

Installing is a one-time step the user chooses, not part of making a card: `GET /api/anki/install` (or `amgi status`) says whether it is ready, and `POST /api/anki/install` (`amgi install`, the **Install into Anki** button) runs only when the user asks.
It copies the `amgi_mic` and `amgi_bridge` add-ons into the Anki folder and, with Anki closed, adds the `amgi Listening` note type at once.
With Anki open, the note type arrives when Anki next restarts (`needsRestart` in the reply).

## Driving the page

The simplest way to do what a user does is to do it in the page: open <http://localhost:3000>, and the deck list, the deck page, the card form and the paste-many-lines run all work as for a person.
`ui/tools/` has headless Chrome drives (shoot, flows, edit, bulk, states) that do exactly this through `cdom/tools/cdp.mjs`, and they are the worked examples of every flow: what to click, what to wait for, what the page shows.
The `e2e-ui` skill runs them against a fixture collection.

## The server's API

The command line (`../SKILL.md`) calls these routes for you and hides the wire format; use them directly only for what it does not do (renames, edits, deletes, bulk adds), and run `amgi up` first for a server to call.

Every request and answer is in amgi's wire format, not JSON: fixed binary layouts, `application/x-amgi-wire`.

- `ui/wire/wire.h` describes the bytes, and the one schema table in `ui/wire/wire.c` lists each kind's fields in order, with their names.
- `ROUTES` in `server/amgi/routes.c` names, for each route, the kind of its request body and of its answer; any 4xx or 5xx answer is the `error` kind.
- `ui/wire/wire.mjs` turns an object into a kind's bytes and back (`encode(kind, object)`, `decode(kind, bytes)`), after `ui/build.sh` has built `ui/out/wire.wasm`.
  A Node script can use it to call the API, with the same field names as the table below:

```js
import { encode, decode, WIRE_MIME } from './ui/wire/wire.mjs';
const headers = { 'X-Amgi-Collection': encodeURIComponent(collectionPath), 'Content-Type': WIRE_MIME };
const r = await fetch('http://localhost:3000/api/anki/decks', { method: 'POST', headers, body: encode('q_deck_name', { name: 'Korean::Travel' }) });
console.log(r.status, decode(r.ok ? 'deck_created' : 'error', new Uint8Array(await r.arrayBuffer())));
```

### Point every request at a collection

Every call reads five plain headers, each value percent-encoded (`server/amgi/web.c`):

- `X-Amgi-Collection`: the profile's `collection.anki2`, as `GET /api/anki/profiles` lists it (`{name, collectionPath}` for every profile under the Anki folder).
  Without it, and without a working bridge, every call answers `mode` `unconfigured`.
- `X-Amgi-Profile`: that profile's name.
- `X-Amgi-Base-Dir`: another Anki folder than the usual one; leave it out for the user's own.
- `X-Amgi-Bridge-Url` and `X-Amgi-Bridge-Token`: optional.
  The token and port are in Anki under Tools > amgi: Bridge status..., which is also where the bridge is switched on (it is off by default).
  When the bridge answers, amgi uses it; otherwise it falls back to the file.

`GET /api/anki/status` says which transport answered: `direct`, `bridge`, or why neither did (`locked`: Anki has the file open and the bridge is off; `bridge-outdated`: the add-on running in Anki is from another amgi, so press Install into Anki again and restart Anki; `not-found`; `unsupported-schema`; `damaged`: the file does not start with SQLite's header, so amgi did not open it; `bridge-no-collection`; `unconfigured`).
On `locked`, ask the user to close Anki or turn the bridge on; never copy or force the file.
On `damaged`, tell the user Anki can restore the collection from one of its backups; never try to repair it.

### The routes

Paths are under `/api/anki`.
Every success answer about the collection carries `mode` (not `profiles`, `install` or `starter`).
A failure is the `error` kind, `{error}`, with a 4xx or 5xx status, except an unexpected server error, an unknown route and a missing clip, which answer plain text.

| Call | Does |
| --- | --- |
| `GET /status` | Transport and schema version |
| `GET /profiles` | Profiles under the Anki folder |
| `GET /install`, `POST /install` | Whether the add-ons and note type are current; install or update them |
| `GET /decks` | `{decks: [{id, name, noteCount}]}`. `A::B` is subdeck B of A |
| `POST /decks` `{name}` | Find or create, parents included |
| `PATCH /decks/:id` `{name}` | Rename |
| `GET /decks/:id` | `{id, name, subdecks, cards, notes}`: what deleting the deck would take, changing nothing. 404 when it is not there |
| `DELETE /decks/:id` | Deletes the deck, its subdecks, their cards and the notes left with no card, as Anki's own delete does: `{id, name, decks, cards, notes}`. The Default deck (id 1) is refused (400), since Anki would only empty it; a deck already gone is 404. Ask first, naming what `GET /decks/:id` counted |
| `GET /notetypes` | `{notetypes: [{id, name, fieldNames, sortFieldIndex}]}` |
| `GET /decks/:id/notes?offset=&limit=` | `{notes: [{id, notetypeId, fields, tags}], offset, limit, hasMore}`, at most 200 a page, subdecks included |
| `GET /decks/:id/notes/field-values?notetypeId=&fieldIndex=` | `{values}`: one field of every note of that type in the deck, for duplicate checks. Both parameters are required whole numbers (400 otherwise) |
| `POST /card-text` `{userInput, knownLanguage, learningLanguage, includeCueAudio}` | Writes one card's text, records and stores its clips; adds no note |
| `POST /audio` `{text, language, fresh}` | One validated clip, stored: `{filename, reference, reused}` |
| `POST /notes` `{deckId, notetypeId, fields, tags, language, learningFieldIndex}` | Adds one note; `fields` is a list in the note type's field order |
| `POST /notes/bulk` `{notes: [...]}` | The same shape per note, in one write; one result per note, and one bad note never aborts the rest |
| `PATCH /notes/:id` `{fields, language, learningFieldIndex}` | Replaces a note's fields in place |
| `DELETE /notes/:id` | Deletes a note and its cards, with their review history. Ask first |
| `GET /media/:filename` | A stored clip's bytes; the name percent-encoded (400 when it is not a valid encoding, a plain-text 404 when there is no such clip) |
| `GET /starter`, `POST /starter` `{known, learning, name}` | A ready-made ten-phrase deck with shipped audio, for a user with no key |

The exact fields of each kind are the schema table's; where this table and `ui/wire/wire.c` disagree, the table in `wire.c` is right.
`decode` gives a dotted name in the schema (`deck.id` in `deck_created`, `audio.reference` in `card_text`) as one flat key of that name.

Language codes are amgi's own: `en`, `ko`, `ja`, `zh_cn`, `zh_hk`, `es`, `fr`, `pt`, `ru`, `id`, `de`, `tr`, `vi`, `it`, `th`, `hi`, `ur`, `ar` (`src/constants/languages.js`).

## Making cards

`amgi card add` does all of this for one phrase.
Through the raw API, do what the deck page's paste-many-lines run does (`ui/src/bulk.c`), one phrase at a time:

1. `GET /notetypes` and find `amgi Listening`.
   Its fields are `Cue`, `CueAudio`, `Target`, `TargetAudio`, `Language`, `Notes`.
   Find them by name, case-insensitively, never by position: the user may have added fields of their own (`amgi_fields_of` in `ui/src/fields.c`).
   Every note makes two cards: hear the cue and say the target, and the reverse.
2. `POST /card-text` with the phrase, the known and learning languages, and `includeCueAudio: true`.
   The reply has `front_text` (known side), `back_text` (learning side), `audio.reference` and `cueAudio.reference`.
   Text and audio come from one call on purpose: for Japanese and Chinese, the reading that steers pronunciation exists only inside it.
3. Fill `Cue` = `front_text`, `CueAudio` = `cueAudio.reference`, `Target` = `back_text`, `TargetAudio` = `audio.reference`, `Language` = the learning code, and every other field `""`.
4. Add the notes with `POST /notes/bulk`, with `language` set to the learning code and `learningFieldIndex` to `Target`'s index.

Each clip is transcribed back and judged against the card, and a mismatch is retried with another voice.
If every attempt fails, the call fails and no card is made: amgi never writes a card with placeholder text or a wrong clip.
If `front_text` equals `back_text`, the model echoed instead of translating; tell the user.
Before adding, check `field-values` for the `Target` field so a phrase already in the deck is not added twice.

## Gemini limits

A card costs five to seven Gemini requests.
The free tier allows 10 requests a day per model, so a real deck needs billing enabled on the key's project.
Say so before a long run.

When a model is limited, the API answers 429, an `error` with `retryAfterMs` and `maxWaitMs` (the longest wait worth making):

- `notStarted: true`: nothing was spent; wait `retryAfterMs` and send the same call again.
- no `notStarted`: the card had started and hit a per-minute limit; wait `retryAfterMs` and retry it.
- `dailyCap: true`: the day's quota is spent; stop and tell the user.

One rate gate in the server owns all waiting (`server/amgi/gate.c`; `plusaudio/lib/rateGate.js` for generate-clip.js), so wait exactly `retryAfterMs` and add no backoff of your own.
Make cards one after another; parallel calls only queue on the same gate.

## generate-clip.js

`plusaudio/generate-clip.js` writes one WAV (the add-on's fill-audio runs it; unlike `server/build/amgi` it needs Node).
It reads `GEMINI_API_KEY` from the environment only, not from `.env.local`, and reaches Gemini over gRPC (HTTP/2 to `generativelanguage.googleapis.com:443`), so a network that only lets HTTP/1.1 through a proxy blocks it.

```bash
cd plusaudio
GEMINI_API_KEY=... node generate-clip.js --text "역이 어디예요?" --language ko --out /tmp/clip.wav
```

It exits 3 when rate limited (stdout then carries `retry-after-ms=<n>`) and 4 when the daily cap is spent.
A card's text, and rewriting one side of a card, is the app's own (`POST /api/anki/card-text`); there is no script for it.

## The bridge directly

With Anki open and the bridge on, the add-on serves the collection calls at `http://127.0.0.1:8798`, without the `/api/anki` prefix: status, decks, notetypes, notes, field values and media.
Every request needs `X-Amgi-Bridge-Token: <token>` and `X-Amgi-Bridge-Protocol: 1`, and every body both ways is amgi's wire format (the `b_*` kinds in `ui/wire/wire.c`, read and written with `ui/wire/wire.mjs` as for the app's API).
It has no profiles, install, starter or Gemini endpoints, so making cards still goes through the app.
`anki/addon/amgi_bridge/README.md` has the request and reply shapes and the security model.

## Rules

- Notes keep their identity: update a note in place rather than deleting and re-adding it, which loses its review history and duplicates it on the user's other devices after sync.
- Ask before anything destructive: deleting notes or decks, renaming decks the user did not mention, or changing a note type that already has reviews.
  A deck delete takes its subdecks and every card in them, on every device the user syncs with.
- After an edit with Anki closed, the user should open Anki and sync.
  If AnkiWeb asks to upload or download the whole collection, the side with the edits is this computer: upload.
- Every random draw (the Gemini voice, note GUIDs) comes from one seedable source, `plusaudio/lib/random.js`.
  Setting its `SEED` to a constant makes runs reproducible, and must never reach a collection someone keeps, because equal GUIDs mean "the same note" to Anki.
- To work on amgi itself rather than use it, read `README.md` and the `e2e-ui` skill in `.claude/skills/`.

## Going deeper

- `card-templates.md`: card templates that play audio, run JavaScript or use the microphone, per Anki client.
- `collection-internals.md`: how the collection file, locking, schemas, media, `.apkg` import matching, sync and backups work.
