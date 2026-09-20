# amgi

Flashcards that make you **speak**, built on top of Anki instead of next to it.

amgi used to be its own web app: its own account, its own Postgres database, its own spaced-repetition scheduler, its own hands-free review loop running in the browser.
It is not that any more.
Anki already does scheduling, storage, sync and review better than a solo project should try to re-build, so amgi stopped competing with it.
What is left is a local-first tool that reaches into your real Anki collection - the same `collection.anki2` the desktop client reads - to generate cards with native-quality audio and to fill audio into notes you already have, while Anki itself does everything a spaced-repetition app is actually good at.

There is no login, no hosted backend, and no environment variable required to start it up.
Card generation calls OpenAI with your own key, from your own machine.
Reviewing happens inside Anki, using a card template this repo ships, which still runs the same hands-free listen-then-speak loop amgi always had - prompt plays, the microphone opens by itself, voice-activity detection ends your turn, and the native recording plays back against yours.

## Zero to your first card

Budget about half an hour, most of it downloads.
Everything happens on one machine, and nothing you make leaves it except the text amgi sends OpenAI to generate audio from.

**Before you start, two things have to be installed.**

- **Anki**, the desktop client, from [apps.ankiweb.net](https://apps.ankiweb.net).
  It is free, and it is where your cards actually live.
  Start with desktop: it is the only client that can run add-ons, and amgi's editing side talks to a desktop profile.
  The deck you end up with reviews anywhere Anki does, and the speaking half is not desktop-only - AnkiDroid 2.25+ runs the full hands-free loop once you turn on Advanced > "Allow templates to record audio", while AnkiMobile plays the prompt and the answer but needs one tap to end your turn, because its maintainer does not grant a card microphone access.
  `anki/README.md` has the per-client table.
  Open Anki once so it creates a profile, then quit it.
- **Node**, from [nodejs.org](https://nodejs.org) or `brew install node` on a Mac.
  Check it with `node --version`: amgi needs **24.12, 25.1, or 26 and later**.
  That floor is not arbitrary - it is where `node:sqlite` gained the API needed to read a modern Anki collection, and where TypeScript runs without a build step.
  25.0.x specifically does not work.

**1. Get this repo and install its dependencies.**

```bash
git clone <this repo> amgi && cd amgi
npm install
```

No `git`? Download the repo as a ZIP and unpack it; nothing here needs git history to run.

**2. Get an OpenAI key, or skip this and come back to it.**
Sign in at [platform.openai.com](https://platform.openai.com), open **API keys**, and create one.
You need credits on the account: a key alone will not generate anything.
For scale, a real 30-card deck with audio on both sides of every card measured **about nine cents**, all in.
Put the key in a file called `.env.local` at the top of the repo:

```
OPENAI_API_KEY=sk-...
```

If you would rather see the whole flow working before paying anyone, skip this step entirely.
With no key set, amgi hands back an obviously-fake stub clip - its bytes say so in plain text - so every screen, every button and the whole Anki round trip still work; only the audio is not real.

**3. Start amgi and install it into Anki.**

```bash
npm run dev
```

Open <http://localhost:3000>. Until amgi is installed, setting it up is the only screen there is, so there is nothing to go and find: it looks for your Anki while it loads, picks the profile if there is only one, and leaves **Install into Anki** as the single thing to press.
That copies two add-ons into your Anki data folder, and the card template in alongside them.
Restart Anki, and it adds the `amgi Listening` note type and its files to your collection on the way up.
That is the whole install: there is no note type to hand-build and nothing to paste anywhere.

It is worth knowing what you just installed, because one of the two add-ons is doing something a card normally cannot:

- **`amgi_mic`** is what lets a card's JavaScript open your microphone.
  Anki's desktop client refuses that on its own and always will, so without this the card can play audio at you but never hear you.
  It is ninety lines in one file, and it is short enough to read before you trust it.
- **`amgi_bridge`** is what lets amgi edit your collection while Anki is open, and it is also what builds the note type on startup.

Press the button again any time you pull a newer amgi - it updates both add-ons and refreshes the card template, and leaves your own notes, your bridge token and any field you added yourself alone.
If you would rather do all of it by hand, "Installing the Anki add-on and the card template, by hand" below is the manual path.

**4. Make a deck and fill it.**
In the app, create a deck, then paste in the lines you want cards for - one phrase per line, in the language you already know.
amgi writes the target-language sentence, generates audio for both sides, and checks each clip by transcribing it back and refusing anything that does not say what the card says.
Each card goes straight into Anki as it is finished, and you can play either recording from the deck screen before you ever open Anki.

**5. Review, in Anki.**
Pick the deck and study it as you would any other.
The cue audio plays, the microphone opens by itself, and the card waits for you to stop talking rather than for you to press anything - about a second of silence ends your turn.
Then the answer appears with the native recording, and you grade yourself with Anki's own buttons: space for Good, `1` for Again, exactly as in every other deck you have.
Every note makes **two** cards, in opposite directions, off the same text and the same two recordings: one plays the language you know and asks you to say the language you are learning, the other plays the language you are learning and asks you what it means.
They are two card templates on one note type, so the pair can never drift apart in content, and the reverse card only appears once a note has a recording in the learning language.

From here on it is an ordinary Anki deck.
It syncs to AnkiWeb, it reviews on your phone (without the microphone half), and its scheduling is Anki's, not amgi's.
That is the point: amgi is a deck editor with a very good audio pipeline, and Anki is everything else.

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

Whichever transport answers, the app shows the same screens and the same **Anki connected** badge; which one got there is in the badge's tooltip, where it only matters when something breaks.
When neither answers, the badge explains why instead - Anki open with no bridge reachable is reported as **locked**, with the exact fix (`src/utils/ankiModeText.js` has the full wording for every mode).
Settings (`/settings`) holds the few things that are genuinely settings: which profile, and the bridge's address and token.
There is no switch for the bridge itself - with Anki open it is the only way to reach the collection, so its only off-state behaviour was the **locked** error.

## Installing the Anki add-on and the card template, by hand

The **Install into Anki** button on amgi's first screen does all of this for you, including building the note type; this is the manual path, for a machine with no amgi checkout on it or for anyone who would rather see every step.

1. **The add-on.** Copy `anki/addon/amgi_mic` and `anki/addon/amgi_bridge` into Anki's add-ons folder (Tools > Add-ons > View Files shows you where), or zip each one and use Install from file.
   `amgi_mic` is worth reading before you install it - it is 90 lines, all in one file, and it is the thing granting a web page microphone access.
   `amgi_bridge` needs Node and a checkout of this repo on the machine running Anki, because it shells out to `plusaudio/generate-clip.js` for generation and to `plusaudio/lib/collection/` code paths it shares with the app; see `anki/addon/amgi_bridge/README.md`'s "Install" section for the exact requirement.
2. **The card template.** Copy `anki/media/_amgi-loop.js` and `anki/media/_amgi-loop.css` into your collection's media folder (Tools > Check Database shows the profile path; the folder is `collection.media` inside it), keeping the leading underscores so Anki's own media check leaves them alone.
   Then create a note type with the fields `Cue`, `CueAudio`, `Target`, `TargetAudio`, `Language`, `Notes`, and paste `anki/notetype/front.html`, `back.html` and `styling.css` into its card templates.
   (These are the names the templates actually use; `anki/README.md` covers renaming an existing deck off the older `Prompt`/`Answer` names without losing data.)

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

- For the app, set it in your shell before `npm run dev` / `npm start`, or put it in `.env.local` at the repo root, which Next.js loads automatically.
- For `plusaudio/` run directly, the same environment variable works, or a `.env` file inside `plusaudio/` itself.

With no key set, the app's own generation route hands back a clearly-fake stub clip (its bytes say so in plain text) instead of failing outright - useful for exercising the rest of the flow with no OpenAI account at all.

## Running the app

The package manager is npm. `plusaudio` is declared as an npm workspace, which is what lets the app `require()` it at runtime as a package rather than bundling it (see `next.config.js`'s note on `serverExternalPackages`).

```bash
npm install
npm run dev     # dev server on http://localhost:3000, no environment variables required
npm run lint    # eslint (next/core-web-vitals)
npm test        # jest, plusaudio's and anki's node:test suites, and the add-on's Python tests
npm run build   # production build
npm start       # serve the production build
```

`npm run dev` and `npm run build` both pass `--webpack` (see `package.json`'s scripts and `next.config.js`'s own comment on `serverExternalPackages`): Turbopack, Next 16's default bundler, cannot yet resolve `plusaudio`'s use of `node:sqlite` through an externalized workspace package, so webpack is a workaround for a real bug, not a style choice.
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
