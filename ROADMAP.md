# amgi Roadmap

What is still open.
Items from the retired hosted service (accounts, Supabase, the in-app scheduler and reviewer) are gone from this file, shipped or obsolete; they are in git history.

## Conventions

- Model names live in `server/amgi/gemini.h` and `server/amgi/cards.c`.
  Never hardcode a model string anywhere else.
- How a card is written and how its audio is validated live in `server/amgi/cards.c`.
  The deck page, the command line and `amgi audio fill` all reach it through the server.
  Keep it that way, or every caller grows a second, worse generator.
- Run `npm run lint`, `npm test` and `npm run build` before committing, and keep all three green.
  If you touch the card template or the shared review-loop files, also run `node tests/e2e/anki/drive.js`, which `npm test` does not.

## A reading line for scripts a beginner cannot read yet

A beginner memorizing Korean or Japanese phrases by ear may not read the script yet.
The answer is never a Latin transliteration: a learner of Japanese reads kana, not "itta".
So a reading line has to be furigana or kana for Japanese, zhuyin for Chinese, and the native annotation for any other opaque script.

Groundwork exists for a different purpose.
`server/amgi/cards.c` (`card_reading_is_ambiguous`, the `spoken_reading` field) asks the model for a reading of reading-ambiguous languages (`ja`, `zh_cn`, `zh_hk`) in the language's own script, but only to steer and validate the audio, and no learner ever sees it.
Shipping this needs a `Reading` field on the `amgi Listening` note type (see `anki/addon/amgi_bridge/notetype.py` and `server/amgi/install.c`), filled from that same response, and a place for it on the card template.

## Bulk topic generation

The deck page already makes one card per pasted line (`ui/src/bulk.c`).
What is missing is the step before it: asking for twenty phrases about a topic in one request, and reviewing them before the run starts.
No plan has been written for it yet.

## CI

`.github/workflows/test.yml` runs `make test` and `make lint` on every PR.
It should also run `node tests/e2e/anki/drive.js`.

## A bulk write that outlasts its timeout can be added twice

The deck page writes a paste's cards in batches of up to 10 (`ui/src/bulk.c`, `FLUSH_SIZE`), one `POST /notes/bulk` each.
With Anki open, the server hands a batch to the add-on with a 30-second budget (`server/collection/bridge.c`, `OPERATION_TIMEOUT_MS`), the same 30 seconds the add-on gives its own operation (`bridge_dispatch.py`, `DEFAULT_TIMEOUT_SECONDS`).
A batch that runs past that is reported as failed, but Anki's CollectionOp is not cancelled and commits the notes anyway.
The row then says "failed", and its Retry makes the card again and writes it again, because the check for lines the deck already has runs only when a run starts.
No one has hit it: it takes a batch slower than 30 seconds.
The fix: the bulk path makes each note's guid before the first write, and the add-on's `add_notes_bulk` treats a guid already in the collection as that note added.
Verified against the code on 2026-11-27 (no guid in `ui/wire/wire.c` or `ui/src/bulk.c`, no deduplication in `bridge_ops.py`).
