# amgi Roadmap

What is still open.
Items from the retired hosted service (accounts, Supabase, the in-app scheduler and reviewer) are gone from this file, shipped or obsolete; they are in git history.

## Conventions

- Model names live in `plusaudio/lib/cardGeneration/models.ts`.
  Never hardcode a model string anywhere else.
- How a card is written and how its audio is validated live in `plusaudio/lib/cardGeneration/cardGeneration.ts`.
  The `amgi_bridge` add-on reaches it by running `plusaudio/generate-clip.js`, never by bundling it; the app's server holds its port in C (`server/amgi/cards.c`).
  It imports nothing from npm, so Node can load it with type stripping and no build step.
  Keep it that way, or every caller grows a second, worse generator.
- Run `npm run lint`, `npm test` and `npm run build` before committing, and keep all three green.
  If you touch the card template or the shared review-loop files, also run `node tests/e2e/anki/drive.js`, which `npm test` does not.

## A reading line for scripts a beginner cannot read yet

A beginner memorizing Korean or Japanese phrases by ear may not read the script yet.
The answer is never a Latin transliteration: a learner of Japanese reads kana, not "itta".
So a reading line has to be furigana or kana for Japanese, zhuyin for Chinese, and the native annotation for any other opaque script.

Groundwork exists for a different purpose.
`plusaudio/lib/cardGeneration/cardText.ts` (`readingIsAmbiguous`, the `spoken_reading` field) asks the model for a reading of reading-ambiguous languages (`ja`, `zh_cn`, `zh_hk`) in the language's own script, but only to steer and validate the audio, and no learner ever sees it.
Shipping this needs a `Reading` field on the `amgi Listening` note type (see `anki/addon/amgi_bridge/notetype.py` and `server/amgi/install.c`), filled from that same response, and a place for it on the card template.

## Bulk topic generation

The deck page already makes one card per pasted line (`ui/src/bulk.c`).
What is missing is the step before it: asking for twenty phrases about a topic in one request, and reviewing them before the run starts.
No plan has been written for it yet.

## CI

There is no `.github/workflows/` yet.
On every PR it should run `npm ci`, `npm run lint`, `npm run build`, `npm test` and `node tests/e2e/anki/drive.js`.
