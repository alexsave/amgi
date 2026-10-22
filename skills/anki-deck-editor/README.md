# anki-deck-editor

An agent skill (`SKILL.md`) that lets Claude Code, Cursor, Codex and other agents read and edit a real Anki collection. It can manage decks, note types, notes and media, fill in text-to-speech audio, and write card templates that work on every Anki client.

- `SKILL.md`: what the agent reads.
- `scripts/anki_tool.py`: one CLI with JSON in and out. Uses AnkiConnect when Anki is open, and Anki's own Python library (`pip install anki`) on the collection file when it is closed. It never writes raw SQL.
- `scripts/tts.py`, `scripts/media_refs.py`: OpenAI speech with a transcription check, and content-hashed clip names so a rerun only regenerates audio for changed text.
- `references/`: card-template and collection-internals notes. They come from building [amgi](https://github.com/alexsave/amgi) and were checked against Anki's source and against real Anki.

## Tests

```bash
python -m venv .venv && .venv/bin/pip install anki
.venv/bin/python -m unittest discover -s tests -v
```

These run against a real collection created by Anki's library, with OpenAI replaced by a local fake server. The AnkiConnect path was checked by hand against Anki 26.09.3 running headless with AnkiConnect installed. That is not automated here.
