# amgi

Flashcards that make you **speak**.

Most flashcard apps (Anki included) train you to read and write; listening and speaking come second, if at all.
amgi flips that: every card has native-quality audio on both sides, and the way you answer a card is by **saying it out loud**.
A review session runs hands-free - the prompt plays, the mic opens on its own, and amgi decides you are done when you stop talking.
Then the native recording plays back against yours and you grade yourself, the way you would in Anki.

## Features

- **Hands-free speak-to-answer reviews** - one "Start reviewing" click takes microphone consent and unlocks audio; after that every card runs by itself.
  The card's audio plays, the mic opens, voice-activity detection ends your turn after a pause, and the native audio plays back.
  Replay the prompt, the native audio, or your own recording as often as you like, then grade yourself: Again or Good.
- **AI pronunciation checking (opt-in)** - your recording can be sent to a speech-capable LLM together with the reference pronunciation, which returns a verdict, what it heard, and spoken feedback.
  It is off by default and enabled per device by setting `localStorage.amgi_ai_check = 'true'`.
  Even with it on, the verdict is advice next to the answer: you are still the one who grades the card.
- **Starter decks** - one-click curated common-phrase decks (Korean, Spanish, Japanese) so you can start reviewing immediately; card audio generates in the background with visible progress.
- **Voice conversation mode** - a live, hands-free review session over WebRTC with OpenAI's realtime model: it reads the card, listens to you, evaluates, and moves through your due cards like a tutor would.
  It lives at `/deck/<id>/voice`; nothing in the review UI links to it today, so navigate there by URL.
- **AI-generated cards** - type a phrase in either language; the card's translation, language detection, and TTS audio for both sides are generated for you.
  Generated audio is transcribed and verified before it's accepted.
- **Spaced repetition** - an SM-2 style scheduler (new → learning → review) with per-card state persisted in Supabase.
- **Anki deck import** - the `plusaudio/` CLI tools convert `.apkg` decks (adding generated audio) into importable decks.
- **Subscriptions** - Stripe-backed tiers with per-feature usage limits (voice evaluations, audio generations, realtime sessions) enforced atomically in the database.

### Review keyboard shortcuts

The grading keys are Anki's, so the muscle memory carries over.

| Key | When | Does |
| --- | --- | --- |
| `space` / `enter` | before the session starts | Start reviewing |
| `space` | while the mic is open | Done speaking - end the turn without waiting for the pause |
| `space` / `enter` / `3` | once the answer is showing | Good |
| `1` | once the answer is showing | Again |

## Architecture

- **Frontend**: Next.js App Router on React 19 (`src/`), deployed on Vercel (`vercel.json` pins the framework).
  Routes are files under `src/app/`; the signed-in shell (`src/components/AppShell.js`) holds auth, deck, audio and review state and is mounted client-only, because recording, playback and the Supabase session all live in the browser.
  Talks to Supabase for auth, data, storage, and edge functions.
- **Backend**: Supabase - Postgres + RLS (`supabase/migrations/`), storage bucket `card-audio`, and Deno edge functions (`supabase/functions/`):
  - `cards` - card text generation/translation (structured outputs) + validated TTS audio.
  - `delete-cards` - deletes cards or a whole deck and removes the audio no remaining card references; card audio is uploaded by the service role, so only the server can delete it.
  - `speech` - pronunciation evaluation: compares your recording against the reference audio and returns a verdict plus spoken feedback.
  - `realtime` - mints short-lived client secrets for the browser's WebRTC session with the realtime model; the API key never leaves the server.
  - `payment-links` / `stripe-webhook` - Stripe checkout and subscription lifecycle.
- **Models** (centralized in `supabase/functions/_shared/openai.ts`): `gpt-audio` for speech evaluation, `gpt-5-mini` for text, `gpt-4o-mini-tts` for card audio, `gpt-4o-mini-transcribe` for audio validation, and `gpt-realtime` for conversation mode.

## Setup

### 1. Supabase

```bash
supabase init      # if starting fresh; this repo already has supabase/
supabase db push   # applies supabase/migrations/
```

`db push` applies everything in `supabase/migrations/`, including the `user_preferences` table the settings page reads and writes.
For a local stack, `supabase start` applies the same migrations to Docker Postgres.

Set the edge function secrets:

```bash
supabase secrets set OPENAI_KEY=sk-...
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set APP_URL=https://your-app.example
```

Deploy the functions:

```bash
supabase functions deploy cards delete-cards speech realtime payment-links stripe-webhook
```

### 2. Frontend

Create `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_KEY=<anon key>
```

These are the names the client reads.
Deployments carried over from the Create React App days can keep their `REACT_APP_SUPABASE_URL` / `REACT_APP_SUPABASE_KEY` variables: `next.config.js` falls back to them and exposes the `NEXT_PUBLIC_*` spelling to the browser.
New environments should set the `NEXT_PUBLIC_*` names only.

The package manager is pnpm, pinned in `package.json#packageManager`; `corepack enable` picks up the right version.

```bash
pnpm install
pnpm dev           # dev server on http://localhost:3000
pnpm test          # jest suite
pnpm lint          # eslint (next/core-web-vitals)
pnpm build         # production build
pnpm start         # serve the production build
```

### 3. plusaudio CLI (optional)

Offline tools for converting Anki decks; kept out of the web app's dependency tree.

```bash
cd plusaudio
npm install
node index.js --help   # see plusaudio/README.md
```

Requires an `OPENAI_API_KEY` in `plusaudio/.env` for audio generation.

## Verifying changes

`.claude/skills/e2e-ui/` runs the app locally against a seeded local Supabase and drives it in headless Chrome, including the review loop with a synthetic microphone.
Use it to screenshot a screen as a signed-in user, measure layout, or watch the hands-free flow end to end; the skill has the setup and the scripts.

## Repository layout

```
src/app/              Next.js App Router routes
src/components/       UI, including the client-only signed-in shell
src/contexts/         Auth, decks, audio, review, and realtime state
src/utils/            Card scheduler, dates, voice-activity detection
src/data/             Curated starter decks
public/               Static assets, including vmsg.wasm (the mp3 encoder)
supabase/functions/   Deno edge functions + _shared helpers
supabase/migrations/  Schema, RLS, and RPCs
plusaudio/            Node CLI for Anki deck conversion
archives/             Old implementations kept for reference (not built)
```

See [ROADMAP.md](./ROADMAP.md) for planned work, with implementation notes per item.
