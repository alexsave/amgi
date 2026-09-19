# amgi: fill missing audio

Adds audio straight into your live Anki collection.
No exporting a `.apkg`, running a script, and importing the result back.
Pick a deck, tell it which field to read and which field to write the clip into, and it fills in whatever is missing.

This is a separate add-on from `../amgi_mic/`, installed on its own.
The two do unrelated jobs with unrelated risk: `amgi_mic` is passive infrastructure that answers one Qt permission request and touches no collection data.
This add-on has a menu item, makes network calls, and edits notes.
Bundling them would mean a user who only wants the microphone permission - the common case on a machine without an amgi account - installing something that phones home, and a user who only wants their audio filled in installing something that asks for their microphone.
`amgi_mic`'s own README promises it is short enough to read in full.
Folding a network-calling batch tool into it would break that promise for no reason, since Anki add-ons are already the unit both `Tools > Add-ons` and AnkiWeb manage independently.

## What it does

1. Tools > amgi: Fill missing audio... opens a dialog.
2. Pick a deck, which field to read aloud, which field to write the clip into, the language, and which reference form to write (see below).
3. It finds every note in that deck (subdecks included) missing this tool's own audio for its current text, generates it, and writes it in.

That's it.
It does not create notes, does not touch any field but the one you pointed it at, and does not touch scheduling, `revlog`, note types or decks.

## What it does not touch

- Any field except the one you name as the audio field.
- A reference in that field it did not write itself - the deck author's own recording, someone else's `[sound:...]` tag, an `<img>` in the same field - is left exactly where it is.
  Only this tool's own generated clip is ever added, replaced or removed.
- A note whose text has not changed since this tool last filled it in.
  Clip filenames are content hashes of the text (see "Idempotency" below), so a note already carrying the right one is skipped, not touched.
- Anything outside the deck you picked.

## Install

This add-on generates audio on your own machine, with your own OpenAI key.
There is no amgi account, no hosted service, and no quota but your own OpenAI account's - see
"Generation: local, not the edge function" below for why, and for what this used to depend on that
it no longer does.

That does mean it needs a few things a purely-installed add-on would not:

- **Node.js**, to run the same generator `plusaudio/` uses.
  This is a real install step, not a nicety: if you do not already have Node, get it from
  [nodejs.org](https://nodejs.org) first.
- **A checkout of [this repo](https://github.com/alexsave/amgi)**, so `plusaudio/generate-clip.js`
  and the shared generation policy it runs exist on disk somewhere.
- **An OpenAI API key**, in the environment, in `plusaudio/.env`, or pasted into this add-on's own
  config (see below).

1. Copy the `amgi_audio` folder into your Anki add-ons folder (Tools > Add-ons > View Files puts you in the right place), then restart Anki.
2. Tools > Add-ons, select amgi_audio, click Config, and set `plusaudio_dir` to the `plusaudio` folder of your checkout.
   Set `node_path` too if `node` is not on the `PATH` Anki itself runs with, and `openai_api_key` if you are not already setting `OPENAI_API_KEY` some other way.
   See `config.md` (shown next to the config editor) for all three, in the order they are checked.
3. Tools > amgi: Fill missing audio...

If any of the above is missing or misconfigured, this add-on says so before a run starts - a message
naming what to fix, not a stack trace partway through your deck.

## Field mapping

You choose two fields per run, by name:

- **Read this field aloud** - the field holding the text to speak.
  HTML markup and any existing `[sound:...]`/`<audio>` tag in it are stripped before it is sent for generation.
- **Write the clip into** - the field the generated clip is added to.

They must be different fields.
If your deck mixes note types, the dialog offers every field name used by any of them; a note whose type lacks one of the two chosen names is skipped, not guessed at or overwritten.

## Which reference to write

Same choice, and the same two forms, as `plusaudio`'s `--audio-tag` (see [`../../plusaudio/README.md`](../../plusaudio/README.md), "Which reference to write"):

- `sound` (default) - `[sound:clip.mp3]`.
  Works everywhere, Anki plays it with its own player, `R` replays it.
- `html` - `<audio src="clip.mp3"></audio>`.
  What the review-loop note type in [`../../notetype/`](../notetype/README.md) needs to sequence its own playback; Anki strips a bare `[sound:]` tag out of the page before the template's JavaScript ever sees it.

Re-running with the other form converts a note without regenerating its audio: the clip is a content hash of the text, so only the reference changes.

## Relation to `plusaudio/`

Same generation policy, same clip-naming scheme, two different situations:

- **`plusaudio/`** edits a `.apkg` file.
  Use it for a deck you are going to share, or one you cannot open directly - someone else's deck, or a shared collection you do not have Anki open against right now.
  You export, run it, and import the result back.
- **This add-on** edits your own open collection directly, through Anki itself.
  Use it for your own live deck, when you have Anki open.
  No export, no import, and Anki's own GUID matching, scheduling and undo history are never in question because Anki is the one doing the writing.

They stay interchangeable on the same deck: `plusaudio` and this add-on name a clip the same way (`plusaudio-<hash of profile, language, text>.mp3`, from `plusaudio/lib/audio-store.js`, ported for Python in `deck_text.py`), so a deck touched by one and then the other treats the other's clips as already done rather than regenerating them.

## Idempotency and cancellation

A clip's filename is a hash of the generation profile, the language, and the exact text.
If the text has not changed since this tool last filled it in, the note already points at the file this run would produce, so plan_fill (`core.py`) leaves it alone.
Running the whole thing twice in a row does nothing the second time; this is checked in `test/test_core_collection.py` against a real collection.

A note's field is only changed after its clip has already been generated and written into the collection's media folder.
The collection's database itself is not touched until the very end of a run, in a single write covering every note finished so far.
See `core.apply_fill`'s docstring for why, and `test_core_collection.py`'s cancellation test for what a cancelled run leaves behind: the notes done so far, committed; the rest, simply not started yet, and picked back up the same way on the next run.

## Generation: local, not the edge function

The generation policy - prompts, the TTS voice instructions, the transcribe-then-judge validation loop - lives in exactly one place, `supabase/functions/_shared/cardGeneration.ts`, and this add-on does not get a second copy of it in Python.
It is Python, so it cannot `require()` that TypeScript module the way `plusaudio/lib/generator.js` does.
Instead `generator.py` shells out to `plusaudio/generate-clip.js`, a small Node entry point built for exactly this - text and a language in, one clip written to a file, over a documented contract (see that file's own top-of-file comment) - which in turn calls the same shared generator `plusaudio/add-audio.js` uses.

That contract is the seam `core.apply_fill` depends on: it takes any `fetch_audio(text) -> bytes` callable (see `generator.AudioGenerator`), so it has no idea, and does not need one, that the other end is a subprocess.

This add-on used to call a deployed `cards` edge function over HTTPS instead, signed in with an amgi account's email and password stored in this add-on's own config.
That is gone.
Generating locally, against your own OpenAI key, removes a real liability - an amgi account's password sitting in plaintext in an Anki add-on's config file - and removes the amgi account, the hosted quota, and the network dependency on Supabase entirely.
The only network call this add-on makes now is the one `plusaudio/generate-clip.js` makes to OpenAI, from your own machine, with your own key.

The tradeoff is Node and a repo checkout become real requirements, not optional ones - see "Install" above.
That was the whole reason the edge-function version existed in the first place: everyone who could already use the amgi web app had what it needed and nothing else.
That reasoning no longer applies now that reaching into a live collection with no amgi account at all is the point.

## Testing

### What is actually verified

`test/test_deck_text.py`, `test/test_core_config.py` and `test/test_generator.py` need no `anki` pip package and no network.
`pnpm test` runs them.

- `test_deck_text.py` checks `deck_text.py` against `plusaudio/lib/deck.js` and `audio-store.js` themselves, by shelling out to Node on the same inputs and asserting equality - not against a second, hand-written idea of what those functions do.
- `test_generator.py` checks the subprocess seam - the command built, the environment passed through, exit-code and stderr handling, temp-file cleanup, and the actionable errors for a missing Node, a missing repo checkout, and a missing API key - by mocking `subprocess.run`.
  There is no OpenAI API key available to these tests, and live calls are not authorised; mocking at the transport boundary is what "keep the seam narrow enough to mock" (see the top of `generator.py`) means in practice.
  `../../plusaudio/test/generate-clip.test.js` checks the other side of the same contract from Node, with a stubbed generator - also never a real OpenAI client.
- `test_core_config.py` checks `AudioFillConfig`'s own validation.

`test/test_core_collection.py` runs `core.plan_fill`/`core.apply_fill` against a REAL `anki.collection.Collection`: real notes, real `Note.__setitem__`, real `col.media.add_file`/`write_data`/`check()`.
It proves: a note gets its clip and reference written and nothing else in the field disturbed; `col.media.check()` reports the clip used and nothing missing; a second run changes nothing; editing the text regenerates and leaves exactly one owned reference; switching `--audio-tag` converts without regenerating; a note missing the mapped field is skipped, not crashed on; a failed generation is retried on the next run rather than losing the note; and a cancelled run commits the notes finished so far and leaves the rest for next time.
One class of that file runs against a hand-built fixture.
Another (`SampleDeckTests`, gated on the `AMGI_SAMPLE_APKG` environment variable) runs the same checks against a real 333-note shared deck with the deck author's own `[sound:]` tags and `<img>` tags already in the audio field, confirming those are left alone.

This is **not** wired into `pnpm test`: the `anki` pip package is a large, Rust-backed wheel this repo does not otherwise depend on, and `pnpm test` has to pass on a plain checkout with no Python environment at all.
Run it with a Python that has `anki` installed:

```bash
python -m venv anki-test-env
anki-test-env/bin/pip install anki
cd anki/addon/amgi_audio   # see "A namespace collision worth knowing about" below - the cd matters
AMGI_SAMPLE_APKG=/path/to/a/real.apkg anki-test-env/bin/python -m unittest discover -s test -p "test_core_collection.py" -v
```

### A namespace collision worth knowing about

The real `anki` pip package ships with no `__init__.py` at its top level - it is an implicit [namespace package](https://peps.python.org/pep-0420/) - and so is this repo's own top-level `anki/` directory, which holds this add-on, the review-loop note type, and their own JS/CSS assets, and has nothing to do with the pip package.
If both end up on `sys.path` at once and the *repo root* is also on `sys.path` (which happens by default for a plain `python -c`, `python -m module`, or `python script.py` run with the repo root as the working directory), Python merges the two into one `anki` namespace: `import anki` then resolves against both directories at once.

For any name the pip package actually defines (`anki.media`, `anki.collection`, ...), the real module wins - that part of PEP 420 favours a genuine module over a bare namespace directory - so this has not caused a wrong answer here.
But it is fragile: it would only take a stray top-level `anki/<name>.py` appearing in this repo, sharing a name the pip package uses, to have the repo's own file silently shadow the real one for anyone who happens to also have `anki` installed and runs Python from the repo root.

Every test file under `test/` avoids the whole question by adding this add-on's own directory to `sys.path` and importing its modules directly (`import core`, `import deck_text`, `import generator`) rather than through any `anki.*` path - the same way Anki's own add-on loader imports them, which never goes through a path named `anki` at all (an installed add-on is `amgi_audio`, full stop; see manifest.json's `package` key).
Running `python -m unittest` from this directory, as the commands above do, keeps the repo root off `sys.path` in the first place.

## What is unverified

`__init__.py` and `dialogs.py` import `aqt`, which needs a working Qt installation this environment does not have (only the pure `anki` package could be installed here, not `aqt`).
Everything in them is written to the operations API modern Anki add-ons use (`aqt.operations.CollectionOp`, `.with_progress()`, `mw.progress.want_cancel()`, `mw.taskman.run_on_main()`), but none of it has run inside real Anki.
To check it:

1. **The menu item and dialog appear and populate correctly.**
   Install the add-on, open a profile with at least one deck of notes, and confirm Tools > amgi: Fill missing audio... opens, the deck combo lists your decks, and picking a deck fills the two field combos with that deck's note types' field names.

2. **The run actually happens as one undoable step.**
   Run it on a small test deck, confirm the notes are updated, then Edit > Undo once and confirm every note the run touched reverts together, not one at a time.

3. **Progress and cancellation.**
   Run it on a deck large enough to take a few seconds, confirm the progress dialog shows a note's text and a moving count, and that clicking its cancel button stops the run, leaves the notes done so far updated, and that running it again finishes the rest without redoing them.

4. **The `CollectionOp` / `QueryOp` API shape itself.**
   This was written against the operations API's documented shape as of Anki 2.1.45+, but its exact keyword arguments (`.with_progress(label=...)` in particular) have not been checked against the installed Anki version's `aqt/operations/__init__.py`.
   If the dialog or the run raises a `TypeError` about an unexpected keyword, that file is the first place to look.

5. **`generate-clip.js` against a real OpenAI key.**
   `test_generator.py` proves the command this add-on builds and the way it handles the result are correct; `generate-clip.test.js` proves the Node side of the same contract. Neither proves a real OpenAI account accepts the request, because there is no API key available to test against here.
   To check: set `OPENAI_API_KEY` (or `plusaudio/.env`), configure `plusaudio_dir` in this add-on, run it on a small test deck, and confirm a clip comes back and plays.

## What v2 would need

Adding new notes, not just filling in audio for ones that exist.
Given this add-on already has a live `Collection`, most of what made that hard before is gone:

- **Anki does the writing.** `col.new_note(notetype)` / `col.add_note(note, deck_id)` are the same shape `apply_fill` already uses for `update_note` - no GUID minting, no card creation math (Anki creates a note's cards itself from its note type's templates), no revlog to leave alone because there is none yet for a new card.
- **What is actually new work**: a source of terms (the missing piece `plusaudio/README.md`'s own "What this is not" section already names - "it needs a source of terms... not a different generator"), and a new Node entry point alongside `generate-clip.js` for `cardGeneration.ts`'s text-generation path (`generateCardText`, not just `generateCardAudio`), since writing a new note needs both sides' text, not just a clip for text that already exists.
- **The dialog** would grow an input for what to generate cards *about*, or a way to point at a word list, in place of - or alongside - the deck+field picker this version has.
- **Duplicate handling** the CLI tools never had to consider: Anki's own `col.find_dupes` / note-duplicate detection is not currently called anywhere in `core.py`, and a v2 that creates notes should use it before adding one, since nothing here currently stops the same term being generated twice into the same deck.
