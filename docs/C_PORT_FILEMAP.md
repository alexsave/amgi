## File map for review: C to the JavaScript it ports

| C | JavaScript it ports |
| --- | --- |
| `server/collection/direct.c` | `src/server/anki/directClient.js` (the per-path chain, now a FIFO ticket lock; one function per op; `listNotesInDeck`'s limit+1 and `hasMore`) and `plusaudio/lib/collection/index.js` (`Collection`: `_withBackup`, `_ensureBackedUp`, `createNotetype`'s media after the rows) |
| `server/collection/collection.h` | the ops shape `createDirectOps` returns (the API L2 calls) |
| `server/collection/db.c` | `plusaudio/lib/collection/open.js` (`openCollection`, `withCollection`, lock detection, `wal_checkpoint`) and `relaxed-read.js` (`withLiveCollationsRelaxed`, which `decks.js`'s `withDecksCollationRelaxed` also uses here). Also node:sqlite's defaults: defensive on, foreign keys on, no double-quoted strings, how a number binds. Also the unicase collation |
| `server/collection/backup.c` | `plusaudio/lib/collection/backup.js` (the ledger, mark, stamps, prune, `COPYFILE_EXCL` walk) |
| `server/collection/decks.c` | `plusaudio/lib/collection/decks.js` (list, create, rename, `deckAndChildIds`, `foldKey`, `normalizeComponent`) and `deck-remove.js` (plan, summary, remove, return home, index check) |
| `server/collection/notes.c` | `plusaudio/lib/collection/notes.js`, `notetypes.js`, `notetype-write.js` and `ids.js` (`randomGuid`, the id `CASE`) |
| `server/collection/text.c` | `plusaudio/lib/collection/template.js`; `plusaudio/lib/deck.js`'s `stripHtmlPreservingMedia`, `decodeEntities`, `fieldChecksum`, `ankiFields`, `joinFields`, `splitFields`, `renderAudioReference`; `plusaudio/lib/cardGeneration/cardText.ts`'s `looksRomanized`, `hasNativeScript`, `normalizeLanguageCode` |
| `server/collection/media.c` | `plusaudio/lib/collection/media.js` and `paths.js` |
| `server/collection/pb.c` | `plusaudio/lib/protobuf.js` (lenient read, varint and bytes fields) |
| `server/collection/rng.c`, `rng.h` | `plusaudio/lib/random.js` (sfc32 and splitmix32, `bytes()`) |
| `server/json/anki_json.c`, `anki_json.h` | `JSON.parse` and `JSON.stringify` as `decks.js`, `deck-remove.js`, `notes.js` and `notetypes.js` use them on Anki's columns |
| `server/collection/util.c`, `util.h` | no JS file: the built-ins the JS leaned on (`trim`, `toLowerCase`, `normalize('NFC')`, `localeCompare`, `<` on strings, Number to string, `path.resolve/join/basename/dirname/extname`, sha1, Node's UTF-8 decoding) |
| `server/collection/core.h` | internal: the throw/catch context that stands for JS exceptions, and statement helpers |
| `server/collection/cli.c` | `test/parity/collection-impl.mjs` (the C side of the parity protocol) |

Not ported in L1, and where it goes:
- `src/server/anki/transport.js` (`resolveTransport`, `discoverProfiles`): L2 and L3.
- `src/server/anki/bridgeClient.js`: L3.
- `src/server/anki/install.js` and `starterDeck.js`, which orchestrate over the ops: L2. The parity runner already runs them over the C ops.
