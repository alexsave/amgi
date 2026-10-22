---
name: anki-deck-editor
description: Read and edit a user's real Anki collection - list profiles, decks, note types and notes; create and rename decks; add, update and delete notes in bulk; create note types (including cloze); add media; and fill text-to-speech audio into notes that lack it. Works with Anki closed (opens collection.anki2 through Anki's own Python library) or open (through the AnkiConnect add-on), picks between them automatically, backs up before writing, and never corrupts scheduling. Use whenever the user wants to build, change, clean up, bulk-import into, or add audio to an Anki deck, or write an Anki card template that plays audio or uses JavaScript.
---

# Editing a real Anki collection

Everything goes through `scripts/anki_tool.py`: one command per action, JSON on stdout.
It never writes SQL itself. With Anki closed it opens the collection through Anki's own Python library (`pip install anki`), and with Anki open it goes through the AnkiConnect add-on. Either way, Anki's own code does every write.

## Setup (once)

```bash
python3 -m venv ~/.anki-tool && ~/.anki-tool/bin/pip install "anki==<the user's Anki version>"
```

Match the user's desktop Anki version (Help > About). An older desktop Anki may refuse a collection that a newer library has touched, and the library upgrades old collections on open.
If the user would rather keep Anki open, have them install **AnkiConnect** (Tools > Add-ons > Get Add-ons, code `2055492159`) and restart Anki. That path needs no `pip` at all.
Install it from AnkiWeb with that code, not from the archived `FooSoft/anki-connect` GitHub repo. That copy sets a new note's deck in a way modern Anki ignores, so notes land in whichever deck was last used. The tool notices this, moves the cards to the right deck and marks the result `"movedToDeck": true`. If you see that flag, tell the user their AnkiConnect is out of date.

Below, `anki` means `~/.anki-tool/bin/python <skill>/scripts/anki_tool.py`.

## Workflow

1. **Orient.** `anki profiles` lists profiles, shows whether each one is `locked` (open in Anki), and says whether AnkiConnect answers.
   If there are several profiles, ask which one and pass `--profile NAME` on every call.
2. **Read before writing.** `anki decks --counts`, `anki notetypes`, `anki notes --deck NAME --limit 5`.
   Use the note type's real field names. Never guess `Front`/`Back`.
3. **Write.** See the commands below. Every direct-mode write first makes a `.colpkg` backup in the profile's `backups/` folder, reusing one from the last 15 minutes. That is the folder Anki's File > Switch Profile > Open Backup restores from. The path comes back as `"backup"`.
4. **Verify.** Read the notes back. Run `anki cards NOTE_ID` to see the rendered question and answer HTML, and use `anki check-media` after adding media (direct mode only).

If a command returns `"kind": "locked"`, Anki is open and AnkiConnect is not installed. Ask the user to close Anki or install AnkiConnect. Never work around the lock by copying or forcing the file.

## Commands

| Command | Does |
| --- | --- |
| `profiles` | Profiles, lock state, whether AnkiConnect is up |
| `status` | Which backend answered, schema version, note and card counts |
| `decks [--counts]` | Every deck. `A::B` is subdeck B of A |
| `notetypes [--name N]` | Fields, templates (front/back HTML) and CSS |
| `notes [--deck D] [--query Q] [--offset] [--limit]` | Notes, paged, with fields as `{name: value}`, tags and card ids. `--deck` includes subdecks, and `--query` is [Anki search syntax](https://docs.ankiweb.net/searching.html) |
| `cards NOTE_ID` | Each card rendered exactly as Anki would show it |
| `create-deck NAME` | Find-or-create. Missing `::` parents are created too, and matching ignores case the way Anki does |
| `rename-deck OLD NEW` | Direct mode only (AnkiConnect has no rename) |
| `add-notes JSON` | `[{deck, notetype, fields: {Name: value}, tags: []}]` as a literal, `@file.json` or `-` for stdin. Missing decks are created. Each note gets its own result: `ok`, or `kind` `duplicate`/`invalid` with a reason. One bad note never aborts the batch |
| `update-note ID [--fields JSON] [--tags "a b"]` | Changes only the fields you name. `--tags` replaces all tags |
| `delete-notes ID... --yes` | Deletes the cards and their review history too. Get the user's explicit OK first |
| `add-media FILE [--name N] [--form sound\|html\|img]` | Stores the file and prints the reference to paste into a field |
| `check-media` | Anki's Check Media: files that are referenced but missing, and files that are unused |
| `create-notetype JSON` | `{name, fields: [...], templates: [{name, front, back}], css, cloze: bool}` |
| `fill-audio --deck D --text-field F --audio-field G --language L [--form sound\|html] [--limit N] [--dry-run]` | Text-to-speech for each note whose audio field lacks a clip for its current text. Needs `OPENAI_API_KEY` |

Global flags go before the command: `--backend auto|connect|direct`, `--profile`, `--collection PATH`, `--no-backup`.

### Adding many notes

Write the batch to a file and send it in one call rather than one call per note: it opens the collection once, or makes one AnkiConnect round trip.

```bash
anki add-notes @batch.json
```

Duplicates follow Anki's own rule: the same note type with the same first field, scoped to the target deck. They are skipped unless you pass `--allow-duplicates`. A note with an empty first field is refused, as Anki's own Add dialog refuses it.
Report what was skipped and why. Don't hide it.

### Audio

Run `fill-audio --dry-run` first and show the user how many clips will be generated, because generation costs them money.
Each clip's filename is a hash of its language and text, so:
- A rerun only generates for new or changed text.
- Switching `--form` rewrites the references without generating anything.
- The note's other references, such as the deck author's own recordings and images, are left alone.

Each clip is transcribed back and compared with the text, and a mismatch is retried with another voice. If every attempt mismatches, the note is reported under `failed` and left untouched, never given a wrong clip. Transcribers normalise numbers and sometimes change scripts, so if the failures look like false alarms, show the user what was heard before suggesting `--no-verify`.

## Rules that keep a collection safe

- **Never edit `collection.anki2` with sqlite3 or any other tool.** Anki keeps derived state: card generation from templates, a custom `unicase` collation on name indexes, `usn` and `mod` for sync, and field checksums for duplicate detection. Raw writes get these subtly wrong. Use this tool or Anki itself.
- **Never open the collection while Anki has it open, and never leave it open.** Anki holds the file with an exclusive lock, so a second opener is refused, and a handle left open stops Anki from opening the profile. The tool opens, works and closes on every call.
- **Notes keep their identity.** Update a note in place rather than deleting and re-adding it: re-adding loses its review history and makes a duplicate on the user's other devices after sync. The same applies to note types: when the user wants different fields, edit the note type rather than making a new one and moving the notes.
- **Changes reach the user's phone only through sync.** After a direct-mode edit, the user should open Anki and sync. If AnkiWeb asks to upload or download the whole collection, they should pick the side that has the edits, which is usually this computer (upload).
- **Ask before anything destructive**: deleting notes, renaming decks the user didn't mention, or changing a note type's fields or templates on a deck that already has reviews.

## Going deeper

- `references/card-templates.md`: writing templates that play audio, run JavaScript or use the microphone. Covers what each client (desktop, AnkiDroid, AnkiMobile, AnkiWeb) actually allows, why `[sound:]` is invisible to template JavaScript, keyboard shortcuts that race Anki's own, and media files that must survive Check Media.
- `references/collection-internals.md`: how the collection file, locking, schemas 11 and 18, media folder, `.apkg` import matching (by GUID), sync and backups work, for when something here doesn't behave as expected.
