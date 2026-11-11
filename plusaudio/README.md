# plusaudio

The card generation policy (`lib/cardGeneration/`) and `generate-clip.js`, the one entry point the Anki add-on's
Fill missing audio runs.
The app's own server holds a C port of the same policy (`server/amgi/cards.c`); this copy is what is left for the add-on.

```bash
node generate-clip.js --text "안녕하세요" --language ko --out clip.wav
```

Text and a language in, one clip written to `--out`, nothing else.
It is a supported boundary between Python (the add-on) and this code, so its contract is documented at the top
of the file itself - arguments, exit codes (0 success, 1 generation failure, 2 usage error, 3 rate limited with
stdout `retry-after-ms=<n>`, 4 a daily cap spent), and what stdout and stderr each carry - and
`tests/server/plusaudio/generate-clip.test.js` tests it directly.
It reads `GEMINI_API_KEY` from the environment, or a `.env` next to it.

`lib/generator.js` is a thin adapter over `lib/cardGeneration/cardGeneration.ts`.
A clip is made with the same models, the same voice pool and the same refusal to keep audio that does not say what
the note says as the app's.
It does not create cards: that is the app's job, through the server's `POST /api/anki/card-text` or `amgi card add`.
Adding audio to a whole `.apkg` file is not offered; `anki/README.md` covers adding audio to existing notes.

## Requirements

Node 24.12, 25.1 or 26 and later, which is what `engines` says.
It is type stripping that runs the shared generator's TypeScript with no build step, and `node:sqlite`'s `enableDefensive` that put the floor where it is (`enableDefensive` landed in 25.1.0 and was backported to 24.12.0, so 25.0.x is out while 24.12 and later is in - hence the three ranges rather than one `>=`).
No native builds and no runtime dependencies at all: every model call goes to Google's Gemini API through `lib/cardGeneration/gemini.ts`, so the tests need no key and no package.

## Talking to Gemini

The client speaks gRPC to `generativelanguage.googleapis.com:443` (`google.ai.generativelanguage.v1beta.GenerativeService/GenerateContent`), with the key in the `x-goog-api-key` metadata.
It runs on Node's own `node:http2`, and the protobuf messages are a hand-written subset in [`lib/cardGeneration/geminiWire.ts`](lib/cardGeneration/geminiWire.ts) (`lib/protobuf.js`).
Nothing on the wire is JSON, and audio goes both ways as raw bytes: one TTS clip of 83 KB was 83 KB on the wire, against 116 KB of base64 JSON over REST.
A request field that `geminiWire.ts` does not declare is refused before anything is sent, rather than silently dropped.

The subset is hand-written rather than generated because Google's published protos lag the live service: their `ThinkingConfig` has no `thinking_level`, the one generation setting amgi relies on.
Its field number (4) and enum values were confirmed against the live service, and the header of `geminiWire.ts` lists what was verified and how.
A gRPC runtime (`@grpc/grpc-js` with `protobufjs`, about 7 MB) would also end the zero-dependency rule for a dozen small messages.

Errors arrive as a gRPC status with `google.rpc` details in `grpc-status-details-bin`.
A spent quota is `RESOURCE_EXHAUSTED` with a `QuotaFailure` (whose `quotaId` says per day or per minute) and a `RetryInfo`.
Codes that Google maps to an HTTP 4xx are fatal and the rest are retried, the same split the REST client made.

`GEMINI_API_BASE` points `generate-clip.js` at another server; an `http://` address is spoken to as cleartext HTTP/2.
`node tests/server/plusaudio/helpers/fake-gemini.js [port]` starts the tests' fake gRPC server on its own, answering every kind of request with a passing default, and prints the `GEMINI_API_BASE` to use.

## Tests

```bash
node --test "tests/server/plusaudio/**/*.test.js"   # from the repo root; or: npm test, or npm test at the repo root
```
