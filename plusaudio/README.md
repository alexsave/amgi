# plusaudio

Adds generated audio to an existing Anki deck, in place, without changing anything else about it.

```bash
node add-audio.js "My Deck.apkg" --out "My Deck (with audio).apkg"
```

The output is the input plus audio.
Same note GUIDs, same note and card ids, same note types, same deck names, byte-identical review log.
Import it into the collection the deck came from and Anki updates those notes' fields in place and
leaves their cards' scheduling and due dates alone.

Run it again and it only generates the audio whose text has changed since last time.

## Why identity matters

Anki's package importer matches notes by GUID and nothing else, updates a matched note only when the
incoming copy is newer, and never touches an existing card's scheduling when it updates a note
([notes.rs][notes], [cards.rs][cards]).
Decks are matched by name and note types by id ([decks.rs][decks]).

So a tool that renumbers notes, cards, decks or note types can only ever produce a second copy of the
deck; and a tool that stamps `mod` on every note overwrites edits the user made themselves.
This one changes a note only when it changes that note's audio field, and stamps `mod` only on the
notes it changed.
It never writes to `revlog`, `cards` or `col`.

[notes]: https://github.com/ankitects/anki/blob/main/rslib/src/import_export/package/apkg/import/notes.rs
[cards]: https://github.com/ankitects/anki/blob/main/rslib/src/import_export/package/apkg/import/cards.rs
[decks]: https://github.com/ankitects/anki/blob/main/rslib/src/import_export/package/apkg/import/decks.rs

## Usage

```
node add-audio.js <deck.apkg> [options]

  --out <path>          output package (default: "<input> (with audio).apkg")
  --text-field <name>   field to read aloud (name or 0-based index)
  --audio-field <name>  field to write the clip reference into (name or index)
  --audio-tag <form>    sound: [sound:clip.mp3] (default, Anki plays it itself)
                        html:  <audio src="clip.mp3"></audio>, which the anki/
                               card template can read and drive
  --language <tag>      language of the text being spoken (default: ko)
  --cache-dir <dir>     clips kept between runs (default: ./plusaudio-audio)
  --limit <n>           generate at most n clips this run
  --dry-run             report what would be generated; write nothing
```

`--dry-run` needs no API key. Generating audio needs `OPENAI_API_KEY`.

`--language` is an amgi language code (`ko`, `ja`, `zh_cn`, `zh_hk`, `es`, ...).
It picks the speaking instructions the voice is given and the language the validator transcribes in,
so a wrong one makes clips that are rejected rather than clips that are quietly wrong.

Fields are resolved per note type. If a note type has no field whose name looks like an audio field,
the tool stops and asks for `--audio-field` rather than guessing and overwriting real content.

## Which reference to write

A note can point at a clip in two ways, and `--audio-tag` picks which one.

`sound` writes `[sound:clip.mp3]`, and it is the default.
It is what works in every Anki client including AnkiWeb, Anki plays it with its own player, and the learner gets Anki's native replay key `R` for free.

`html` writes `<audio src="clip.mp3"></audio>`, which is what the card template in [`../anki/`](../anki/README.md) needs.
Anki strips sound tags out of a card before the template's JavaScript ever sees them ([rslib/src/text.rs][text], `AV_TAGS`), so a template can never learn the filename or notice that playback ended, and the review loop cannot be sequenced.
An `<audio src="...">` element survives into the page, and Anki still counts it as used media ([rslib/src/text.rs][text], `HTML_MEDIA_TAGS`), so Check Media keeps the clip and an export carries it along.
Do not use it without that note type: nothing else plays the element, and Anki's own replay buttons will not appear.

[text]: https://github.com/ankitects/anki/blob/main/rslib/src/text.rs

### Switching a deck from one form to the other

Re-running with the other `--audio-tag` converts the deck.
The generated reference is rewritten in place in the form you asked for, and any further reference to a generated clip in the same field is dropped, so a note never ends up pointing at the same clip twice.
Clip filenames are content hashes of the text, so the clips themselves are untouched: a conversion generates nothing, adds no media and removes none.

Converting does change the field, so those notes get a new `mod` and Anki applies the update on import.
The usual rule therefore applies: convert a fresh export, not a month-old one.
References the tool did not write, such as the deck author's own recordings, are left in whatever form they were in.

## How a re-run stays cheap

A clip's filename is derived from the text it was generated from
(`plusaudio-<hash of profile, language and text>.mp3`).
If the text has not changed, the note already points at exactly the file the tool would produce, so
there is nothing to generate and nothing to write.
If the text has changed, the name changes with it and the stale clip is replaced.
Nothing has to be remembered between runs for this to work, and clips are also kept in `--cache-dir`
so rebuilding a deleted output costs nothing.

References the tool did not write - the deck author's own recordings - are left exactly where they
are, alongside the generated one. Tags written by the retired 2025 scripts (`*_gpt4o.mp3`) are
recognised as the tool's own and replaced rather than duplicated.

## Package formats

| Format | Members | Supported |
| --- | --- | --- |
| Legacy | `collection.anki2`, JSON `media` | yes |
| Legacy 2 | `meta`, `collection.anki21`, `collection.anki2` stub, JSON `media` | yes |
| Modern | `meta`, `collection.anki21b` (zstd), protobuf `media` | no, refused with a message |

Modern packages are refused rather than half-handled.
Export with "Support older Anki versions" ticked.
Only collection schema 11 is supported, which is what both legacy layouts carry.

## Generate from a fresh export

`mod` is set to now on the notes the tool changes, which is what makes Anki apply the update.
If you generate from a month-old export and have edited those same notes in Anki since, the import
will overwrite your edits to them.
Export, generate, import.

## Requirements

Node 24 or later, for `node:sqlite` and for running the shared generator's TypeScript without a
build step. No native builds, and the only runtime dependency is the `openai` SDK, which is loaded
lazily so `--dry-run` and the tests need neither it nor a key.

The `openai` package here and the one the edge function imports are different majors on purpose:
the shared module never imports the SDK, it is handed a client, so each runtime brings its own.

## Tests

```bash
node --test test/        # or: npm test, or pnpm test at the repo root
```

## Verifying against Anki itself

`tools/` holds the harness the design was checked with, against a real 333-note shared deck and
against a fixture exported from Anki with review history.

```bash
# Two runs over the same input, then two more in the other reference form,
# with audio generation stubbed.
node tools/verify-runs.js "My Deck.apkg" /tmp/plusaudio-verify [--audio-tag sound|html]

# Then check the outputs against Anki's own importer (needs: pip install anki).
python tools/verify-with-anki.py "My Deck.apkg" \
  /tmp/plusaudio-verify/run1.apkg /tmp/plusaudio-verify/run2.apkg

# Pass the converted package as the second import to watch a deck switch form
# inside a real collection.
python tools/verify-with-anki.py "My Deck.apkg" \
  /tmp/plusaudio-verify/run1.apkg /tmp/plusaudio-verify/switch1.apkg
```

`verify-with-anki.py` imports each package into a collection seeded from the input deck and runs Anki's own media check after every import.
On the 333-note deck it reports 999 files in the media folder and none of them unused, in both forms.
That is the point of writing `<audio src>` rather than a bare filename: Anki keeps counting the clip as used.

## Speaking practice inside Anki

The audio this adds is what the card template in [`../anki/`](../anki/README.md) plays.
That note type runs amgi's own review loop inside Anki: the prompt plays, the microphone opens by itself where the client allows it, and the answer stays hidden until you have spoken.
Generate for it with `--audio-tag html`; its README covers converting a deck that already has `[sound:...]` tags.

## What this is not

It does not create cards.
It adds audio to notes that already exist, using amgi's own generator:
`lib/generator.js` is a thin adapter over `supabase/functions/_shared/cardGeneration.ts`, the module
the web app's `cards` edge function runs.
So the clips are made with the same models, the same per-language speaking instructions and the same
refusal to keep audio that does not say what the note says.
Writing new notes into a deck is the next step and is not built yet: it needs a source of terms and a
place to put the generated sides, not a different generator.

The scripts that produced the owner's original deck are in `archives/plusaudio-2025/`, with a note on
why they were retired and what is worth mining from them.
