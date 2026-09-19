# amgi

Flashcards that make you **speak**, built on top of Anki instead of next to it.

amgi used to be its own web app: its own account, its own Postgres database, its own spaced-repetition scheduler, its own hands-free review loop running in the browser.
It is not that any more.
Anki already does scheduling, storage, sync and review better than a solo project should try to re-build, so amgi stopped competing with it.
What is left is a local-first tool that reaches into your real Anki collection - the same `collection.anki2` the desktop client reads - to generate cards with native-quality audio and to fill audio into notes you already have, while Anki itself does everything a spaced-repetition app is actually good at.

There is no login, no hosted backend, and no environment variable required to start it up.
Card generation calls OpenAI with your own key, from your own machine.
Reviewing happens inside Anki, using a card template this repo ships, which still runs the same hands-free listen-then-speak loop amgi always had - prompt plays, the microphone opens by itself, voice-activity detection ends your turn, and the native recording plays back against yours.

## What's here

- **A Next.js app** (`src/`) - a visual deck browser and card builder for your real Anki collection.
  Browse a deck's notes, create a deck, add a note with generated audio, and point amgi at whichever Anki profile you use.
  It does not review cards; that happens in Anki, not in a browser tab.
- **An Anki add-on** (`anki/addon/`) - two things in one add-on: `amgi_mic` grants a card's JavaScript microphone access (Anki's desktop client never does this on its own), and `amgi_bridge` fills missing audio into a live collection and exposes the local HTTP bridge the app above talks to while Anki is open.
- **A card template** (`anki/notetype/`) - the hands-free review loop, packaged as an ordinary Anki note type you install like any other.
- **`plusaudio/`** - a Node CLI that adds generated audio into an existing `.apkg` file in place, without touching note identity, card scheduling or review history.
- **The card generation policy** (`plusaudio/lib/cardGeneration/`) - the prompts, TTS voice instructions and transcribe-then-judge validation loop that decide what a card actually is.
  It is the one place all three of the above generate audio through, so a clip made from the CLI, from the app, or from inside Anki is made to the same standard.

## Two transports, and when each applies

The app never talks to a database.
It reads and writes your real Anki collection, through whichever of two transports is reachable right now (`src/server/anki/transport.js` picks):

- **Direct**, when Anki is closed - the app reads and writes `collection.anki2` straight off disk, through `plusaudio/lib/collection/` (plain Node: `node:sqlite`, a zip reader, no Anki install required on that side).
- **Bridge**, when Anki is open - Anki holds the collection file open in `locking_mode=exclusive`, which makes it unreadable from outside the Anki process no matter what you try from Node.
  The `amgi_bridge` add-on runs a small local HTTP server inside Anki itself, and the app talks to that instead, over the same vocabulary (`GET /decks`, `POST /notes`, and so on - see `anki/addon/amgi_bridge/README.md` for the full endpoint list).

Whichever transport answers, the app shows the same screens; a badge in the navbar (`AnkiModeBadge`) says which one is live, or explains why neither is - Anki open with the bridge off is reported as **locked**, with the exact fix (`src/utils/ankiModeText.js` has the full wording for every mode).
Settings (`/settings`) is where you point amgi at an Anki profile and, optionally, turn the bridge on and paste in its token.

## Installing the Anki add-on and the card template

1. **The add-on.** Copy `anki/addon/amgi_mic` and `anki/addon/amgi_bridge` into Anki's add-ons folder (Tools > Add-ons > View Files shows you where), or zip each one and use Install from file.
   `amgi_mic` is worth reading before you install it - it is 90 lines, all in one file, and it is the thing granting a web page microphone access.
   `amgi_bridge` needs Node and a checkout of this repo on the machine running Anki, because it shells out to `plusaudio/generate-clip.js` for generation and to `plusaudio/lib/collection/` code paths it shares with the app; see `anki/addon/amgi_bridge/README.md`'s "Install" section for the exact requirement.
2. **The card template.** Copy `anki/media/_amgi-loop.js` and `anki/media/_amgi-loop.css` into your collection's media folder (Tools > Check Database shows the profile path; the folder is `collection.media` inside it), keeping the leading underscores so Anki's own media check leaves them alone.
   Then create a note type with the fields `Prompt`, `PromptAudio`, `Answer`, `AnswerAudio`, `Notes`, and paste `anki/notetype/front.html`, `back.html` and `styling.css` into its card templates.

`anki/README.md` has the full walkthrough, including exactly what goes in the audio fields (`<audio src="...">`, not a sound tag) and a table of what works on each Anki client.

## The plusaudio CLI

For a deck as a `.apkg` file rather than a live collection:

```bash
cd plusaudio
node add-audio.js "My Deck.apkg" --dry-run   # see what would be generated, no key needed
node add-audio.js "My Deck.apkg"             # generate for real, needs OPENAI_API_KEY
```

It changes a note only when it changes that note's audio field, matches Anki's own GUID-based import so re-importing updates the deck in place instead of cloning it, and only regenerates a clip whose text actually changed since the last run.
It needs Node 24.12, 25.1, or 26 and later; see `plusaudio/README.md` for the full option list, including `--audio-tag html` for decks meant to use amgi's own card template instead of Anki's built-in sound tags.

## Local generation

Every generated clip - from the app, from `plusaudio/`, or from the `amgi_bridge` add-on filling a live collection - goes through the same policy in `plusaudio/lib/cardGeneration/cardGeneration.ts`: the prompts, the per-language TTS voice instructions, and a transcribe-then-judge loop that refuses to keep a clip that does not say what the card says.

It needs `OPENAI_API_KEY`, and nothing else - no account, no quota beyond your own OpenAI usage:

- For the app, set it in your shell before `pnpm dev`/`pnpm start`, or put it in `.env.local` at the repo root, which Next.js loads automatically.
- For `plusaudio/` run directly, the same environment variable works, or a `.env` file inside `plusaudio/` itself.

With no key set, the app's own generation route hands back a clearly-fake stub clip (its bytes say so in plain text) instead of failing outright - useful for exercising the rest of the flow with no OpenAI account at all.

## Running the app

The package manager is pnpm, pinned in `package.json#packageManager`; `corepack enable` picks up the right version.

```bash
pnpm install
pnpm dev           # dev server on http://localhost:3000, no environment variables required
pnpm lint          # eslint (next/core-web-vitals)
pnpm test          # jest, plusaudio's and anki's node:test suites, and the add-on's Python tests
pnpm build         # production build
pnpm start         # serve the production build
```

`pnpm dev` and `pnpm build` both pass `--webpack` (see `package.json`'s scripts and `next.config.js`'s own comment on `serverExternalPackages`): Turbopack, Next 16's default bundler, cannot yet resolve `plusaudio`'s use of `node:sqlite` through an externalized workspace package, so webpack is a workaround for a real bug, not a style choice.
On first run, open `/settings` and point amgi at an Anki profile (or let it scan for one); everything else follows from whichever transport that profile makes reachable.

## Verifying changes

`.claude/skills/e2e-ui/` builds a fixture Anki collection, runs the app locally against it with no environment variables, and drives it with `puppeteer-core` - screenshotting the deck list, a deck's notes, deck creation and adding a note, and proving the locked-collection path by actually holding the fixture open with Anki's own Python library while the UI is checked.
It also exercises the bridge transport over HTTP, token and Origin rules included.
Use it to check how a UI change looks in the real app, or to prove a transport change behaves correctly against a real collection rather than a mock of one.

`anki/test/harness/drive.js` does the equivalent for the card template, against a stand-in for Anki's reviewer, since the loop there runs the very same shared code (`src/utils/reviewLoop.js`, `src/utils/voiceActivity.js`) the app used to run itself.

## Repository layout

```
src/app/              Next.js App Router routes, including the /api/anki/* route handlers
src/components/       Deck list, deck view, card form, settings - all client-only
src/contexts/         DeckContext: the one data layer, backed by whichever Anki transport is live
src/server/anki/      Server-only: the direct/bridge transport, resolved fresh on every request
src/utils/            ankiApi client, field-guessing, dates, and the shared review loop + voice-activity detection anki/ bundles into its card template
plusaudio/            Node CLI for .apkg files, and the shared card generation policy (lib/cardGeneration/)
anki/                 The review loop as an Anki card template, plus the mic and bridge add-ons
archives/             Retired implementations kept for reference, with a README per archive on why and what is worth mining (not built, linted or tested)
```

See [ROADMAP.md](./ROADMAP.md) for what is left open after the replatform, and what the replatform already settled.
