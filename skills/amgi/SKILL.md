---
name: amgi
description: Use amgi to build speaking-practice Anki decks - run the app, make cards (Gemini writes the target-language side, records both sides, and keeps a clip only if transcribing it back matches), list and edit decks and notes in the user's real Anki collection with Anki open or closed, and add audio to an existing .apkg from the command line. Use whenever the user wants amgi to make cards, fill a deck, or read or change their Anki collection through amgi.
---

# Using amgi

amgi is one Next.js app in this repo.
Its server reads and writes the user's real Anki collection, directly from `collection.anki2` when Anki is closed, or through the `amgi_bridge` add-on's local HTTP server when Anki is open.
Card text, speech and the check that each clip says what the card says all come from Google Gemini, with the user's own key.
There is no login and no hosted backend.

Drive it through the app's HTTP API (`/api/anki/*`).
It picks the transport on every request, writes through the same code the UI uses, and enforces the rate limits.
Never edit `collection.anki2` with sqlite3 or any other tool: see `references/collection-internals.md` for why.

## Run it

Needs Node 24.12, 25.1 or 26+ (not 25.0.x), desktop Anki opened once so it has a profile, and a Gemini key.

```bash
npm install
echo 'GEMINI_API_KEY=...' > .env.local     # read by the app's server
npm run dev                                 # http://localhost:3000
```

Keep port 3000 if the user will use the UI with Anki open: the `amgi_bridge` add-on only accepts browser origins listed in its `bridge_allowed_origins` config, which defaults to port 3000.
Calls from the app's server to the bridge send no `Origin` and are not affected.

Then install once with `POST /api/anki/install` (the **Install into Anki** button does the same).
It copies the `amgi_mic` and `amgi_bridge` add-ons into the Anki folder and, with Anki closed, adds the `amgi Listening` note type at once.
With Anki open, the note type arrives when Anki next restarts (`needsRestart: true` in the reply).

## Point every request at a collection

Every `/api/anki/*` call reads one header, `X-Amgi-Anki-Settings`, holding JSON:

```json
{"baseDirOverride": "", "collectionPath": "/Users/me/Library/Application Support/Anki2/User 1/collection.anki2", "profileName": "User 1", "bridge": {"baseUrl": "http://127.0.0.1:8798", "token": "..."}}
```

- `collectionPath` comes from `GET /api/anki/profiles`, which lists `{name, collectionPath}` for every profile under the Anki folder (or under `baseDirOverride`).
  Without it, and without a working bridge, every call answers `mode: "unconfigured"`.
- `bridge` is optional.
  The token and port are in Anki under Tools > amgi: Bridge status..., which is also where the bridge is switched on (it is off by default).
  When the bridge answers, amgi uses it; otherwise it falls back to the file.
- `GET /api/anki/status` says which transport answered: `direct`, `bridge`, or why neither did (`locked`: Anki has the file open and the bridge is off; `not-found`; `unsupported-schema`; `bridge-no-collection`; `unconfigured`).
  On `locked`, ask the user to close Anki or turn the bridge on; never copy or force the file.

## The API

Paths are under `/api/anki`.
Bodies are JSON, and every success reply carries `mode`.
A failure is `{error}` with a 4xx or 5xx status.

| Call | Does |
| --- | --- |
| `GET /status` | Transport and schema version |
| `GET /profiles` | Profiles under the Anki folder |
| `GET /install`, `POST /install` | Whether the add-ons and note type are current; install or update them |
| `GET /decks` | `{decks: [{id, name, noteCount, ...}]}`. `A::B` is subdeck B of A |
| `POST /decks` `{name}` | Find or create, parents included |
| `PATCH /decks/:id` `{name}` | Rename |
| `GET /notetypes` | `{notetypes: [{id, name, fieldNames, templates}]}` |
| `GET /decks/:id/notes?offset=&limit=` | `{notes: [{id, notetypeId, fields, ...}], offset, limit, hasMore}`, at most 200 a page, subdecks included |
| `GET /decks/:id/notes/field-values?notetypeId=&fieldIndex=` | `{values}`: one field of every note of that type in the deck, for duplicate checks |
| `POST /card-text` `{userInput, knownLanguage, learningLanguage, includeCueAudio}` | Writes one card's text, records and stores its clips; adds no note |
| `POST /audio` `{text, language, fresh}` | One validated clip, stored: `{filename, reference, reused}` |
| `POST /notes` `{deckId, notetypeId, fields, tags, language, learningFieldIndex}` | Adds one note; `fields` is an array in the note type's field order |
| `POST /notes/bulk` `{notes: [...]}` | The same shape per note, in one write; one result per note, and one bad note never aborts the rest |
| `PATCH /notes/:id` `{fields, language, learningFieldIndex}` | Replaces a note's fields in place |
| `DELETE /notes/:id` | Deletes a note and its cards, with their review history. Ask first |
| `GET /media/:filename` | A stored clip's bytes |
| `GET /starter`, `POST /starter` `{known, learning, name}` | A ready-made ten-phrase deck with shipped audio, for a user with no key |

Language codes are amgi's own: `en`, `ko`, `ja`, `zh_cn`, `zh_hk`, `es`, `fr`, `pt`, `ru`, `id`, `de`, `tr`, `vi`, `it`, `th`, `hi`, `ur`, `ar` (`src/constants/languages.js`).

## Making cards

Do what the deck page does (`src/components/Card/BulkRun.js`), one phrase at a time:

1. `GET /notetypes` and find `amgi Listening`.
   Its fields are `Cue`, `CueAudio`, `Target`, `TargetAudio`, `Language`, `Notes`.
   Find them by name, case-insensitively, never by position: the user may have added fields of their own (`src/utils/amgiNotetype.js`).
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

When a model is limited, the API answers 429 with `retryAfterMs`:

- `notStarted: true`: nothing was spent; wait `retryAfterMs` and send the same call again.
- no `notStarted`: the card had started and hit a per-minute limit; wait `retryAfterMs` and retry it.
- `dailyCap: true`: the day's quota is spent; stop and tell the user.

One rate gate in the server owns all waiting (`plusaudio/lib/rateGate.js`), so wait exactly `retryAfterMs` and add no backoff of your own.
Make cards one after another; parallel calls only queue on the same gate.

## Command line

`plusaudio/` has three Node scripts.
They read `GEMINI_API_KEY` from the environment only, not from `.env.local`.

```bash
cd plusaudio
node add-audio.js "My Deck.apkg" --dry-run          # what would be generated, no key needed
GEMINI_API_KEY=... node add-audio.js "My Deck.apkg" --text-field Back --audio-field Audio --language ko
GEMINI_API_KEY=... node generate-card-text.js --known en --learning ko --input "where is the station"
GEMINI_API_KEY=... node generate-clip.js --text "역이 어디예요?" --language ko --out /tmp/clip.wav
```

`add-audio.js` writes a copy of an `.apkg` with a validated clip per note, keeping note ids, GUIDs and review history, so importing it updates the deck instead of duplicating it.
Run `--dry-run` first and show the user the count, because generation costs them money.
Clip names are hashes of the language and text, so a rerun only makes clips for new or changed text.
`plusaudio/README.md` lists every option.
`generate-card-text.js` prints one JSON line, `{front_text, back_text, spoken_reading}`, and `generate-clip.js` writes one WAV.
Both exit 3 when rate limited (stdout then carries `retry-after-ms=<n>`) and 4 when the daily cap is spent.

## The bridge directly

With Anki open and the bridge on, the add-on serves the collection calls at `http://127.0.0.1:8798`, without the `/api/anki` prefix: status, decks, notetypes, notes, field values and media.
Every request needs `X-Amgi-Bridge-Token: <token>`.
It has no profiles, install, starter or Gemini endpoints, so making cards still goes through the app.
`anki/addon/amgi_bridge/README.md` has the request and reply shapes and the security model.

## Rules

- Notes keep their identity: update a note in place rather than deleting and re-adding it, which loses its review history and duplicates it on the user's other devices after sync.
- Ask before anything destructive: deleting notes, renaming decks the user did not mention, or changing a note type that already has reviews.
- After an edit with Anki closed, the user should open Anki and sync.
  If AnkiWeb asks to upload or download the whole collection, the side with the edits is this computer: upload.
- Every random draw (the Gemini voice, note GUIDs) comes from one seedable source, `plusaudio/lib/random.js`.
  Setting its `SEED` to a constant makes runs reproducible, and must never reach a collection someone keeps, because equal GUIDs mean "the same note" to Anki.
- To work on amgi itself rather than use it, read `README.md` and the `e2e-ui` skill in `.claude/skills/`.

## Going deeper

- `references/card-templates.md`: card templates that play audio, run JavaScript or use the microphone, per Anki client.
- `references/collection-internals.md`: how the collection file, locking, schemas, media, `.apkg` import matching, sync and backups work.
