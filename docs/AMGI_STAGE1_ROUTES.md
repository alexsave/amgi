# amgi stage 1: replacing the Node backend with C handlers on c_base's local provider

Read-only investigation. Nobody writes code from this yet.

## 0. Pins

- amgi: origin/main at `34f415a70c185b083820ab897834bd2fd07697d0`. All amgi paths below are read from that commit.
- cbase (alexsave/cbase): `e4ccc7b20114e426b5bf8b1deef599aa9a5ee9eb`. Read via `git show` on that hash only.
- Naming: the cbase submodule mounts at `cbase/` in amgi (owner correction). Layout below uses `cbase/cbase.mk`.
- Unmerged branch check (`git branch -a` in amgi):
  - Delete-deck is NOT unmerged. `GET` and `DELETE /api/anki/decks/:id` are already on origin/main (commits 3e4c8cd server, 4ceaf99 direct transport, ea6ed96 bridge, f87c880 page, 86457c9 drive). Wire kinds `deck_summary` and `deck_removed` are in wire.h. They are in the table below.
  - `origin/json-subprocess` (head d7a4939, based on d82e7c8, so it lacks the delete-deck commits) is the branch that matters for stage 1. It replaces the JSON line `generate-card-text.js` prints with a length-prefixed layout (`plusaudio/lib/cardTextLayout.js`, header `amgi-card-text 1`, then `front_text`, `back_text`, `spoken_reading` as `<name> <byte length>\n<bytes>\n`), and makes the script IPC channel V8 binary clone. Stage 1 should land it first: the C handler must read exactly that layout, not a JSON line. It will conflict with main on README, wire.c/wire.h and deck files only because it predates delete-deck.
  - Other branches (`claude/amgi-modernization-tl4nxv`, `claude/magical-dirac-mvoe5a`, `claude/new-supabase-project`) are not relevant to the server.

## 1. Summary table

Wire kind names are the ones `ROUTES` in `ui/server/serve.mjs:59-81` names. Request kind first, answer kind second. Any 4xx or 5xx answer is kind `error`.
serve.mjs line numbers: route table 59-81, `api()` 93-131, static files 133-163, listen 171.
Handler files are under `src/server/api/anki/`.

| # | Method and path | Request kind | Answer kind | Handler file:line | What it does | Node facilities | c_base piece needed |
|---|---|---|---|---|---|---|---|
| 1 | GET /status | none | status | status/route.js:9 | Reports the transport mode (direct, bridge, locked, ...), schema version, bridge detail. Always 200. | resolveTransport: in-process plusaudio collection (node:sqlite), http to Anki bridge with 1500 ms timer | router, spawn (collection script) |
| 2 | GET /decks | none | decks | decks/route.js:6 | Deck list with a note count per deck (one query per deck, `Promise.all`). | transport, in-process collection | router, spawn |
| 3 | POST /decks | q_deck_name | deck_created | decks/route.js:22 | Find-or-create a deck by trimmed name. 400 on empty name or error. | transport, collection write | router, spawn |
| 4 | PATCH /decks/:id | q_deck_name | deck_renamed | decks/[id]/route.js:13 | Rename deck and all subdecks, creating a missing parent. 400 on error. | transport, collection write | router (prefix route), spawn |
| 5 | GET /decks/:id | none | deck_summary | decks/[id]/route.js:40 | What deleting would take: subdecks, cards, orphaned notes. 404 if gone. | transport, collection read | router, spawn |
| 6 | DELETE /decks/:id | none | deck_removed | decks/[id]/route.js:55 | Delete deck as Anki does (subdecks, cards, orphan notes, graves). Default deck refused with 400. | transport, collection write (Anki's own col.decks.remove on bridge) | router, spawn |
| 7 | GET /decks/:id/notes?offset&limit | none | notes | decks/[id]/notes/route.js:9 | Page of notes. Default limit 50, max 200, offset floor 0. `hasMore` computed (limit+1 trick on direct, total on bridge). | transport, collection read | router, query parse, spawn |
| 8 | GET /decks/:id/notes/field-values?notetypeId&fieldIndex | none | field_values | decks/[id]/notes/field-values/route.js:13 | Every value in one field for one notetype in one deck (bulk dupe check). 400 if either param not an integer. | transport, collection read (30 s timer on bridge) | router, query, spawn |
| 9 | GET /install | none | install_state | install/route.js:45 | Are the add-ons in Anki's addons21, are they current (sha256 of every file against shipped), is the collection caught up (templates and media compared). | fs read, crypto sha256, in-process collection (listNotetypes, readMedia) | router, file ops (readdir, read, sha256), spawn |
| 10 | POST /install | q_install | installed | install/route.js:10 | Copy both add-ons plus card type into `<base>/addons21`, prune files no longer shipped, then create the notetype directly if the direct transport is live. 409 with `ok:false` when no source or no Anki folder. | fs write (mkdir, copy, rm), in-process createNotetype | router, file ops (copy tree, unlink), spawn |
| 11 | GET /profiles | none | profiles | profiles/route.js:8 | Finds Anki data folder and its profiles (`defaultBaseDir`, `listProfiles`). Needs no transport. | fs readdir, os.homedir | router, file ops |
| 12 | GET /notetypes | none | notetypes | notetypes/route.js:6 | Notetype list (id, name, fieldNames, sortFieldIndex). | transport, collection read | router, spawn |
| 13 | POST /notes | q_note | note_added | notes/route.js:6 | Add one note. 400 when deckId, notetypeId or fields missing, or on error. | transport, collection write | router, spawn |
| 14 | POST /notes/bulk | q_notes | notes_added | notes/bulk/route.js:13 | Add a paste's worth of notes as one unit, per-note ok/error results. | transport, collection write (one CollectionOp on bridge, 30 s timer) | router, spawn, body size |
| 15 | PATCH /notes/:id | q_note_update | note_changed | notes/[id]/route.js:12 | Replace a note's fields in place. 400 if fields not a list. | transport, collection write | router, spawn |
| 16 | DELETE /notes/:id | none | note_changed | notes/[id]/route.js:36 | Delete note and cards, leave graves. | transport, collection write | router, spawn |
| 17 | POST /card-text | q_card_text | card_text | card-text/route.js:11 | Gemini card text then audio, in one request (one-pass rule), optional cue audio. 400 on missing input, 429 on limits. | rate gate (in-process), fork of generate-card-text.js and generate-clip.js, in-process sideOrder, audio-store, ops.hasMedia and addMedia | router, spawn with pipes and exit codes, timers/rate gate state, child process wait |
| 18 | POST /audio | q_audio | clip | audio/route.js:8 | One clip for text and language, attach as media; `fresh` re-records. | same as 17 | same as 17 |
| 19 | GET /starter | none | starter_state | starter/route.js:13 | Is the free starter deck offered, in which languages. Needs no transport. | fs read of TSV and media dir, in-process audio-store name hash, env GEMINI_API_KEY | router, file ops |
| 20 | POST /starter | q_starter | starter_built | starter/route.js:17 | Build the 10-phrase starter deck: create deck, dedupe, copy shipped clips, add notes. | transport, in-process buildStarterDeck, fs, in-process audio-store and lyricsParse | router, spawn, file ops |
| 21 | GET /media/:filename | none | none (raw bytes) | media/[filename]/route.js:14 | Serve one clip from the collection's media folder. Content-Type by extension, `Cache-Control: private, max-age=31536000, immutable`, Content-Length. 404 text `no such clip`. | transport.readMedia (direct: folder read; bridge: base64 over JSON), mediaType.js | router, static or file read, content-type table, spawn (bridge mode) |

Route count: 21 API routes (20 wire-kinded, 1 raw bytes). Plus non-API: `/` (307 to `/decks`), page paths, `/app.wasm`, `/app.css`, public icons.

## 2. Per-route detail

Common to every route except 11 and 19 (and the file half of 9, 10): `readSettings(request)` reads five headers, then `resolveTransport(settings)`; if no `ops`, `notReadyResponse(mode)` answers 409 with `{mode, error}` where error is the fixed message from `respond.js`.
Settings headers (`settings.js:15-21`, each percent-encoded UTF-8, malformed escape reads as empty): `x-amgi-base-dir`, `x-amgi-collection`, `x-amgi-profile`, `x-amgi-bridge-url`, `x-amgi-bridge-token`.
The 409 `error` kind carries `mode` (a `WT_MODE` byte) and `error` text. The `mode` strings are `locked`, `not-found`, `unsupported-schema`, `unconfigured`, `bridge-no-collection` (wire.h WIRE_MODE_*).
Body rule: a route with a request kind answers 415 (`error` kind, text `send the body as application/x-amgi-wire`) when content-type does not start with `application/x-amgi-wire`, and 400 (`the body is not a whole message of its kind`) when decode fails. A route not in `ROUTES` answers 501 text. Unknown path 404 text `no such route`. Method missing on the module 405 text.
Field lists are from `ui/wire/wire.h` structs and the `wire.c` SCHEMA table (JS key names in brackets where they differ from the C name).

### 2.1 GET /status (status)
- Answer `wire_status`: mode (u8), schemaVersion (u32), detail (string). The `detail` string on the bridge path is the bridge's own status; in Node it is an object that the schema flattens by key `detail` (str), so the C handler writes whatever string the script returns.
- Never non-200.
- Edge cases: bridge configured but unreachable falls back to direct (probe 1500 ms); bridge reachable with `collectionOpen` false gives `bridge-no-collection`; no collection path gives `unconfigured`; polled on an interval by the page, so it must be cheap and must not race another call into a false `locked` (see section 3.4).

### 2.2 GET /decks (decks)
- Answer `wire_decks`: mode, list of {id i64, name, noteCount u32}.
- Edge: Anki ids exceed 2^32 (WT_I64). Deck names can be non-Latin.

### 2.3 POST /decks (deck_created)
- Request `q_deck_name`: name. Trimmed; empty gives 400 `a deck name is required`.
- Answer `deck_created`: mode, `deck.id` (i64), `deck.name`, created (bool). Find-or-create: existing name gives created false.
- Side effect: collection write (backup rules in 3.4).
- Edge: any thrown error is a 400 with the message.

### 2.4 PATCH /decks/:id (deck_renamed)
- Request `q_deck_name`. Empty or non-string: 400 `name is required`.
- Answer: mode, id, name.
- Edge: subdeck rename rewrites descendants (names carry the parent prefix); renaming into a missing parent creates it.

### 2.5 GET /decks/:id (deck_summary)
- Answer: mode, id, name, subdecks, cards, notes (u32).
- 404 `This deck no longer exists.` when the ops error status is 404, else 400 with the message.

### 2.6 DELETE /decks/:id (deck_removed)
- Answer: mode, id, name, decks, cards, notes.
- 404 and 400 as for 2.5. Default deck is refused (400).
- Side effects: removes decks, cards, orphan notes, filtered cards sent home, per-deck config, leaves graves. Backup before write.
- Tests worth porting: the `deckRemoveRoute` suite, the deckdelete drive (delete while the confirmation is open, and before).

### 2.7 GET /decks/:id/notes (notes)
- Query: `offset` (default 0, floor 0, non-number gives 0), `limit` (default 50, clamp 1..200, 0 or NaN gives 50).
- Answer: mode, list of {id i64, notetypeId i64, fields[], tags[]}, offset, limit, hasMore.
- Edge: both transports are normalised to hasMore (bridge returns total, direct fetches limit+1). `id` path segment is `Number(id)`, so ids above 2^53 would lose precision (Anki ids are ms epoch, safe).

### 2.8 GET /decks/:id/notes/field-values (field_values)
- Query `notetypeId`, `fieldIndex` must be integers (`Number.isInteger`), else 400 `notetypeId and fieldIndex are required`. Note `Number('')` is 0, which is an integer, so a missing param becomes 0 on the Node side: the C port must copy this exactly or deliberately tighten it (open question).
- Answer: mode, values[].

### 2.9 GET /install (install_state)
- Never a transport error: file half answers even if locked.
- Answer: installed, upToDate (tri: true, false, unknown), collectionChecked, collectionStale[], ready, baseDir.
- Logic (`install.js:191-275`): installed iff both `amgi_mic/__init__.py` and `amgi_bridge/__init__.py` exist under `<base>/addons21`. upToDate compares sha256 of every shipped file (skipping `__pycache__`, `test`, `.pytest_cache`, `.DS_Store`) plus the 7 card-type files against what is installed; unknown (null) when the add-on sources are not under `process.cwd()`. collectionDrift compares the two templates' question and answer formats and two media files byte for byte through the collection.
- Edge: `repoRoot()` is `process.cwd()`. The C server must be started from the repo root or take an explicit root. stale list is sorted.

### 2.10 POST /install (installed)
- Request `q_install`: baseDirOverride. A non-blank body override wins over the header override.
- Answer `wire_installed`: ok, needsRestart, message, addonsDir. Node also returns extra keys (baseDir, installed[], cardType[], notetypeCreated) that the wire schema does not carry; the schema is the contract, so C writes only the four.
- 409 with `ok:false` for `no-source` and `no-anki`: `serve.mjs` sends any status of 400 or more as kind `error`, and `asError` maps `message` to `error`. So the C handler writes kind `error` with the message text, not kind `installed`.
- Side effects on disk: creates `<base>/addons21`; overlay-copies `anki/addon/amgi_mic` and `amgi_bridge` (skipping the skip set), then removes files in the target no longer shipped (never delete-first, so a running Anki never sees a missing folder); copies 7 card-type files into `amgi_bridge/cardtype/`. Anki's `meta.json` config is untouched.
- Then, if the direct transport is live, creates the "amgi Listening" notetype (6 fields Cue, CueAudio, Target, TargetAudio, Language, Notes; 2 templates; css; requirements) and writes `_amgi-loop.js` and `_amgi-loop.css` into the collection media. Message is `INSTALLED_MESSAGE` when created or already existing, else `RESTART_MESSAGE`.
- Edge cases to test: unwritable folder; re-install over a running Anki; pruning a stale file; the Settings panel's unsaved override.

### 2.11 GET /profiles (profiles)
- Answer: baseDir, baseDirExists, list of {name, collectionPath}.
- `defaultBaseDir`: macOS `~/Library/Application Support/Anki2`, Windows `%APPDATA%\Anki2`, Linux `$XDG_DATA_HOME/Anki2` or `~/.local/share/Anki2`. `listProfiles` lists profile folders in the base dir that hold a collection (excludes `addons21`, `backups`, `prefs21.db`). I did not read its full body; check it before porting.
- Edge: non-Latin profile names (Korean is called out in settings.js).

### 2.12 GET /notetypes (notetypes)
- Answer: mode, list of {id, name, fieldNames[], sortFieldIndex}.
- Node objects also carry `templates` (used by collectionDrift in-process) but the wire omits them.

### 2.13 POST /notes (note_added)
- Request `q_note`: deckId i64, notetypeId i64, fields[], tags[], language, learningFieldIndex (i32, ABSENT when missing).
- 400 `deckId, notetypeId and fields are required` when `!deckId`, `!notetypeId` or fields not an array (note: 0 ids count as missing).
- Answer: mode, noteId.
- Edge: `language` and `learningFieldIndex` feed the romanisation guard in `cardText.ts looksRomanized`, so the add can be refused with a 400 message from there.

### 2.14 POST /notes/bulk (notes_added)
- Request `q_notes`: list of `q_note`. 400 on empty list or any note missing deckId, notetypeId or fields.
- Answer: mode, list of {ok, noteId, error}.
- Edge: one request holds a whole paste. Default cbase body cap is 1 MiB (`CBASE_MAX_BODY 1048576`); a paste of thousands of lines is likely under that but this needs a measurement and a raised `CBASE_MAX_BODY` if not. Per-note errors are inside a 200.

### 2.15 PATCH /notes/:id (note_changed) and 2.16 DELETE /notes/:id (note_changed)
- PATCH request `q_note_update`: fields[], language, learningFieldIndex. 400 `fields is required` when not an array.
- Answers: mode, noteId, warning (string; PATCH may carry a romanisation warning).
- DELETE leaves graves so AnkiWeb does not push the note back.

### 2.17 POST /card-text (card_text)
- Request `q_card_text`: userInput, knownLanguage, learningLanguage, includeCueAudio (bool).
- 400 `userInput, knownLanguage and learningLanguage are required` when trimmed userInput or either language is empty.
- Order of checks: transport (409), body (400), `admissionRefusal()` (429 notStarted), then generation.
- Missing `GEMINI_API_KEY`: handler throws `MISSING_KEY_MESSAGE`, which is a 500 `error` (no subprocess started).
- Pipeline: `generate-card-text.js --known --learning --input [--input-language known|learning]` (flag set by in-process `detectInputLanguage`); read card text (JSON line today, `amgi-card-text 1` layout on json-subprocess); `correctSwappedSides` (in-process, may swap sides and clear the reading); `generateAndStoreClip` for back_text in the learning language with the reading; if includeCueAudio, a second clip for front_text in the known language with no reading.
- Answer `wire_card_text`: mode, front_text, back_text, audio.filename, audio.reference, cueAudio.filename, cueAudio.reference. The reading (`spoken_reading`) is NOT on the wire: it is used inside the request and dropped (one-pass rule).
- Exit-code mapping, see section 2.19.
- Edge: the three-way ordering rule (swap before audio) and the one-pass rule need tests; the rate gate is shared across concurrent requests (the bulk screen runs 5 lanes).

### 2.18 POST /audio (clip)
- Request `q_audio`: text (trimmed), language, fresh (bool). 400 `text and language are required`.
- Answer: mode, filename, reference, reused.
- Name is `plusaudio-<first 20 hex of sha1("v1\n"+language+"\n"+text)>.wav` (`audio-store.js mediaName`). If not `fresh` and `ops.hasMedia(name)`, answers `reused` with no generation. Otherwise `generate-clip.js --text --language --out <mkdtemp>/clip.wav [--reading]`, reads the file, `ops.addMedia(name, bytes)` (which may return a different hash-suffixed name for a different take), then removes the temp dir.
- Reference is always `<audio src="NAME"></audio>` via `renderAudioReference(name,'html')`, never `[sound:]`.
- Side effects on disk: temp dir under `os.tmpdir()` (`amgi-clip-*`), a media file in the collection's media folder (direct) or via bridge `POST /media` with base64 JSON.

### 2.19 Exit codes and 429 shapes (routes 17 and 18)
- Script exit codes (`plusaudio/lib/cliExit.js`): 0 success, 1 failure (last stderr line is the one-line human message), 2 usage error, 3 rate limited (stdout has one line `retry-after-ms=<n>`, regex `^retry-after-ms=(\d+)$` multiline), 4 daily cap spent.
- `runPlusaudio` (`plusaudioCli.js:92-110`): code 0 returns stdout. Otherwise stderr is logged, message = last non-empty trimmed stderr line, falling back to a fixed text (`audio generation failed`, `card text generation failed`). Code 3 with a parseable wait gives RateLimitedError(message, retryAfterMs); code 3 without a parseable wait falls through to a plain Error (so 500). Code 4 gives DailyCapError.
- HTTP mapping (`rateLimit.js`): 
  - Rate limited after start: 429, kind `error`, fields `error`, `retryAfterMs`, `maxWaitMs` (=180000, `plusaudio/lib/rateLimits.js MAX_WAIT_MS`), header `Retry-After: max(1, ceil(retryAfterMs/1000))`.
  - Admission refusal (nothing started): 429, `error` = ``Gemini's per-minute limit is reached; this card waits Ns before starting.`` where N = ceil(wait/1000), plus `retryAfterMs`, `maxWaitMs`, `notStarted:true`, same `Retry-After`.
  - Daily cap: 429, `error` text, `dailyCap:true`. No Retry-After header, no retryAfterMs, no maxWaitMs.
  - Anything else: 500 `error`.
- Wire error kind fields: mode (usually absent, empty), error, retryAfterMs (OPT, NONE when absent), notStarted, dailyCap, maxWaitMs (OPT). These are the only fields the page reads (`ui/src/bulk.c` uses maxWaitMs).
- Edge cases to test: exit 3 with no retry line; exit 4; exit 2; spawn failure (the `error` event: message passes through); stderr with several lines (last wins, a Node module-type warning once ended up first); jitter makes retryAfterMs non-deterministic unless the seed is fixed.

### 2.20 GET /starter (starter_state) and POST /starter (starter_built)
- GET answer: offered, generationAvailable, languages[], phraseCount. `offered` is `!generationAvailable && languages.length > 1`. `generationAvailable` is `Boolean(process.env.GEMINI_API_KEY)`, never the value.
- A language is listed only if every one of its phrases has a shipped clip at `anki/starter/media/<starterClipName>` (mp3 form of the same hash). `phraseCount` = lines in the first column of `src/data/starterPhrases.tsv`.
- TSV: header line of language codes, one phrase per cell, rejected as a whole if any line has the wrong column count or an empty cell.
- POST request `q_starter`: known, learning, name. 400 `known and learning languages are required`. Name defaults to `amgi starter`.
- Answer: mode, deckId, deckName, added, alreadyThere. The Node object also has `missingAudio[]`, not on the wire.
- Logic: errors (all 400): no phrases; known equals learning; unsupported pair; notetype missing (`Restart Anki once so it adds the "amgi Listening" card type, then try again.`). Dedupe by `normalizeForDedupe` against `existingFieldValues`; a failed dedupe read is swallowed. For each phrase: attach both clips (`hasMedia` then `addMedia` of the shipped file), then `addNote` with tag `amgi-starter`.
- Edge: pressing twice must add nothing (alreadyThere == 10); missing a shipped clip leaves the field empty and the phrase is counted as skipped.

### 2.21 GET /media/:filename (raw)
- Not in the wire. Response headers: `Content-Type` from `mediaType.js` (`.mp3` audio/mpeg, `.wav` audio/wav, `.ogg` audio/ogg, `.m4a` audio/mp4, else `application/octet-stream`; case-insensitive extension), `Content-Length`, `Cache-Control: private, max-age=31536000, immutable`.
- 404 plain text `no such clip` when absent; transport 409 as wire `error`... note: the 409 here goes through the same `ANSWER in response` check and is encoded as `error` kind, while 404 text is raw.
- Path segment is `decodeURIComponent`ed. Node does no traversal check of its own on the direct path; whatever `Collection.readMedia` does (not read in detail) is the guard. The C port must reject `/`, `..` and NUL explicitly and test it.
- No Range support today (whole buffer, no `Accept-Ranges`). Parity does not need ranges; Safari audio may.

## 3. Non-route server behaviour

### 3.1 Static files and pages (`serve.mjs:133-163`)
- `/` gives 307 to `/decks`.
- Page paths `^/(decks|settings|deck/[^/]+)?$` serve `ui/out/index.html` (`text/html; charset=utf-8`).
- `/app.wasm` (`application/wasm`), `/app.css` (`text/css; charset=utf-8`) from `ui/out`.
- Public icons: a top-level path whose basename extension is `.png`, `.svg` or `.ico` is read from `<root>/public/<basename>`; only when the path has no directory part (`path.dirname(url.pathname) === '/'`).
- Every static answer has `cache-control: no-store`; missing file is 404 text `not found`.
- Read from disk per request (no cache), so a rebuild is picked up without restart; keep that.
- Note `ui/build.sh` still needs wasm toolchain and node (terser) for the page; only the server changes in stage 1. `ui/out/wire.wasm` and `ui/server/wire.mjs` become unnecessary on the serving path once C handlers use `wire.c` natively (`wire_node.c` stays for the Node tests while Node routes survive).

### 3.2 Startup and environment
- `PORT` default 3000; `PORT=0` takes a free port; binds 127.0.0.1. Prints `amgi on http://127.0.0.1:<port>` on stdout, which `ui/tools/e2e.sh` greps (`start app 'amgi on '`). cbase prints `serve: listening on 127.0.0.1:<port> (backend)` on stderr instead. The C app must print the amgi line itself (a `serve_open` hook runs after the store opens and before serving) or the drives change their grep.
- `.env.local` at repo root is loaded with `process.loadEnvFile` (a variable already set wins). The C server needs its own dotenv reader with the same rules (comments, quotes, `export`?, precedence). `GEMINI_API_KEY`, `GEMINI_API_BASE` (the fake Gemini for tests) pass to children by environment. The scripts additionally load `plusaudio/.env` themselves.
- Node resolution hooks (`hooks.mjs`) disappear with Node routes.
- cbase's `CBASE_LISTEN` (default `127.0.0.1:8080`, port 0..65535 accepted by config) and `CBASE_*` env prefix: amgi would map `PORT` to it. cbase also opens a SQLite store (`CBASE_DB`, default `./cbase.sqlite`) and generates a JWT secret when none is set; neither is wanted by amgi (see gaps).

### 3.3 Rate limiting state
- One `sharedGate()` per server process, per model: `blockedUntil`, `starts[]` (60 s window), learned `cap` (80% of admitted on a 429 with at least 3 evidence, +1 per clean minute), `consecutive429` for a 2 s doubling backoff up to `MAX_BLOCK_MS` = 180000 ms (180 s), Google's retryDelay as floor. Jitter up to 25% from `random.int` (one draw per acquire and per admissionWait, whether used or not). Clock injected.
- Each forked script asks the parent's gate before every Gemini request (`acquire(model)` gives a wait in ms) and reports (`record(model,'ok'|'rateLimited',retryDelayMs)`) over Node's IPC channel, tagged `amgiGate`; no answer in 2000 ms fails open with a 1000 ms wait.
- The state is memory only, per server process, lost on restart. That is acceptable and should be kept.

### 3.4 Anki access: transport, locking, backup
- `resolveTransport` runs on every request, with no cache: bridge probe (`GET /status` on the add-on's HTTP server with `X-Amgi-Bridge-Token`, 1500 ms) when both bridge url and token are set; reachable gives `bridge` (or `bridge-no-collection`); unreachable falls through to `direct` if `collectionPath` is set (`createDirectOps(path).status()` gives ok, locked, not-found, unsupported-schema).
- Bridge calls: short timeout 1500 ms for the probe and fixed-size reads, 30000 ms for writes and the deck-sized reads. Aborting the fetch does not cancel Anki's CollectionOp, which is why writes get the longer timeout. Bodies are JSON (`plusaudio/lib/json/bridgeBody.js`, listed in README as "leaving"). Media crosses the bridge as base64 in JSON. The 30 s timer must be reproduced wherever the bridge client lives.
- Direct transport serializes every call on one promise chain per `path.resolve(collectionPath)`, because the collection library opens a fresh sqlite connection per call with a zero busy timeout and two concurrent opens from this process would report a false `locked`. Whatever replaces it must keep one-at-a-time per collection path.
- The backup ledger (`plusaudio/lib/collection/backup.js`) is in-memory per process: a backup copy before a mutation if this process has not backed up this path, if the file changed behind it, or if the last backup is older than the max age. A one-shot script per request has an empty ledger, so every mutating request would copy the whole collection (the documented "45 copies for 45 note adds" bug).
- Media writes (`addMedia`, `readMedia`, `hasMedia`) are plain folder operations beside the collection (`collection.media`), not behind the collection lock.

### 3.5 Concurrency and long-running requests
- The bulk screen keeps 5 cards in flight; each is a long request (a card with audio can take tens of seconds; the p95 text call alone is 3.7 to 8 s per `ANSWER_FORMAT.md`, plus TTS and validation). No streaming, no SSE, no websockets; every answer is one buffered body.
- Node uses non-blocking `fork` precisely because `spawnSync` froze every other request.
- Page polls `/status` on an interval.
- No request timeout of its own in serve.mjs.

## 4. Gaps: what cbase at e4ccc7b lacks, beyond the three committed

Committed (not repeated as findings): free-port bind, static file serving, process spawn with pipes and exit codes.

Verified absent at the pin:
1. Path parameters. The router (`core/src/net/router.h`) matches exact paths or `"/prefix/*"` only. `:id`, `[id]`, `/decks/<id>/notes/field-values` need a prefix route per family and handler-side segment parsing (`/api/anki/decks/*`, `/notes/*`, `/media/*`). Note the Node rule that fixed segments beat parameters (`notes/bulk` over `notes/[id]`): cbase's longest-prefix rule gives `/api/anki/notes/bulk` (exact) over `/api/anki/notes/*` correctly, but `GET /decks/<id>/notes` versus `PATCH /decks/<id>` share one prefix and must dispatch inside the handler. Also a 405 versus 404 distinction (Node: unknown route 404, unknown method 405) will follow cbase's rules; check parity.
2. Request body cap is `CBASE_MAX_BODY` default 1 MiB (`config.h`); over it the parser answers 413 before the handler. Chunked request bodies are refused (411), `Expect: 100-continue` unsupported. Browsers send Content-Length for `fetch` with a Blob/ArrayBuffer body, so fine; confirm for the C page's `cdom_net`.
3. Platform baggage that a local amgi does not want: the server always opens a store (`CBASE_STORE`, `CBASE_DB` default `./cbase.sqlite`; `cb_store_open_named` in `boot.c`), makes a random JWT secret, registers `/health` and `/admin` routes, `CBASE_ADMIN_TOKEN`, metrics, rate_limits for sign-in. amgi needs a way to say "no store". Either cbase offers a storeless or null store mode, or amgi points `CBASE_DB` at a file it never uses (creating a stray sqlite file in the user's directory, unacceptable for a local app). Needs a cbase decision.
4. CORS: the router adds `Access-Control-Allow-Origin` (default `*`, `CBASE_ALLOWED_ORIGINS`) to every response. The page is same-origin, so it is unneeded, and an open `*` on a loopback server that can write the user's Anki collection and run `install` lets any website in the user's browser call it (Node's server sends no CORS header and the bridge likewise relies on origin rules). amgi must set `CBASE_ALLOWED_ORIGINS` to the page's own origin or cbase must allow none. Related and already true of the Node server: no Host/Origin check, so DNS rebinding is possible; note for the PM, not in scope.
5. Origin-proof gate in `cb_handle`: `cb_config_origin_proven` with `CBASE_ORIGIN_SECRET`. Unset means open (expected); make sure a local build never sets it.
6. Outbound HTTP client to a plain loopback HTTP server (the Anki bridge, and later Gemini over TLS in stage 2). `core/src/net/https.c` exists; I found no plain-HTTP client for arbitrary loopback targets at this pin (only the OIDC/JWKS/MQTT clients). Stage 1 avoids this by leaving the bridge client in Node, but stage 2 needs it with per-call timers.
7. Timers: schedules exist (`cb_schedule`) and park/wake for loop routes, but no per-request deadline API for a pool handler that waits on a child. Needed for any "kill the child after N seconds" policy; Node has none today either, so optional.
8. Child processes beyond the committed spawn: process-group handling (a killed server should not orphan a Gemini script mid-request), stdin close, stdout cap (card text is small, but stderr can be large), a temp dir helper (`mkdtemp`), environment passing (`GEMINI_API_KEY`, `GEMINI_API_BASE`), per-request cwd (`plusaudio/`), and a way to run several children concurrently without exhausting the request pool (`CBASE_REQ_WORKERS`; a handler waiting on a 30 s child holds a pool thread, so 5 bulk lanes plus polls need a pool of at least 8; check the default `REQ_WORKERS_DEFAULT`).
9. Extra pipe for the rate gate (see 6, problem 3), if the pipe option is chosen: spawn with a second bidirectional channel (fd 3 and 4).
10. Static serving details beyond "static file serving": `no-store` header control, content-type table, 307, SPA-style path fallbacks (done in the handler), and `Range` plus `Accept-Ranges` for audio (not required for parity). `cb_res_send` buffers the whole body, so a large media file is held in memory; fine for clips (about 48 KB per second of audio, so under 1 MB for a normal phrase).
11. HEAD: the router maps HEAD to GET with no body, so `HEAD /app.wasm` works for free. Node's server answers HEAD with whatever the handler says; parity check only.
12. Config surface is `CBASE_*` env; amgi's `PORT` and `.env.local` need a thin adapter in `serve_open` or a wrapper main (cbase main is `cb_process_main(&cb_provider_local, cb_main_app, argc, argv)`, so the product supplies only `cb_main_app`; to print its own line and map `PORT` before config load amgi needs a pre-config hook or a tiny wrapper that setenvs `CBASE_LISTEN` then calls `cb_process_main`). Also the exit code and signal handling (SIGTERM drains) are cbase's; fine.
13. Build: `cbase.mk` links OpenSSL and Homebrew SQLite on macOS (errors if Homebrew sqlite is missing) and uses `-Wall -Wextra -Werror -Wshadow -Wvla` on the product's C too. amgi's wasm build uses `-nostdlib` on separate sources and is unaffected; native server C must compile warning-clean. `sha1` for `mediaName` can come from OpenSSL (already linked) or a small C routine; cbase's `lib/sha256.c` is sha256 only (install manifest hashes can use it).
14. `make check` runs the platform's whole test machinery (compiler gate, unit tests, smokes) in the amgi tree, with `APP_TEST_ROOTS`. It needs `APP_SMOKES` pointing at a smoke that starts `build/cbase`. Fine but it makes `npm test` longer; decide whether it is wired into `npm test`.

## 5. In-process plusaudio and Anki calls the stage-1 server makes (the real problems)

Constraint recap: collection access and the Gemini client stay in Node scripts; C handlers spawn them and read output plus exit codes 3 and 4. Today only two calls are real scripts (`generate-clip.js`, `generate-card-text.js`). Everything else is in-process. Listed by severity.

1. Every collection operation (all of routes 1-8, 12-16, 20, plus half of 9, 10 and 21, and the `hasMedia`/`addMedia` inside 17-18) is an in-process call to `plusaudio/lib/collection` (`node:sqlite`) through `directClient.js` or an in-process `fetch` through `bridgeClient.js`. There is no script for them. Proposal: a new `plusaudio/collection-cli.js`, one subcommand per `ops` method, the whole of `resolveTransport` (settings in, probe, fallback, lock, backup) inside it, answering in a fixed layout. The cheapest layout is the wire answer itself: the script prints the finished `application/x-amgi-wire` message for the route's answer kind (it can call the existing `wire.wasm` via `ui/server/wire.mjs`, or take over `wire.mjs`'s role), and a distinct exit code for "not ready" with the mode. The C handler then relays bytes plus a status from the exit code, and needs no field-level work in stage 1. The request body goes in on stdin as the wire request bytes (needs stdin pipe, part of the committed pipe work) or as a file. JSON must not be introduced between C and the script; the script's own bridge hop remains the recorded JSON leaving item.
2. The backup ledger and the per-path serialization are process memory (3.4). A one-shot script per request breaks both: a full collection copy per mutating request, and false `locked` when two scripts open the file at once (the status poll racing a page fetch). Two possible answers: (a) one long-lived collection worker process that C spawns once and talks to over stdin/stdout frames (needs bidirectional pipes and a restart policy; keeps the ledger, the lock chain and also saves about 50 to 100 ms of Node start per request on a 1 s status poll); (b) one-shot scripts plus per-path serialization in C (a mutex map) plus a ledger persisted on disk beside the backups. Recommendation: (a), because it preserves the proven in-process semantics unchanged and is the smallest delta to a tested library. The committed "process spawn with pipes" is enough if it supports a child that outlives a request.
3. The rate gate (`sharedGate()` in `rateLimit.js:33` and `ipcGate.js serveGate`) is in-process and answers the scripts over Node's `fork` IPC channel. There is no IPC channel under a C spawn. Pull the gate into C: it is about 100 lines of pure logic (`rateGate.js`) with an injected clock and a seedable random source, and it fits amgi's single seedable random rule. The scripts need another way to ask it. Options: (a) loopback HTTP to a private route on the same C server, with a per-run token in the child's environment (`gateForThisProcess` becomes an http-backed gate; Node `fetch` is available; no extra spawn feature needed; keep the 2000 ms fail-open); (b) an extra pipe pair on the spawn (fd 3/4) with a fixed binary frame. Recommendation (a); it does not ask cbase for more spawn features, but it needs a route that is not reachable by a web page (bearer token, reject any request with an Origin header). The json-subprocess branch's binary IPC change becomes moot with either.
4. `audio.js` and `starterDeck.js` call `plusaudio/lib/audio-store` in-process (`mediaName`, `CLIP_EXTENSION`, `starterClipName`) and `plusaudio/lib/deck renderAudioReference`. `mediaName` is `plusaudio-` + first 20 hex of sha1(`v1\n<language>\n<text>`) + `.wav`; starter clips are the `.mp3` form. Pull into C: a few lines on OpenSSL or a small sha1. Test it against Node's output over the whole starter TSV plus mixed-script inputs (a difftest against `audio-store.js`). `renderAudioReference(name,'html')` is `<audio src="NAME"></audio>`; confirm the exact string in `deck.js` before porting.
5. `sideOrder.js` imports `hasNativeScript` and `usesNonLatinScript` from `plusaudio/lib/cardGeneration/cardText.ts` in-process (Node type stripping). `detectInputLanguage` runs before the card-text spawn (it sets `--input-language`), and `correctSwappedSides` runs after it and before any clip. Proposal for stage 1: move both into `generate-card-text.js` (it already has known, learning and input, and the model's output), so the script prints already-corrected text and, as today, drops the reading on a swap. The C handler then calls one script and the swap rule stays in the TypeScript owner. Stage 2 can port the script tables to C. The `sideOrder.test.js` suite then tests the script path.
6. `generateAndStoreClip` interleaves `ops.hasMedia`, the `generate-clip.js` spawn and `ops.addMedia`. Under problem 1 these are `collection-cli` subcommands called from C: `has-media NAME`, then the existing generate-clip spawn (C makes the temp directory, reads the file, removes it), then `add-media NAME` with the bytes on stdin. The `fresh` re-record path (new take stored under a hash-suffixed name) is inside `addMedia`.
7. `starterDeck.js` is a multi-step orchestration over ops (listNotetypes, createDeck, existingFieldValues, hasMedia, addMedia, addNote) plus `fieldIndexes` from `src/utils/amgiNotetype`, `existingKeySet` and `normalizeForDedupe` from `src/utils/lyricsParse`, and reading shipped mp3s. Round-tripping each op through a spawn would be 30 or more calls. Proposal: `POST /starter` is one `collection-cli starter-build` subcommand that runs the existing `buildStarterDeck` unchanged inside the worker; `GET /starter` is in C (TSV parse, file existence, the sha1 name from 4, the key check).
8. `install.js`: file work (copyTree, fileList, sha256 manifest, prune, the `process.cwd()` root) is pure fs and crypto. Pull into C (cbase has `lib/sha256.c`; needs readdir, copy file, unlink, mkdir -p: part of the "file ops" the C side needs, libc has them). The collection half (`collectionDrift`: listNotetypes with templates, readMedia; `installNotetypeDirect`: createNotetype with the media) stays in the worker: `collection-cli drift` and `create-notetype`, with the C side sending the shipped template bytes (or letting the script read them from the same root). `amgiNotetypeSpec` (field names, requirements) and `AMGI_NOTETYPE_NAME` live in `src/utils/amgiNotetype` and `install.js`; keep one owner, in the script.
9. `transport.js discoverProfiles` calls `defaultBaseDir` and `listProfiles` in-process. Small and fs-only: pull into C (route 11), with a difftest against `paths.js` for the three platforms (the platform and env are injectable in Node, so the test can compare). Needs `listProfiles`'s full rule read before porting.
10. `settings.js`, `respond.js MESSAGES`, `mediaType.js`, `rateLimit.js` message strings, `MISSING_KEY_MESSAGE` (`plusaudio/lib/geminiKey.js`), `INSTALLED_MESSAGE` and `RESTART_MESSAGE`: pure data and tiny logic that C must carry. Each string should have one owner. Suggest a generated C header from the Node source for the strings the scripts also print (`MISSING_KEY_MESSAGE`), or the other way round, enforced by a test, to avoid a double Band-Aid.
11. `serve.mjs` itself loads `.env.local` into the process environment and the scripts also load `plusaudio/.env`; both lookups must be preserved (problem list item for the C dotenv reader).
12. Media bytes for `GET /media/:filename` on the bridge transport come from `readMedia` over base64 JSON; on direct from the folder. Stage 1: the worker returns the bytes (`collection-cli media-read`), so no direct file path logic is duplicated in C. After stage 1, the direct case can move to C `sendfile`.
13. Test seams are in-process too: `src/test-helpers/fakeFork.js` and the `src/__tests__/server/*.test.js` suites call handlers with `Request` objects and `mock.module`. They do not exercise HTTP and cannot run against the C server (section 7).

## 6. What the C server and the Node pieces look like in stage 1

- C server (new): a cbase product. Routes: one prefix route per family (`/api/anki/*` plus the page and file routes), dispatching by a table that mirrors `ROUTES`. Decode request with `wire.c` natively (`wire_open`, `wire_room`, `wire_decode`), encode answers with `wire_encode`. wire.c is already freestanding C used by the page (`app.wasm`) and the native test dump, so there is no second implementation, which is the point.
- Node (kept, run by C): `plusaudio/generate-card-text.js`, `plusaudio/generate-clip.js`, new `plusaudio/collection-cli.js` (the transport, backup ledger, lock chain, bridge client, starter build, drift, createNotetype), all unchanged in policy.
- Node (retired from serving): `ui/server/serve.mjs`, `ui/server/wire.mjs`, `ui/server/hooks.mjs`, `src/server/api/**`, `rateLimit.js`, `plusaudioCli.js`, `sideOrder.js` (moved into the card-text script), `install.js` file half, `starterDeck.js` route glue. They stay alive on main until the C server passes every drive.
- Wire answer authorship: for collection routes the worker could write the finished wire bytes (via `wire.wasm`) and C relays them; or C re-encodes from a small fixed record. The first is least C code in stage 1 and keeps `wire.wasm`/`wire.mjs` in service; the second removes the wasm dependency. Open question for the PM.

## 7. Proposed repo layout, tests, and PR order

### 7.1 Layout (amgi repo)
```
cbase/                    submodule, alexsave/cbase pinned at a tag
server/
  Makefile                CBASE := ../cbase ; CBASE_PROVIDERS := local ;
                          APP_SRC_ROOTS := src ; APP_TEST_ROOTS := test ;
                          APP_INC := -Isrc -I../ui/wire ; APP_SERVE := amgi ;
                          APP_SMOKES := smoke_amgi ; APP_LIB_SRC := ../ui/wire/wire.c ;
                          include ../cbase/cbase.mk
  src/amgi_app.c          cb_main_app, the route table, the startup line, PORT and .env.local mapping
  src/route_*.c           one file per route family (status, decks, notes, install, media, starter, gen)
  src/settings.c, respond.c, mediatype.c, ratelimit.c (the gate), gatehttp.c (private gate route)
  src/proc_*.c            thin wrappers over cbase's spawn for the scripts
  test/unit_*.c, smoke_amgi.c
plusaudio/collection-cli.js   new
```
- `APP_LIB_SRC` carries `ui/wire/wire.c` so the layout has one definition. `wire.h`'s `wire_grow` is "supplied by the build": the server provides it with realloc.
- `npm start` becomes `ui/build.sh && make -C server && server/build/amgi` (keep `PORT`); `npm run e2e` starts `server/build/amgi` three times (any key, no key, fake Gemini) and keeps the `amgi on ` line.
- The `ui/build.sh` wasm build is untouched.

### 7.2 Tests
- Today's server suites are handler-level: `src/__tests__/server/{audio,cardText,deckRemoveRoute,directClient,install,installNotetype,installRoute,mediaRoute,mediaType,rateLimitRoute,settingsHeaders,sideOrder,starterDeck,starterPhrases}.test.js`, importing route modules with a built `Request`, plus `mock.module`. They cannot be pointed at an HTTP server unchanged.
- Plan: add an HTTP-level suite (`test/server/*.test.mjs`) that starts a server on `PORT=0` (Node impl or C impl, selected by an env var) and drives the same cases through the wire (using `ui/server/wire.mjs` to build requests and decode answers). Port each existing route test into it, running first against Node (must pass) and then against C (must pass): this is the compatibility proof. Keep the old handler-level tests for the code that stays in Node.
- Keep `ui/test/wire.test.mjs` (wire.wasm versus `wire_dump`) as is; add a native round trip for every kind in `server/test`.
- Rate gate: port `tests/server/plusaudio/rateGate.test.js` to C with a fixed seed and the injected clock; fixed-seed draw-sequence test per the repo's randomness rule; the C gate draws exactly once per acquire and per admissionWait.
- Differential tests (Node as oracle): `mediaName`/`starterClipName`, `parseStarterPhrases`, `detectInputLanguage` / `correctSwappedSides` (if ported later), `defaultBaseDir`, install manifest, `contentTypeFor`, `settings` percent-decoding, the `retry-after-ms=` parser.
- Exit-code tests with a fake script: a shell script that prints and exits 0, 1, 2, 3 (with and without a retry line), 4; stderr multi-line; spawn failure. Plus the existing `fake-gemini.js` helper for the full path through `generate-*.js`.
- Mutation-check each new test (repo rule).
- Browser drives: `ui/tools/e2e.sh` and `drives.sh` run unchanged except for the server command; they are the acceptance test. They need `ANKI_PYTHON_BIN` and `ANKI_FIXTURE_APKG`.
- Gate cbase's `make check` for the server tree in CI separately from `npm test` so a slow cbase gate does not slow the Node loop.

### 7.3 PR order, smallest first
1. Merge `origin/json-subprocess` (or rebase it onto main): card text layout and binary gate IPC. Prereq, in Node only.
2. HTTP-level test harness against the Node server, porting the route tests; no behaviour change.
3. Move `sideOrder` into `generate-card-text.js` and test it (Node only). Removes one in-process call.
4. `plusaudio/collection-cli.js` with the worker protocol, called by the Node server instead of in-process ops (Node routes talk to the worker): proves the worker/ledger/lock design with zero C. Measure latency of `/status`.
5. Bring in the `cbase/` submodule and `server/Makefile` with a hello-level `amgi_app.c` (health and the startup line), `make -C server check` in CI. Needs the free-port bind.
6. Static files and pages (`/`, `/decks`, app.wasm, app.css, icons, media content types). Needs static serving. The first drive (shell load) runs against C.
7. The pure-C routes: `GET /profiles`, `GET /starter`, and the settings/respond/error plumbing, with differential tests.
8. Worker-backed read routes: status, decks, deck summary, notes, field-values, notetypes, install GET. Needs spawn with pipes.
9. Worker-backed write routes: decks POST/PATCH/DELETE, notes POST/bulk/PATCH/DELETE, install POST (file half in C), starter POST.
10. Media route (bytes through the worker).
11. Generation: rate gate in C with its test and private gate route, spawn of the two scripts, exit-code mapping, `/card-text` and `/audio`.
12. Switch `npm start` and `e2e` to the C server; run the full drive set; delete `serve.mjs`, `wire.mjs`, `hooks.mjs`, `src/server/api/**` and dead tests. Update README ("The server is one plain Node HTTP server" and "JSON that remains").

## 8. Open questions

For the amgi PM:
1. Is the worker process (long-lived Node child holding the collection library, backup ledger and lock chain) acceptable as the stage-1 shape, or must stage 1 be one-shot scripts (which forces ledger persistence and C-side locking)? It changes which cbase features are used and the latency of `/status`.
2. Should the wire bytes be written by Node (`wire.wasm`) or by C in stage 1? It decides whether `wire.mjs` and `wire.wasm` survive stage 1.
3. Install and drift read `process.cwd()` for the add-on sources. Should the C server take an explicit `AMGI_ROOT` (and where do the sources live in a packaged app)? Is a packaged or installed build in scope for stage 1?
4. Loopback exposure: the C server inherits cbase's open CORS default and has no Host or Origin check; the Node server has no check either. Is tightening this part of stage 1 (same-origin only, reject foreign Host)? It affects tests and the drives.
5. Parity versus tightening: `field-values` accepts a missing param as 0, ids of 0 are "missing", bodies of any size up to the cbase cap. Reproduce the quirks exactly or fix them in the port?
6. Latency budget for `/status` polling and `/decks` (one query per deck) under process spawning, and the acceptable cold start of Node on the user's machine.
7. Should Range requests for media be added now (Safari audio), or kept for parity?
8. Is it acceptable that stage 1 requires Node on the user's machine exactly as today (yes by the constraints), and which Node version floor (`process.loadEnvFile`, `registerHooks`, type stripping imply recent)?
9. Where does the dotenv precedence live (C reads `.env.local`; the scripts read `plusaudio/.env`)? One owner?

For cbase:
1. A storeless (no SQLite file, no JWT secret, no admin) mode for the local provider, or the exact supported way to turn these off. Also: can `/health`, `/admin` and `/metrics` be left unregistered?
2. A product hook before config load (to map `PORT` and `.env.local` to `CBASE_*`), a way to print the product's own startup line, and a stable way to learn the bound port (the existing log line prints it after `cb_server_listen` reports it; confirm port 0 end to end).
3. CORS: a way to send no Access-Control headers, or none-by-default for a loopback product.
4. Spawn API shape: stdin write, stdout and stderr capture with caps, exit code and signal, env and cwd, kill on timeout, a child that outlives a request (the worker), restart policy, and orphan cleanup on server exit. The router already blocks a pool thread per request; is a blocking `cb_proc_run` acceptable, or will there be a non-blocking park/wake form? `REQ_WORKERS_DEFAULT` for long handlers.
5. Static serving: caching header control (`no-store`), a 307, per-file content type, and whether it can read from a directory root with traversal protection that amgi can reuse for media.
6. Path parameters in the router, or an official pattern for a prefix route that parses its own segments. Query parsing helpers exist (`cb_http_query_get`); percent-decoding of path segments does not (path is raw).
7. Whether cbase will provide a plain-HTTP loopback client with timeouts for stage 2 (the bridge), and a TLS client for Gemini (a gRPC/HTTP2 client would be stage 2 too; `ANSWER_FORMAT.md` measured over gRPC).
8. A tag to pin the submodule to, and whether `make check` for a product can be run without the client build (`CBASE_CLIENT_CHECK=0`) and without Homebrew sqlite/openssl on a user's Mac.
9. Windows: cbase is POSIX and `defaultBaseDir` handles Windows. Is Windows in scope for amgi's C server at all?
