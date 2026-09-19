# Retired plusaudio scripts (2025)

These are the scripts that produced the owner's audio-augmented Korean deck, kept for reference and
removed from `plusaudio/` because they are a second, wrong path to the same job.
They are not wired into anything and are not linted, built or tested.

## Why they were retired

Every one of them rewrites the deck's identity, which is what `plusaudio/` now exists to avoid.

- `update-augmented-deck.js` gave every note a fresh random GUID and a fresh id, every card a fresh
  id, the deck a fresh id and a new name, and every note type a fresh id and a renamed copy.
  Anki matches incoming notes by GUID and note types by id, so the output could only ever be a
  second copy of the deck; it could never update the one the user already studies.
- `fix-review-timestamps.js` shifted every `revlog.id` so the history ended one millisecond before
  the run, falsifying the date of every review the owner had ever done.
  `debug-revlog-mismatch.js` existed to investigate the damage.
- `process-deck.js` was the unified rewrite and could not complete a run as committed:
  `this.state.save()` is called three times on a `ProcessorState` that has no `save`, and four call
  sites pass `(openai, cache, payload)` to a `cachedChatCompletion(payload, options)`.
  It also paid for a translation per term and never wrote the translations into the deck.
- `index.js`, `create-augmented-deck.js`, `update-audio-files.js` and `verify-deck-integrity.js`
  each hard-code one deck's filename.

## What is worth mining before deleting these for good

- `index.js` has audio quality gates that the replacement does not: a syllable-count duration proxy
  (`validateAudioDuration`) and an ffmpeg mean/max volume comparison against the deck's own original
  audio, with a gain boost for quiet clips (`validateAudioVolume`).
- `index.js` has the Korean phonological-equivalence judge, which `plusaudio/lib/tts.js` kept.
- `openai-cache.js` is a sound, vendor-agnostic response cache keyed on a stable hash of the request
  payload. The replacement caches generated clips on disk instead, which covers the expensive case,
  but the request cache is the better tool if the generator starts making cheap text calls too.
- `unique-words.js` holds the English-headword and collision-resolution prompts. The amgi card
  generator in `supabase/functions/_shared/` supersedes them on every axis.
