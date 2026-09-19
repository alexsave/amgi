# Retired Supabase backend (2026)

This is the hosted backend amgi ran before the replatform to a local-first Anki tool: auth, Postgres, storage, edge functions and Stripe billing, all behind a `supabase/` directory at the repo root.
It is kept here for reference and removed from the top level because none of it runs any more.
It is not linted, built, tested or deployed from this checkout, and the hosted Supabase project it once pointed at (`gcdjmhziyfwsnaloxulp`) still exists but is out of scope for this repo now - archiving these files does not touch it.

## Why it was retired

amgi no longer has a server to be a backend for.
Reviewing happens inside Anki itself, via the card template this repo ships.
Card generation runs on the user's own machine with the user's own OpenAI key.
The React UI reads and writes the user's real Anki collection directly, or through a local HTTP bridge in the Anki add-on when Anki has the collection open.
There is no login, no per-user database, no storage bucket and no subscription to meter, so every file here lost its reason to exist in one move:

- `config.toml` configured the local Supabase CLI (ports, auth settings, storage buckets).
  Nothing runs `supabase start` any more.
- `migrations/` created and evolved the Postgres schema: `decks`, `cards`, `reviews`, `user_preferences`, `usage_tracking`, `subscription_tiers`, plus the spaced-repetition scheduler state (`learning_step`, lapse counts) and the `card-audio` storage bucket's garbage collection.
  Anki's own scheduler and its own collection file now do all of this, so there is no schema left to migrate.
- `functions/cards/` and `functions/speech/` were the authenticated, quota-metered HTTP wrappers around card generation and pronunciation evaluation.
  The generation policy they called into has moved to `plusaudio/lib/cardGeneration/` (see below) - the wrapper around it, which is what is actually retired here, was the auth check, the quota charge/refund and the upload to storage.
- `functions/delete-cards/` deleted card rows and garbage-collected their audio objects from storage.
  There is no storage bucket and no card row separate from the note in Anki's own collection, so there is nothing left for this to do.
- `functions/realtime/` minted short-lived OpenAI Realtime client secrets for the browser-based voice conversation mode.
  The frontend half of that feature was already retired to `archives/realtime/`; this was its other half.
- `functions/payment-links/` and `functions/stripe-webhook/` were Stripe checkout and subscription lifecycle handling.
  There is no subscription any more - generation cost is the user's own OpenAI bill, paid directly to OpenAI.
- `functions/_shared/auth.ts`, `billing.ts`, `cardDeletion.ts`, `cors.ts`, `handler.ts`, `openai.ts`, `supabase.ts` and `package.json` are the plumbing the functions above shared: JWT verification, quota bookkeeping, CORS, the Deno-flavoured OpenAI client wrapper, and the Supabase service-role client.
  None of it has a caller left once the functions themselves are gone.

## What moved out before this was archived, and is not here

`functions/_shared/cardGeneration.ts`, `cardPrompts.ts`, `cardText.ts` and `models.ts` were not retired - they are the whole card generation policy (prompts, TTS voice instructions, the transcribe-then-judge validation loop that refuses a clip that does not say what the card says), and `plusaudio/lib/generator.js` and `plusaudio/generate-clip.js` still import them to build every clip amgi generates, from the CLI, from the app's own local generation path, and from the Anki add-on's bridge.
Moving them into `supabase/functions/_shared/`'s archive would have archived live code.
They now live at `plusaudio/lib/cardGeneration/`, inside the one package that still imports them, with every importer (`plusaudio/lib/generator.js`, `plusaudio/test/generator.test.js`) and every comment that named their old path updated to match.
They were already free of Deno APIs and of npm:/jsr: imports before the move - that was deliberate even while a Deno edge function was still one of their two runtimes, precisely so this move would one day be this cheap.

## What is worth mining before deleting these for good

- `_shared/handler.ts`'s `wrapRequest` is a clean small pattern (authenticate, parse body, catch `HttpError` into the right status, always attach CORS headers) if amgi ever grows a server again.
  Not urgent: nothing in the current design needs one.
- `migrations/20260918130000_scheduler_state_and_review_log.sql` and `20260918140000_reviews_timestamptz.sql` document two real bugs (a scheduler that could not persist its own state across lapses, and a timezone-naive timestamp that shifted every due date by the reader's UTC offset) and how they were fixed.
  If a future local scheduler is ever built outside Anki's own, both fixes are worth re-deriving from first principles rather than reintroducing the bugs that made them necessary the first time.
- `functions/realtime/index.ts` is a complete, working example of minting a short-lived OpenAI Realtime client secret server-side so a browser can open a WebRTC session without seeing the real API key.
  If a local-first equivalent of the voice conversation mode is ever rebuilt (a local Node process minting the secret instead of an edge function), this is the reference for the OpenAI side of that call; `archives/realtime/` has the browser side.
- Nothing in `payment-links/` or `stripe-webhook/` is worth carrying forward: billing model and auth model are both gone, and Stripe integration code is easy to write again from Stripe's own current docs when there is a product decision to reattach it to.
