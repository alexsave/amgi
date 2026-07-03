# amgi

Flashcards that make you **speak**.

Most flashcard apps (Anki included) train you to read and write; listening and speaking come second, if at all. amgi flips that: every card has native-quality audio on both sides, and the way you answer a card is by **saying it out loud**. Your recording is sent to a speech-capable LLM together with the reference pronunciation, which judges it and talks back — and you stay in control, deciding whether to accept the verdict based on how your voice compared to the expected audio.

## Features

- **Speak-to-answer reviews** — the card's audio plays, you speak your answer, and an AI evaluates the pronunciation (verdict + what it heard + spoken feedback). You stay the final judge: override the verdict if you disagree. Up to 3 attempts with an audio hint.
- **Starter decks** — one-click curated common-phrase decks (Korean, Spanish, Japanese) so you can start reviewing immediately; card audio generates in the background with visible progress.
- **Voice conversation mode** — a live, hands-free review session over WebRTC with OpenAI's realtime model: it reads the card, listens to you, evaluates, and moves through your due cards like a tutor would.
- **AI-generated cards** — type a phrase in either language; the card's translation, language detection, and TTS audio for both sides are generated for you. Generated audio is transcribed and verified before it's accepted.
- **Spaced repetition** — an SM-2 style scheduler (new → learning → review) with per-card state persisted in Supabase.
- **Anki deck import** — the `plusaudio/` CLI tools convert `.apkg` decks (adding generated audio) into importable decks.
- **Subscriptions** — Stripe-backed tiers with per-feature usage limits (voice evaluations, audio generations, realtime sessions) enforced atomically in the database.

## Architecture

- **Frontend**: Create React App (`src/`), deployed on Vercel. Talks to Supabase for auth, data, storage, and edge functions.
- **Backend**: Supabase — Postgres + RLS (`supabase/migrations/`), storage bucket `card-audio`, and Deno edge functions (`supabase/functions/`):
  - `cards` — card text generation/translation (structured outputs) + validated TTS audio.
  - `speech` — pronunciation evaluation: compares your recording against the reference audio and returns a verdict plus spoken feedback.
  - `realtime` — mints short-lived client secrets for the browser's WebRTC session with the realtime model; the API key never leaves the server.
  - `payment-links` / `stripe-webhook` — Stripe checkout and subscription lifecycle.
- **Models** (centralized in `supabase/functions/_shared/openai.ts`): `gpt-audio` for speech evaluation, `gpt-5-mini` for text, `gpt-4o-mini-tts` for card audio, `gpt-4o-mini-transcribe` for audio validation, and `gpt-realtime` for conversation mode.

## Setup

### 1. Supabase

```bash
supabase init      # if starting fresh; this repo already has supabase/
supabase db push   # applies supabase/migrations/
```

Set the edge function secrets:

```bash
supabase secrets set OPENAI_KEY=sk-...
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set APP_URL=https://your-app.example
```

Deploy the functions:

```bash
supabase functions deploy cards speech realtime payment-links stripe-webhook
```

### 2. Frontend

Create `.env.local`:

```bash
REACT_APP_SUPABASE_URL=https://<project-ref>.supabase.co
REACT_APP_SUPABASE_KEY=<anon key>
```

Then:

```bash
npm install
npm start          # dev server on http://localhost:3000
npm test           # jest suite
npm run build      # production build
```

### 3. plusaudio CLI (optional)

Offline tools for converting Anki decks; kept out of the web app's dependency tree.

```bash
cd plusaudio
npm install
node index.js --help   # see plusaudio/README.md
```

Requires an `OPENAI_API_KEY` in `plusaudio/.env` for audio generation.

## Repository layout

```
src/                  React app (contexts, components, scheduler, network layer)
src/data/             Curated starter decks
supabase/functions/   Deno edge functions + _shared helpers
supabase/migrations/  Schema, RLS, and RPCs
plusaudio/            Node CLI for Anki deck conversion
archives/             Old implementations kept for reference (not built)
```

See [ROADMAP.md](./ROADMAP.md) for planned work, with implementation notes per item.
