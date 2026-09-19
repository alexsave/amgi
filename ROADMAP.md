# amgi Roadmap

This roadmap was written for amgi's old shape: its own account, its own Postgres database, its own spaced-repetition scheduler and review UI, all behind Supabase.
That backend is retired (see `archives/supabase-2026/README.md`), and every file path below that starts with `supabase/`, `src/db/`, `src/network/`, `src/contexts/ReviewContext.js` or `src/contexts/RealtimeContext.js` no longer exists.
Rather than delete the thinking that went into each item, every one below is marked with what actually happened to it: **shipped** (the goal was met, usually by a different mechanism), **superseded** (Anki, or the new architecture, already does this and there is nothing left to build), **no longer applicable** (the problem it solved does not exist any more), or **still open** (the underlying idea still holds, but the implementation steps below are historical and a fresh plan would need to be written against the current codebase).
Nothing here has been replaced with a new set of features to build; see README.md for what amgi is today.

## Conventions that replaced the ones below

- Frontend state lives in contexts (`src/contexts/`) - true before and after, but there is only one now, `DeckContext.js`, and it is backed by whichever Anki transport is live (`src/server/anki/transport.js`), not by a database client.
- There is no `src/db/supabase.js` and no `src/network/supabaseApi.js`.
  The equivalent today is `src/utils/ankiApi.js` (a thin fetch wrapper) talking to `src/app/api/anki/*` route handlers, which resolve a transport and call it - see `src/server/anki/transport.js`'s own module comment for the client/server boundary this enforces.
- There are no edge functions and no `wrapRequest`.
  Route handlers under `src/app/api/anki/` are ordinary Next.js server code.
- There are no migrations, no schema and no RLS.
  The only persistent state amgi has of its own is the browser's `localStorage` (which Anki profile, whether the bridge is on) - everything else lives in the user's real Anki collection.
- There is no usage quota and nothing to charge or refund.
  Generation cost is the user's own OpenAI bill, paid directly to OpenAI with their own key.
- Model names live in `plusaudio/lib/cardGeneration/models.ts` (moved from `supabase/functions/_shared/models.ts` when the backend was archived) - never hardcode a model string anywhere else.
- How a card is written and how its audio is validated live in `plusaudio/lib/cardGeneration/cardGeneration.ts`, run from Node by `plusaudio/lib/generator.js`, and reached from the app and from the Anki add-on's bridge by shelling out to `plusaudio/generate-clip.js` rather than requiring the TypeScript module into a browser bundle.
  It imports nothing from Deno, npm or Supabase.
  Keep it that way, or Node can no longer load it and every caller grows a second, worse generator.
- Run `pnpm lint`, `pnpm test` and `pnpm build` before committing; keep all three green, and keep `node anki/test/harness/drive.js` at 23/23 if you touch the card template or its shared source files.
  (The package manager is pnpm, pinned in `package.json#packageManager`.)

---

## Tier 1 - make it a daily driver

### 1.1 Review statistics, streaks, and a heatmap

**Status: no longer applicable.** This wanted a `review_log` table and a `/stats` route inside the web app.
Reviewing does not happen in the web app any more - it happens in Anki, which already has its own review heatmap, streak-adjacent stats and per-deck statistics (Stats screen, `Ctrl+Shift+S`).
Building a second one here would duplicate something Anki already does well.

### 1.2 Deck browser that shows ALL cards

**Status: shipped, by a different mechanism.** The original problem was real: the old `loadDecks` only loaded a scheduled subset (new cards capped, plus learning/due), so the edit screen silently hid cards.
There is no scheduled subset any more, because amgi keeps no scheduling state of its own.
`CardList.js`, via `DeckContext.loadDeckCards` and `GET /api/anki/decks/:id/notes`, pages through every note Anki has in the deck, full stop - see `src/server/anki/transport.js`'s `withNormalizedPaging` for how both transports answer the same paging shape.

### 1.3 Configurable daily new-card limit (actually enforced)

**Status: superseded by Anki.** `MAX_NEW_CARDS_PER_DAY` and the app-side enforcement this item wanted are gone along with the rest of the in-app scheduler.
Anki's own deck options (New Cards > New cards/day) already do exactly this, per deck, and are already enforced by the client the user reviews in.

### 1.4 A reading line for scripts a beginner can't read yet, in the language's own script

**Status: still open, needs rescoping.** The motivation still holds: a beginner memorizing Korean or Japanese phrases by ear may not read the script yet.
The fix is not a Latin transliteration: a learner of Japanese reads かな, not "itta", so any reading line this item ever produces has to be furigana/kana for Japanese, zhuyin for Chinese, and whatever the equivalent native annotation is for any other opaque script - never a romanization.
Romanization of any kind is not an acceptable form for this feature, full stop.
Some groundwork exists already, but for a different purpose and in the wrong script for this: `plusaudio/lib/cardGeneration/cardText.ts` (`readingIsAmbiguous`, `romanizationSystem`, the `spoken_reading` field) computes a reading for reading-ambiguous languages (`ja`, `zh_cn`, `zh_hk`) so generated audio can be validated when the written form does not determine its own pronunciation - today that reading is a Latin romanization (Hepburn romaji, Pinyin, Jyutping), and it is never shown to a learner anywhere; it is purely internal to the generator's own validation loop.
That internal reading is being moved to each language's own script (kana, zhuyin) as a follow-up to this task, so by the time this item is picked back up the groundwork should already be in the right script, not just the right shape.
The app also no longer generates card text or translations at all - `CardForm.js` only generates audio for a field the user already typed - so there is no "the AI wrote this card, also give it a reading" moment left to hook into.
If this is still wanted, it needs its own field on the Anki note type (a `Reading` field alongside `Prompt`/`Answer`, holding kana/zhuyin/etc., never a Latin spelling) and a place in `plusaudio/`'s or the add-on's fill-audio flow that writes it, not a Postgres column or a `ReviewMode.js` render.

### 1.5 TTS audio dedupe / cache

**Status: superseded by architecture.** The original problem, and its `shared/` storage-bucket design, both assumed many users sharing one Supabase project.
There is no shared storage any more, and no cross-user cache to build one in front of.
What exists instead solves the same waste a different way: every generated clip is named by a hash of the profile, language and text (`mediaName()` in `plusaudio/lib/audio-store.js`), so re-running `plusaudio/` or the add-on's fill-audio over a deck only ever generates the clips that changed - see `anki/README.md`: "the clip filenames are content hashes, so nothing is regenerated."

---

## Tier 2 - learning quality

### 2.1 Upgrade the scheduler to FSRS

**Status: superseded by Anki.** There is no scheduler here to upgrade.
Reviewing happens in Anki, which has shipped FSRS as a built-in scheduler option since 23.10; turning it on is a deck-options checkbox for the user, not something amgi needs to implement.

### 2.2 Listening-comprehension cards (reverse direction)

**Status: still open, needs rescoping.** The motivation still holds: every review here is "hear/read known language, speak target," and the reverse skill (hear target, prove you understood) is untrained.
The implementation this item described - a Postgres `direction` column, a composite scheduler key in a `ReviewContext.js` that no longer exists - does not translate.
If revisited, the natural shape in the current architecture is a second Anki card template on the same note type (Anki already supports multiple cards per note; `anki/notetype/` currently defines exactly one), with its own front/back mapping, rather than app-side state.
No implementation plan has been written for this yet.

### 2.3 Hands-free classic review (auto-record with silence detection)

**Status: shipped, but relocated.** This did ship, and is still the only way amgi reviews a card - it just does not run inside the web app any more.
`src/utils/voiceActivity.js` (`detectSpeechEnd`) and `src/utils/reviewLoop.js` are unchanged, but their only caller today is `anki/tools/build-loop.js`, which bundles them into `anki/media/_amgi-loop.js`, the script the Anki card template in `anki/notetype/` runs.
The loop itself - prompt audio, mic, native audio, self-grade, zero taps beyond the grade - is exactly what shipped before; see `anki/README.md` for how it behaves per Anki client.

### 2.4 Voice mode polish

**Status: no longer applicable.** This was a punch list against `src/contexts/RealtimeContext.js` and `supabase/functions/realtime/index.ts`.
The voice conversation mode's frontend half was already archived to `archives/realtime/` before this roadmap was last touched; its backend half is now archived to `archives/supabase-2026/functions/realtime/`.
If a local-first equivalent is ever rebuilt, that archive's README says what is worth reusing from the OpenAI side of it.

### 2.5 Self-compare playback after AI evaluations

**Status: shipped, but relocated.** The "Prompt / Native / You" replay row this described lived in `ReviewMode.js`, which is gone.
Its equivalent now lives in the Anki card template's answer side (see `anki/README.md`'s "Known deviations from ordinary Anki cards"), on the one client that keeps a page across the reveal.
AI pronunciation checking as a separate opt-in feature did not carry over; the card template does not call an evaluation model today.

---

## Tier 3 - content & sharing

### 3.1 In-app Anki import

**Status: no longer applicable - resolved by the architecture change itself.** This wanted client-side `.apkg` parsing so a learner's existing Anki deck could be copied into amgi's own database.
There is no database to copy it into any more.
Amgi reads and writes the user's real Anki collection directly (see README.md's "Two transports"), so an existing Anki deck is already exactly where amgi looks - there is no import step left to build.

### 3.2 Bulk topic generation

**Status: still open, needs rescoping.** The motivation still holds: generating twenty phrases for a topic in one request is a better experience than typing them in one at a time.
The original design lived entirely in `supabase/functions/cards/index.ts`, which is retired.
The equivalent today would call the generation policy (`plusaudio/lib/cardGeneration/`) for a list of phrases and write the results as new Anki notes, from either the CLI or the app - but no such entry point exists yet, and no implementation plan has been written for it.

### 3.3 Public starter-deck catalog (community decks)

**Status: no longer applicable.** This needed a hosted database and an account system to publish into.
Neither exists.
Sharing an amgi-generated deck today means sharing the `.apkg` file itself, the same way any Anki deck is shared (including via AnkiWeb's own shared-deck listing), which is already outside anything amgi needs to build.

---

## Tier 4 - engineering hardening

### 4.1 Edge-function test harness (pattern from `foolish`)

**Status: no longer applicable.** There are no edge functions left to test this way.

### 4.2 CI

**Status: still open.** This repo has no `.github/workflows/` yet, and the core of the original idea is still exactly right: on every PR, run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm build` and `pnpm test`.
Drop the `deno lint supabase/functions` step (no Deno code is left to lint) and add `node anki/test/harness/drive.js` alongside `pnpm test`, since that check is not part of the `pnpm test` script.

### 4.3 Observability

**Status: no longer applicable.** `wrapRequest`, structured request logging keyed by `userId`, and a `usage_tracking` sanity email all assumed a server with users and requests to log.
There is no server.

### 4.4 Storage privacy

**Status: no longer applicable.** There is no `card-audio` storage bucket and nothing public-read.
Generated media lives in the user's own `collection.media` folder, which was never reachable by anyone else in the first place.

### 4.5 Frontend cleanup

**Status: no longer applicable.** `src/contexts/useAudio.js`, `payment-links/index.ts`, and `src/components/Settings/Subscription.js` are all gone along with the code they would have cleaned up.
The one item worth restating under the new convention: `archives/` is not something to delete once a feature is "confirmed stable" - it is the standing home for retired code, with a README per archive explaining why each piece was retired and what is worth mining, and it grows every time something real gets retired (most recently `archives/supabase-2026/`).

### 4.6 PWA / offline review

**Status: no longer applicable.** This wanted a service worker over the web app's own review UI, which does not exist any more.
Anki's desktop client is already a fully offline-capable reviewer; there is nothing for amgi to add on that front.

---

## Known quota/pricing footnotes (decide, then encode)

**Status: no longer applicable.** There is no free tier, no subscription, and no usage limit to tune - the entire section assumed Supabase-metered quotas that no longer exist.
Generation cost is the user's own OpenAI bill, paid directly to OpenAI with their own key, with no markup and no cap amgi enforces.
