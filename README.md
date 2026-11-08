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
- **A Gemini API key** from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
  The free tier allows 10 requests per day per model, and a card needs five to seven, so enable billing on the key's project for real use.

```bash
git clone <this repo> amgi && cd amgi
npm install
```

Put the key in a file called `.env.local` at the top of the repo:

```
GEMINI_API_KEY=...
```

Then start it:

```bash
npm run dev
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
npm run dev     # http://localhost:3000
npm run lint
npm test        # jest, plusaudio and anki node:test suites, add-on Python tests
npm run build
npm start
```

`dev` and `build` pass `--webpack` because Turbopack cannot yet resolve `plusaudio`'s `node:sqlite` through an externalized workspace package (see `next.config.js`).

`.claude/skills/e2e-ui/` runs the app against a fixture Anki collection and drives it with `puppeteer-core`.
`anki/test/harness/drive.js` does the same for the card template.

```
src/app/         Next.js routes, including /api/anki/*
src/components/  Deck list, deck view, card form, settings
src/contexts/    DeckContext, backed by whichever transport is live
src/server/anki/ Server-only transport, resolved on every request
src/utils/       API client, shared review loop and voice-activity detection
plusaudio/       CLI for .apkg files and the card generation policy (lib/cardGeneration/)
anki/            Card template plus the mic and bridge add-ons
archives/        Retired implementations, kept for reference
```

See [ROADMAP.md](ROADMAP.md) for what is still open.
