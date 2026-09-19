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

Judged once the generator moved to `supabase/functions/_shared/cardGeneration.ts`, which is now what
both amgi and `plusaudio/` run.

- `validateAudioDuration` (`index.js`): a syllable-count duration proxy, from the mp3's byte length.
  Not carried.
  It is a size proxy for a duration proxy for a content check, tuned to Korean syllables at one
  bitrate, and the thing it approximates - did the voice say the phrase once, and all of it - is
  exactly what the transcript comparison and the audio judge decide directly.
  Pointed at another language or another TTS model it would reject good clips.
- `validateAudioVolume` (`index.js`): an ffmpeg mean/max volume comparison against the deck's own
  original audio, with a gain boost for quiet clips.
  Not carried, but the problem it solves is real and is specific to this CLI.
  amgi plays clips from one synthesiser, so its levels are already consistent; a deck being augmented
  has the author's own recordings next to freshly generated ones, and those can differ audibly.
  It does not belong in the shared generator either way: it needs an external binary, which an edge
  function cannot have, and a reference baseline, which only a deck can supply.
  If a real level mismatch shows up, the place for it is a post-processing step in `plusaudio/`,
  behind a flag, measured against the deck's existing media.
- `index.js` has the Korean phonological-equivalence judge.
  Superseded: the shared generator escalates any transcript disagreement to a model that listens to
  the clip itself, which settles a Korean sound-change case the same way without being about Korean.
- `openai-cache.js` is a sound, vendor-agnostic response cache keyed on a stable hash of the request
  payload. The replacement caches generated clips on disk instead, which covers the expensive case,
  but the request cache is the better tool if the generator starts making cheap text calls too.
- `unique-words.js` holds the English-headword and collision-resolution prompts. The amgi card
  generator in `supabase/functions/_shared/` supersedes them on every axis.
