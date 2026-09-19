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
  --audio-field <name>  field to write the [sound:] tag into (name or index)
  --language <tag>      language of the text being spoken (default: ko)
  --cache-dir <dir>     clips kept between runs (default: ./plusaudio-audio)
  --limit <n>           generate at most n clips this run
  --dry-run             report what would be generated; write nothing
```

`--dry-run` needs no API key. Generating audio needs `OPENAI_API_KEY`.

Fields are resolved per note type. If a note type has no field whose name looks like an audio field,
the tool stops and asks for `--audio-field` rather than guessing and overwriting real content.

## How a re-run stays cheap

A clip's filename is derived from the text it was generated from
(`plusaudio-<hash of profile, language and text>.mp3`).
If the text has not changed, the note already points at exactly the file the tool would produce, so
there is nothing to generate and nothing to write.
If the text has changed, the name changes with it and the stale clip is replaced.
Nothing has to be remembered between runs for this to work, and clips are also kept in `--cache-dir`
so rebuilding a deleted output costs nothing.

Sound tags the tool did not write - the deck author's own recordings - are left exactly where they
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

Node 24 or later, for `node:sqlite`. No native builds, and the only runtime dependency is the
`openai` SDK, which is loaded lazily so `--dry-run` and the tests need neither it nor a key.

## Tests

```bash
node --test test/        # or: npm test, or pnpm test at the repo root
```

## Verifying against Anki itself

`tools/` holds the harness the design was checked with, against a real 333-note shared deck and
against a fixture exported from Anki with review history.

```bash
# Two runs over the same input, with audio generation stubbed.
node tools/verify-runs.js "My Deck.apkg" /tmp/plusaudio-verify

# Then check the outputs against Anki's own importer (needs: pip install anki).
python tools/verify-with-anki.py "My Deck.apkg" \
  /tmp/plusaudio-verify/run1.apkg /tmp/plusaudio-verify/run2.apkg
```

## What this is not

It does not create cards.
The card generation policy lives in `supabase/functions/_shared/` and is being lifted into a module
both amgi and this CLI can call; `lib/tts.js` is the interim generator until then.

The scripts that produced the owner's original deck are in `archives/plusaudio-2025/`, with a note on
why they were retired and what is worth mining from them.
