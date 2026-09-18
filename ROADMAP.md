# amgi Roadmap

Concrete, self-contained work items, ordered by how much they matter for the
core promise: *you open the app every day and actually learn to speak*.

Each item states the motivation, the files involved, implementation steps, and
acceptance criteria. Conventions to follow for every item:

- Frontend state lives in contexts (`src/contexts/`), DB access in
  `src/db/supabase.js`, edge-function calls in `src/network/supabaseApi.js`.
- Edge functions use `wrapRequest` from `supabase/functions/_shared/handler.ts`
  (CORS/auth/JSON errors are handled for you — just return an object or throw;
  throw `HttpError(msg, status)` for non-400 statuses).
- New migrations: `supabase/migrations/YYYYMMDDHHMMSS_snake_case.sql`, idempotent
  (`create or replace`, `if not exists`), with a header comment explaining *why*.
- Charge usage quotas via `checkAndIncrementUsage` **after** validating the
  request but **before** calling OpenAI; refund with `refundUsage` if the work
  then fails entirely.
- Run `pnpm test` and `pnpm build` before committing; keep both green.
  (The package manager is pnpm, pinned in `package.json#packageManager`.)
- Model names live in `supabase/functions/_shared/openai.ts` — never hardcode
  a model string anywhere else.

---

## Tier 1 — make it a daily driver

### 1.1 Review statistics, streaks, and a heatmap

**Why:** Habit is everything in SRS. Right now finishing a session gives you
nothing — no count, no streak, no reason to come back tomorrow.

**Schema:** New migration creating a `review_log` table (one row per answer,
distinct from the mutable `reviews` scheduling row):

```sql
create table if not exists review_log (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users on delete cascade not null,
  card_id uuid references cards(id) on delete cascade not null,
  reviewed_at timestamptz not null default now(),
  outcome text not null check (outcome in ('correct', 'incorrect', 'override_correct')),
  attempts int not null default 1,
  mode text not null default 'classic' check (mode in ('classic', 'voice'))
);
alter table review_log enable row level security;
create policy "Users read own review log" on review_log for select using ((select auth.uid()) = user_id);
create policy "Users insert own review log" on review_log for insert with check ((select auth.uid()) = user_id);
create index if not exists review_log_user_time_idx on review_log(user_id, reviewed_at);
```

**Frontend steps:**
1. Add `logReview(cardId, outcome, attempts, mode)` to `src/db/supabase.js`
   (plain insert; fire-and-forget with `.catch(console.error)`).
2. Call it inside `processCardOutcome` in `src/contexts/ReviewContext.js`
   (only when `review.shouldGoToNextCard` is true), and pass the mode by
   adding a `mode` argument threaded from ReviewMode ('classic') and
   RealtimeContext ('voice').
3. New route `/stats` + `src/components/Stats/StatsPage.js`:
   - Query: reviews per day for last 365 days
     (`select reviewed_at::date, count(*) ... group by 1` — do the grouping
     client-side from raw rows to avoid needing an RPC).
   - Render: current streak (consecutive days ending today with ≥1 review),
     reviews today, total reviews, and a GitHub-style heatmap (a CSS grid of
     365 divs colored by count is fine; no charting library needed).
4. Add a nav link in `src/components/Navigation/Navbar.js`.
5. Show "N reviewed today · streak M🔥" on the Review Complete screen in
   `ReviewMode.js`.

**Accept:** finishing a review adds a row; /stats shows non-zero counts;
`pnpm test` green (add a small test for the streak-computing function - put the
pure function in `src/utils/stats.js` so it's testable without the network).

### 1.2 Deck browser that shows ALL cards

**Why:** `loadDecks` in `src/db/supabase.js` only loads the *scheduled* subset
(new cards capped at 40 per deck, plus learning/due). The "edit deck" screen
(`src/components/Card/CardList.js`) therefore silently hides cards — you can't
see, edit, or delete a card that isn't due. This is data-loss-adjacent UX.

**Steps:**
1. Add `loadAllCards(deckId)` to `src/db/supabase.js`: select all cards (id,
   texts, langs, audio paths, position, `reviews(card_state, next_review_date)`)
   for the deck, ordered by position. No limit.
2. In `CardList.js`, on mount (and after card add/delete), call
   `loadAllCards(currentDeckId)` and render from that local list instead of
   `deck.cards`. Keep DeckContext's scheduled subset untouched — it feeds the
   review queue and should stay lean.
3. Show per-card state chips (new/learning/review + next due date) and an
   "audio missing" badge when either audio path is null, with a per-card
   "generate audio" button calling `regenerateCardPart` (same call the
   backfill in `DeckContext.startAudioBackfill` uses) then
   `updateCardAudioPaths`.

**Accept:** a 60-card starter deck shows all 60 cards in the edit view; cards
beyond the 40-new cap are editable; audio badges reflect reality.

### 1.3 Configurable daily new-card limit (actually enforced)

**Why:** `MAX_NEW_CARDS_PER_DAY` exists in `src/constants/constants.js` but is
enforced nowhere. Binge-day burnout is the #1 SRS failure mode: without a cap,
a 50-card starter deck dumps 40 new cards on day one and buries the user in
reviews on day three.

**Steps:**
1. Store the limit per deck: migration adding
   `alter table decks add column if not exists new_cards_per_day int not null default 20;`
2. Surface it in `CreateDeckModal.js` (number input, default 20) and pass it
   through `createNewDeck` → `saveDeck`.
3. Count new-card introductions today: reuse `review_log` from item 1.1
   (`outcome` rows where the card's prior state was 'new' — simplest is to log
   `was_new boolean` in review_log at insert time).
4. In `ReviewContext`'s init effect, after building the scheduler, dequeue
   new cards down to `max(0, new_cards_per_day - introducedToday)` by moving
   the excess out of `newQueue` (just don't push them into the scheduler).
5. Show "daily new cards done" in the counts line in ReviewMode.

**Accept:** with limit 5, only 5 new cards appear today; tomorrow 5 more;
learning/due cards unaffected.

### 1.4 Romanization / reading line for non-Latin scripts

**Why:** A beginner memorizing Korean phrases by ear may not read hangul yet.
The back text is currently the only textual anchor. An optional reading
(revised romanization for ko, romaji for ja, pinyin for zh) removes a wall
without compromising the audio-first design.

**Steps:**
1. Migration: `alter table cards add column if not exists back_reading text;`
2. `supabase/functions/cards/index.ts`: extend `FlashcardSchema` with
   `back_reading: z.string().describe("Romanized reading of back_text; empty string if back_lang uses the Latin alphabet")`,
   and mention it in `CARD_GENERATION_SYSTEM_PROMPT`. Return it in the
   response object. (Structured outputs require every field present — use
   empty string, not null, for Latin-script languages.)
3. Thread it through `src/network/supabaseApi.js` (`cardData.back_reading`),
   `saveCard`/`saveCards` in `src/db/supabase.js`, and the card queries in
   `loadNewCards`/`loadLearningCards`/`loadDueCards`.
4. For starter decks: add `back_reading` to each card in
   `src/data/starterDecks.js` (write them by hand — they're fixed strings).
5. Display: in `ReviewMode.js`, under the back text, render
   `<div className="flashcard-reading">{currentCard.back_reading}</div>` when
   present, but ONLY at the same visibility stage as the back text
   (the `answer` phase, i.e. `phase === PHASE.ANSWER`).
   Add a per-user toggle later; always-on is fine first.

**Accept:** generating an en→ko card returns a reading; review shows it with
the answer; Latin-language cards show nothing.

### 1.5 TTS audio dedupe / cache

**Why:** Every card generation synthesizes audio even if the exact same text
was synthesized before (common across users for starter decks and common
phrases — "안녕하세요" gets generated for every Korean learner). This is the
single biggest recurring OpenAI cost.

**Steps (server only, no client change):**
1. In `supabase/functions/cards/index.ts` `processCardAudio`: before
   generating, compute a deterministic storage key
   `shared/${lang}/${sha256(normalizedText + TTS_MODEL + voice)}.mp3`
   (WebCrypto: `crypto.subtle.digest('SHA-256', ...)`, hex-encode).
2. Try `supabaseAdmin.storage.from('card-audio').download(key)` (or
   `.list()` on the prefix); if it exists, return the key immediately —
   **skip generation AND skip the usage charge for that side** (move the
   `checkAndIncrementUsage` call to after cache probing, or refund the
   cached sides).
3. If not, run the existing validateAndGenerateAudio and upload to the shared
   key instead of the per-card timestamped name.
4. IMPORTANT: shared files must never be deleted by card edits — in
   `processCardAudio`, only delete `oldAudioPath` when it does NOT start with
   `shared/`.

**Accept:** creating the same card twice hits storage the second time (log
line "tts cache hit"), and the second creation doesn't decrement audio quota
for cached sides.

---

## Tier 2 — learning quality

### 2.1 Upgrade the scheduler to FSRS

**Why:** The current algorithm is a simplified SM-2 with a fixed 10-minute
learning step and binary grading. FSRS (open algorithm, used by modern Anki)
retains measurably better with fewer reviews.

**Steps:**
1. `pnpm add ts-fsrs` (pure JS, no native deps).
2. Migration: `alter table reviews add column if not exists stability real, add column if not exists difficulty real;`
3. New `src/algorithms/fsrs.js` wrapping ts-fsrs: map outcomes to FSRS grades
   - self-graded Again→Again, correct with attempts>0 (voice mode's retries)→Hard,
   correct first try→Good. Persist `stability`/`difficulty` alongside the
   existing fields (keep `interval_days`/`ease_factor` written for backward
   compat).
4. Feature-flag it: `const USE_FSRS = true` in `src/constants/constants.js`;
   `processCardReview` picks the algorithm. Keep the old path and its tests.
5. Port the test style of `src/__tests__/algorithms/spacedRepetition.test.js`
   to a new `fsrs.test.js` (fake timers, fixed NOW, assert state transitions
   and monotonic interval growth).

**Accept:** all old tests still pass; new tests pass; a card graded Good three
times gets intervals that grow (1d → ~3d → ~8d ballpark).

### 2.2 Listening-comprehension cards (reverse direction)

**Why:** Currently every review is "read/hear known language → speak target".
The complementary skill — hear target, prove you understood — is untrained.

**Steps:**
1. Add `direction` to reviews: migration
   `alter table reviews add column if not exists direction text not null default 'produce' check (direction in ('produce','comprehend'));`
   and extend the `unique(card_id, user_id)` constraint to
   `unique(card_id, user_id, direction)` (drop + re-add the constraint).
2. `newReview` in `src/db/supabase.js`: create BOTH rows per card
   (produce + comprehend). The deck queries must select `direction` and the
   ReviewContext scheduler key becomes `${card.id}:${direction}` (touch
   `CardScheduler` usage in `ReviewContext.js` — the scheduler itself is
   id-agnostic, so pass the composite key as the id and keep a map back to
   card + direction).
3. In `ReviewMode.js`, when `direction === 'comprehend'`: autoplay the BACK
   audio as the prompt, and evaluate the user's spoken answer against the
   FRONT text/audio (swap the arguments to `evaluateSpeech`; the edge function
   is already direction-agnostic — it just compares against `expected_text`).
4. Label the mode in the UI ("Say what this means" vs "Say this in Korean").

**Accept:** each card appears in both directions with independent scheduling;
comprehend cards play target audio first and accept a known-language answer.

### 2.3 Hands-free classic review (auto-record with silence detection)

**Status: shipped**, and not as a toggle - it is the only review flow now.
`src/utils/voiceActivity.js` (`detectSpeechEnd`) calibrates the noise floor, waits for speech, and ends the turn after 1.2s of silence, bounded by a no-speech timeout and a max utterance length.
`ReviewMode.js` drives the per-card loop (prompt audio → mic → native audio → self-grade) off it.
A full card needs zero taps beyond the grade, and one "Start reviewing" click per session for mic consent and autoplay unlock.

### 2.4 Voice mode polish

Smaller items, all in `src/contexts/RealtimeContext.js` /
`supabase/functions/realtime/index.ts`:

- **Per-card re-instruction:** today the model learns about subsequent cards
  only from function-call outputs. After each `sendNextCardInfo`, also send a
  `session.update` refreshing `instructions` with the new card (reuse
  `configureSession`'s template logic — extract a `buildInstructions(card, ...)`
  helper in `src/realtime/sessionTools.js` so both paths share it).
- **Voice picker:** pass `voice` through the realtime edge function body
  (whitelist: marin, cedar, alloy, shimmer) and expose a dropdown in Settings.
- **Language coverage:** `INITIAL_PROMPTS` in `src/realtime/initialPrompts.js`
  only has en/ko/zh_cn. Add the remaining languages in
  `src/constants/languages.js` (translate the en template; keep placeholders
  identical).
- **Session cap awareness:** show remaining realtime sessions (from
  usage/subscription, already queried in `src/components/Settings/Subscription.js`)
  in `VoiceMode.js`'s own header - the review screen no longer links to voice
  mode, so there is no button left to hang it off.

### 2.5 Self-compare playback after AI evaluations

**Status: shipped.** The answer phase always offers the "Prompt / Native / You" replay row, whether or not an AI verdict is showing, and the recording is stored in `ReviewMode.js` (`storeUserRecording`).
Self-grading is the single path, so there is no mode toggle to default by plan: AI checking is opt-in per device (`localStorage.amgi_ai_check`) and off unless the reviewer turns it on, which is what the tier-aware default was for.

---

## Tier 3 — content & sharing

### 3.1 In-app Anki import

**Why:** `plusaudio/` already converts `.apkg` (SQLite + media) but only as a
local Node CLI. Learners have existing Anki decks; meeting them where they are
is the cheapest growth lever.

**Steps:**
1. Client-side parse: `.apkg` is a zip — use `fflate` (small, browser-friendly;
   add to package.json) to unzip in the browser, and `sql.js` (wasm SQLite) to
   read the `col`/`notes`/`cards` tables. Port the field-extraction logic from
   `plusaudio/process-deck.js` (front/back = first two fields; strip HTML with
   a DOMParser).
2. Preview screen: show parsed rows in a table with checkboxes; user picks
   known/learning languages (defaults from deck creation modal).
3. Create via existing bulk path: `createNewDeck` + `addCardToDeck(deckId,
   cards)` (text only), then `startAudioBackfill(deckId)` — identical flow to
   starter decks, so no new backend work. Ignore Anki's scheduling state
   (fresh SRS start) in v1; Anki media/audio is also ignored (we generate our
   own validated TTS).
4. Mount at `/import` and link from the DeckList import button (keep the
   existing `.bin` msgpack import as a second option).

**Accept:** a real .apkg (e.g. a 500-card shared Korean deck) imports as text,
audio backfills in the background, review works as audio lands. Cap import at
~500 cards per run with a friendly message (quota reality).

### 3.2 Bulk topic generation

**Why:** "Give me 20 phrases for ordering food" is how people actually want to
extend a deck — one at a time is data entry.

**Steps:**
1. `supabase/functions/cards/index.ts`: new request shape
   `{ topic, count (max 25), known_language, learning_language, existing_phrases: string[] }`.
   Handler branch: single `parseCompletion` call with
   `z.object({ cards: z.array(FlashcardSchema).max(25) })`, prompt instructing
   variety, the target CEFR-ish level, and avoidance of `existing_phrases`
   (send the deck's current back_texts so it doesn't duplicate).
   Text generation is cheap — charge no audio quota here; audio comes from the
   backfill path afterwards.
2. Frontend: "Generate from topic…" in the deck edit screen → modal (topic +
   count) → shows the generated list with checkboxes → selected cards go
   through `addCardToDeck` + `startAudioBackfill` (existing plumbing).

**Accept:** topic → 20 sensible non-duplicate cards → audio arrives in
background; unchecked suggestions are discarded without cost beyond the one
text call.

### 3.3 Public starter-deck catalog (community decks)

Bigger; do after 3.1/3.2. Tables `shared_decks` / `shared_cards` with
public-read RLS, a "publish deck" action (strips user data, snapshots cards),
and a browse tab in StarterDeckModal fetching from those tables instead of the
static `src/data/starterDecks.js`. Audio: publish the (deduped, item 1.5)
shared audio paths so installers don't re-generate. Needs moderation
consideration before opening to strangers — fine to ship behind
"only I can publish" first.

---

## Tier 4 — engineering hardening

### 4.1 Edge-function test harness (pattern from `foolish`)

Copy the approach in `foolish/e2e/adapters/supabase.ts`: a minimal `pg`-backed
fake of the supabase-js surface the functions use (`from().select().eq().single()`,
`rpc()`, `storage.download/upload`), so `_shared/billing.ts` (including the
`check_and_increment_usage` RPC against a real Postgres running the real
migration SQL) and each handler's validation/quota logic run unmodified under
`node --test`. Mock only OpenAI (record/replay JSON fixtures). Priority tests:
billing atomicity under `Promise.all` of 10 concurrent increments; speech
function's quota-after-audio-load ordering; cards refund-on-failure.

### 4.2 CI

`.github/workflows/validate.yml` (mirror foolish's): on PR —
`pnpm install --frozen-lockfile && pnpm lint && pnpm build && pnpm test`,
plus `deno lint supabase/functions`. Add a `postgres:16` service and run 4.1's
tests once they exist.

### 4.3 Observability

- `wrapRequest` (`_shared/handler.ts`): classify unexpected errors as 500
  (keep explicit `HttpError` statuses; validation errors thrown by handlers
  should become `HttpError(msg, 400)` — sweep the three AI functions).
- Log a single structured line per request:
  `{ reqId, fn, userId, status, ms, openaiMs }`.
- Alert path: Supabase log drains or a weekly `select count(*) from usage_tracking` sanity email — anything is better than nothing.

### 4.4 Storage privacy

The `card-audio` bucket is public-read with filenames as the only secret.
Move to per-user prefixes (`${userId}/...`) + RLS storage policies scoped to
`(select auth.uid())::text = (storage.foldername(name))[1]`, and serve via
`createSignedUrl` in `downloadCardAudio` (`src/db/supabase.js`). Keep
`shared/` (item 1.5) public. Requires a one-off migration script moving
existing objects — write it in `plusaudio/` style as a Node script.

### 4.5 Frontend cleanup

- Refactor `src/contexts/useAudio.js`: the Safari triple-play workarounds
  predate the current buffer-decode path; extract a `playViaBufferSource`
  used for ALL browsers (it already works on Safari, and Chrome handles it
  fine), delete the double/triple-play branches, and re-test on Safari. This
  also clears most remaining `exhaustive-deps` warnings.
- Convert `payment-links/index.ts` to `wrapRequest` + `HttpError`.
- `src/components/Settings/Subscription.js` reads
  `subscription?.subscription_tiers` (plural) — verify against the actual
  query shape (`subscription_tier` elsewhere); fix or the usage bars never
  render.
- Delete `archives/` once voice mode is confirmed stable in production (git
  history keeps it).

### 4.6 PWA / offline review

Cache the app shell (a service worker over the Next.js build output), cache card audio in the Cache API on
first play (`useAudio.playAudio` already funnels every fetch through
`downloadCardAudio` — add a cache layer there), queue `saveReview` writes in
IndexedDB with replay-on-reconnect. Speech evaluation stays online-only —
when `navigator.onLine` is false, skip the AI check (already opt-in) and let
the reviewer grade themselves, which is what the Again/Good buttons already do.

---

## Known quota/pricing footnotes (decide, then encode)

- Free tier (migration `20240323_reset.sql`): 100 voice evaluations / 100
  audio generations / 5 realtime sessions per month. A 50-card starter deck
  costs exactly 100 audio generations — a free user who installs one starter
  deck can't create any more cards that month. Either bump the free audio
  limit to ~150, or exempt `shared/` cache hits (item 1.5) from the charge —
  the cache makes starter decks nearly free anyway.
- Voice evaluations at 100/month ≈ 3–4 serious days of AI checking. Because AI
  checking is opt-in per device and off by default, free users can practice
  indefinitely at zero marginal cost - AI evaluations become the upgrade
  reason, not the entry ticket.
