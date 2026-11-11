# plusaudio

This folder is now test support, and nothing in it ships.
The card generation that used to live here (the Node generator and `generate-clip.js`, which the Anki add-on ran) is C now: the server's `server/amgi/cards.c`, and `server/build/amgi-clip` (`server/cli/clip.c`) for the add-on's Fill missing audio.
Moving what is left into `test/` is a candidate follow-up; it stays here for now so the paths the tests name do not move twice.

## What is left

- `test/helpers/fake-gemini.js`: the tests' fake Gemini, a real gRPC server on `127.0.0.1` (cleartext HTTP/2, an ephemeral port), so the C client under test runs its whole transport exactly as it does against `generativelanguage.googleapis.com`, and only the far end is ours.
  The parity tests (`test/parity/`), the add-on's `test_generator.py` and the e2e drives (`ui/tools/`) start it.
  Run directly, `node test/helpers/fake-gemini.js [port]` answers every kind of request with a passing default and prints the `GEMINI_API_BASE` to point the app or `amgi-clip` at.
- `lib/cardGeneration/geminiWire.ts` and `lib/protobuf.js`: the fake's codec, a hand-written subset of the Gemini protobuf messages (see below).
- `lib/cardGeneration/geminiSpeech.ts`: the WAV header the fake's speech answers are wrapped in.
- `lib/random.js` and `test/random.test.js`: the seedable random source of the tests' JavaScript, and the scan that fails on any stray random anywhere in the repository (the C side's source is `server/collection/rng.c`).
- `test/collection/helpers/anki-python.js`: a bridge to the real Anki library, for the parity tests and the e2e fixtures that check amgi's collection writes against Anki's own code.
- `ANSWER_FORMAT.md`: why Gemini's structured answers are read as JSON text, which `server/json/model_answer.h` and `test/no-json.test.mjs` cite.

## The fake's wire

The client speaks gRPC to `generativelanguage.googleapis.com:443` (`google.ai.generativelanguage.v1beta.GenerativeService/GenerateContent`), with the key in the `x-goog-api-key` metadata.
The fake runs on Node's own `node:http2`, and the protobuf messages are a hand-written subset in [`lib/cardGeneration/geminiWire.ts`](lib/cardGeneration/geminiWire.ts) (on `lib/protobuf.js`).
Nothing on the wire is JSON, and audio goes both ways as raw bytes.

The subset is hand-written rather than generated because Google's published protos lag the live service: their `ThinkingConfig` has no `thinking_level`, the one generation setting amgi relies on.
Its field number (4) and enum values were confirmed against the live service, and the header of `geminiWire.ts` lists what was verified and how.

Errors go back as a gRPC status with `google.rpc` details in `grpc-status-details-bin`.
A spent quota is `RESOURCE_EXHAUSTED` with a `QuotaFailure` (whose `quotaId` says per day or per minute) and a `RetryInfo`, which is how the tests drive the rate gate and the daily cap.

## Requirements

Node 24.12, 25.1 or 26 and later, which is what `engines` says; Node runs the TypeScript here by type stripping, with no build step.
Node is needed only for the tests and the linter: building and running amgi, and the add-on's Fill missing audio, need none.
There are no runtime dependencies at all.

## Tests

```bash
node --test "test/**/*.test.js"   # or npm test at the repo root, which runs everything
```
