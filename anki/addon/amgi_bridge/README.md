# amgi: bridge

Two things live in this one add-on, both about reaching a live Anki collection while Anki has it open:

1. **Fill missing audio** (`Tools > amgi: Fill missing audio...`) - adds audio straight into your live collection.
   No exporting a `.apkg`, running a script, and importing the result back.
   Pick a deck, tell it which field to read and which field to write the clip into, and it fills in whatever is missing.
2. **A local HTTP bridge** (`Tools > amgi: Bridge status...`) - lets the amgi web UI read and write this same collection while Anki is running, the same way it reads and writes a closed collection's file directly (`plusaudio/lib/collection/`) when Anki is closed.
   Off by default; see "Local HTTP bridge" below for what it does and its security model.

This add-on used to be called `amgi_audio` and only did the first of these.
It was renamed when the second was added, since "audio" stopped describing what it does; every reference to the old name (paths, the package id, imports) was updated along with it - there is no `amgi_audio` left anywhere in this repo.

This is a separate add-on from `../amgi_mic/`, installed on its own.
The two do unrelated jobs with unrelated risk: `amgi_mic` is passive infrastructure that answers one Qt permission request and touches no collection data.
This add-on has menu items, makes network calls (for audio generation) and a local HTTP listener (for the bridge), and edits notes.
Bundling them would mean a user who only wants the microphone permission - the common case on a machine without an amgi account - installing something that phones home and listens on a port, and a user who only wants their audio filled in installing something that asks for their microphone.
`amgi_mic`'s own README promises it is short enough to read in full.
Folding this add-on's jobs into it would break that promise for no reason, since Anki add-ons are already the unit both `Tools > Add-ons` and AnkiWeb manage independently.

## What it does

1. Tools > amgi: Fill missing audio... opens a dialog.
2. Pick a deck, which field to read aloud, which field to write the clip into, the language, and which reference form to write (see below).
3. It finds every note in that deck (subdecks included) missing this tool's own audio for its current text, generates it, and writes it in.

That's it.
It does not create notes, does not touch any field but the one you pointed it at, and does not touch scheduling, `revlog`, note types or decks.

## What it does not touch

- Any field except the one you name as the audio field.
- A reference in that field it did not write itself - the deck author's own recording, someone else's `[sound:...]` tag, an `<img>` in the same field - is left exactly where it is.
  Only this tool's own generated clip is ever added, replaced or removed.
- A note whose text has not changed since this tool last filled it in.
  Clip filenames are content hashes of the text (see "Idempotency" below), so a note already carrying the right one is skipped, not touched.
- Anything outside the deck you picked.

## Install

This add-on generates audio on your own machine, with your own OpenAI key.
There is no amgi account, no hosted service, and no quota but your own OpenAI account's - see
"Generation: local, not the edge function" below for why, and for what this used to depend on that
it no longer does.

That does mean it needs a few things a purely-installed add-on would not:

- **Node.js**, to run the same generator `plusaudio/` uses.
  This is a real install step, not a nicety: if you do not already have Node, get it from
  [nodejs.org](https://nodejs.org) first.
- **A checkout of [this repo](https://github.com/alexsave/amgi)**, so `plusaudio/generate-clip.js`
  and the shared generation policy it runs exist on disk somewhere.
- **An OpenAI API key**, in the environment, in `plusaudio/.env`, or pasted into this add-on's own
  config (see below).

1. Copy the `amgi_bridge` folder into your Anki add-ons folder (Tools > Add-ons > View Files puts you in the right place), then restart Anki.
2. Tools > Add-ons, select amgi_bridge, click Config, and set `plusaudio_dir` to the `plusaudio` folder of your checkout.
   Set `node_path` too if `node` is not on the `PATH` Anki itself runs with, and `openai_api_key` if you are not already setting `OPENAI_API_KEY` some other way.
   See `config.md` (shown next to the config editor) for all three, in the order they are checked.
3. Tools > amgi: Fill missing audio...

If any of the above is missing or misconfigured, this add-on says so before a run starts - a message
naming what to fix, not a stack trace partway through your deck.

## Field mapping

You choose two fields per run, by name:

- **Read this field aloud** - the field holding the text to speak.
  HTML markup and any existing `[sound:...]`/`<audio>` tag in it are stripped before it is sent for generation.
- **Write the clip into** - the field the generated clip is added to.

They must be different fields.
If your deck mixes note types, the dialog offers every field name used by any of them; a note whose type lacks one of the two chosen names is skipped, not guessed at or overwritten.

## Which reference to write

Same choice, and the same two forms, as `plusaudio`'s `--audio-tag` (see [`../../plusaudio/README.md`](../../plusaudio/README.md), "Which reference to write"):

- `sound` (default) - `[sound:clip.mp3]`.
  Works everywhere, Anki plays it with its own player, `R` replays it.
- `html` - `<audio src="clip.mp3"></audio>`.
  What the review-loop note type in [`../../notetype/`](../notetype/README.md) needs to sequence its own playback; Anki strips a bare `[sound:]` tag out of the page before the template's JavaScript ever sees it.

Re-running with the other form converts a note without regenerating its audio: the clip is a content hash of the text, so only the reference changes.

## Relation to `plusaudio/`

Same generation policy, same clip-naming scheme, two different situations:

- **`plusaudio/`** edits a `.apkg` file.
  Use it for a deck you are going to share, or one you cannot open directly - someone else's deck, or a shared collection you do not have Anki open against right now.
  You export, run it, and import the result back.
- **This add-on** edits your own open collection directly, through Anki itself.
  Use it for your own live deck, when you have Anki open.
  No export, no import, and Anki's own GUID matching, scheduling and undo history are never in question because Anki is the one doing the writing.

They stay interchangeable on the same deck: `plusaudio` and this add-on name a clip the same way (`plusaudio-<hash of profile, language, text>.mp3`, from `plusaudio/lib/audio-store.js`, ported for Python in `deck_text.py`), so a deck touched by one and then the other treats the other's clips as already done rather than regenerating them.

## Idempotency and cancellation

A clip's filename is a hash of the generation profile, the language, and the exact text.
If the text has not changed since this tool last filled it in, the note already points at the file this run would produce, so plan_fill (`core.py`) leaves it alone.
Running the whole thing twice in a row does nothing the second time; this is checked in `test/test_core_collection.py` against a real collection.

A note's field is only changed after its clip has already been generated and written into the collection's media folder.
The collection's database itself is not touched until the very end of a run, in a single write covering every note finished so far.
See `core.apply_fill`'s docstring for why, and `test_core_collection.py`'s cancellation test for what a cancelled run leaves behind: the notes done so far, committed; the rest, simply not started yet, and picked back up the same way on the next run.

## Generation: local, not the edge function

The generation policy - prompts, the TTS voice instructions, the transcribe-then-judge validation loop - lives in exactly one place, `supabase/functions/_shared/cardGeneration.ts`, and this add-on does not get a second copy of it in Python.
It is Python, so it cannot `require()` that TypeScript module the way `plusaudio/lib/generator.js` does.
Instead `generator.py` shells out to `plusaudio/generate-clip.js`, a small Node entry point built for exactly this - text and a language in, one clip written to a file, over a documented contract (see that file's own top-of-file comment) - which in turn calls the same shared generator `plusaudio/add-audio.js` uses.

That contract is the seam `core.apply_fill` depends on: it takes any `fetch_audio(text) -> bytes` callable (see `generator.AudioGenerator`), so it has no idea, and does not need one, that the other end is a subprocess.

This add-on used to call a deployed `cards` edge function over HTTPS instead, signed in with an amgi account's email and password stored in this add-on's own config.
That is gone.
Generating locally, against your own OpenAI key, removes a real liability - an amgi account's password sitting in plaintext in an Anki add-on's config file - and removes the amgi account, the hosted quota, and the network dependency on Supabase entirely.
The only network call this add-on makes now is the one `plusaudio/generate-clip.js` makes to OpenAI, from your own machine, with your own key.

The tradeoff is Node and a repo checkout become real requirements, not optional ones - see "Install" above.
That was the whole reason the edge-function version existed in the first place: everyone who could already use the amgi web app had what it needed and nothing else.
That reasoning no longer applies now that reaching into a live collection with no amgi account at all is the point.

## Local HTTP bridge

amgi is moving to local-first: the React UI stays as a visual deck builder, and reviewing and editing happen against a local Anki collection instead of Supabase.
When Anki is closed, the UI reaches the collection file directly, through `plusaudio/lib/collection/` (Node, no Anki install required - see that folder's own `index.js`).
When Anki is open, the collection file is locked in `locking_mode=exclusive` and cannot even be read from outside the Anki process (see `plusaudio/lib/collection/open.js`'s module comment for the experiments that pinned that down), so the only way in is from inside Anki itself.
That is what this bridge is: a small local HTTP server, run by this add-on, that the UI can talk to instead of the file, picking whichever transport is available and otherwise not caring which one it is using.

### What it exposes

One endpoint per capability the Node layer exposes, deliberately matching its vocabulary so the two are interchangeable (see "Cross-transport parity" below):

| Method & path | Node equivalent (`plusaudio/lib/collection/index.js`) | Notes |
| --- | --- | --- |
| `GET /status` | `Collection.status()` | Works even with no collection open (`collectionOpen: false`) - the whole point of a status endpoint. Also reports the Anki and Qt versions and the open profile's name, which Node's file-based `status()` has no way to know. |
| `GET /decks` | `Collection.listDecks()` | |
| `GET /notetypes` | `Collection.listNotetypes()` | |
| `GET /decks/:id/notes?offset=&limit=` | `Collection.listNotesInDeck(id, {offset, limit})` | Response is `{notes, total, offset, limit}`; Node's returns the array alone. The bridge adds a total count because the UI needs one to build pager controls, and Node's caller can just page until a short page instead. |
| `POST /decks` `{name}` | `Collection.createDeck(name)` | Creates missing `::` ancestors; returns the existing deck (`created: false`) on a name match rather than duplicating - see `bridge_ops.create_deck`'s docstring for why this matches even Anki's own real Unicode case-folding, not just the ASCII approximation `decks.js`'s own module comment documents as a known gap on the Node side. |
| `POST /notes` `{deckId, notetypeId, fields, tags}` | `Collection.addNote({deckId, notetypeId, fields, tags})` | |
| `PATCH /notes/:id` `{fields}` | `Collection.updateNote(id, fields)` | Never touches tags or regenerates cards, on either side. |
| `POST /media` `{filename, dataBase64}` | `Collection.addMedia(filename, data)` | Body carries the file as base64 since JSON has no binary type; response is `{filename}`, the name Anki (or Node) actually stored it under. |

Every response body is the bare JSON payload above (or `{"error": "..."}` with a 4xx/5xx status on failure).
There is no `{status: 'ok', result}` envelope the way the Node layer's functions return internally, since HTTP's own status code already carries that.

The one deliberate behavioural difference worth calling out beyond the table: **every mutation here goes through Anki's own API** (`col.decks.id_for_name`/`add_deck_legacy`, `col.add_note`, `col.update_note`, `col.media.write_data`) rather than hand-rolled SQL.
`plusaudio/lib/collection/` computes `usn`, `mod`, `sfld` and `csum` itself because it is talking to a *closed* file with nothing else to do that bookkeeping.
In-process, Anki already holds the pen, so `bridge_ops.py` never touches a byte Anki's own engine didn't write.
See `bridge_ops.py`'s module docstring and each function's own docstring for the specifics.

### Turning it on

Off by default (`bridge_enabled: false`).
`Tools > amgi: Bridge status...` shows whether it is listening, on what port, and its token, and has a checkbox that turns it on or off immediately, with no restart needed.
See `config.md`, "Local HTTP bridge settings", for the underlying config keys (`bridge_enabled`, `bridge_port`, `bridge_token`, `bridge_allowed_origins`) if you would rather edit them directly.
Paste the token and port shown there into the amgi web UI's own local-bridge settings.

### Security model and threat model

This is the part that matters most, because a listening socket on your machine is reachable from **any tab your browser has open**, not just the amgi UI.
See `bridge_auth.py`'s own module docstring for the full mechanical explanation this section summarizes.

**What any webpage can do, unmodified:**

- Point `fetch()` (or an `<img>`/`<form>` tag, for the small set of "simple" requests those can make) at `http://127.0.0.1:<port>/...`.
- That request reaches this server and gets *processed* even if the page's own JavaScript is never allowed to read the response.
  CORS governs who can read a response, not whether the server runs the request.
  Believing otherwise is the single most common mistake in this space, which is why every constraint below assumes a hostile page can always get a request sent.
- A "simple" request (GET, or POST with `Content-Type: text/plain`/`application/x-www-form-urlencoded`/`multipart/form-data`, and no extra headers) skips the CORS preflight (`OPTIONS`) entirely; the browser just sends it.
  Anything gated only by "the browser will preflight it first" is not actually gated.

**What stops it from doing anything useful here:**

1. **127.0.0.1 only, never `0.0.0.0`.**
   `bridge_server.BridgeServer` hardcodes the bind host; there is no config key, argument, or code path that can widen it to another interface.
   A machine on the same network, not just the same browser, cannot reach this at all.
2. **A shared-secret token on every request.**
   Generated locally on first run (`secrets.token_urlsafe(32)`, never hard-coded, never transmitted anywhere but checked against what a caller supplies), shown in `Tools > amgi: Bridge status...`, and required on an `X-Amgi-Bridge-Token` header for every route.
   A custom header is exactly what forces a real cross-origin request out of "simple" territory and into a preflight, so requiring one closes the "simple request, no preflight" gap directly: a hostile page's `fetch()` cannot add this header without triggering a preflight, and a request that omits the header to stay "simple" fails the token check instead.
   The comparison itself uses `hmac.compare_digest`, not `==`, so it does not leak the token one byte at a time through a timing side-channel.
3. **An `Origin` allowlist, checked server-side, not left to the browser's CORS enforcement.**
   A cross-origin `fetch()` always sets `Origin` (that is what makes it cross-origin), so a hostile page's request always has one to check; the bridge rejects any request whose `Origin` is not in `bridge_allowed_origins`, before running anything, independent of whether the token is also right.
   `Access-Control-Allow-Origin` is only ever echoed back for an origin that already passed this check, never `*`, and never for one that failed.
4. **Off unless explicitly enabled**, and always visible.
   `Tools > amgi: Bridge status...` shows whether it is running and lets the user turn it off in one click.
   A user who never opts in is never listening.

**What this does *not* defend against**, so it is not mistaken for something it isn't:

- Another process or user *on the same machine* that can read Anki's own add-on config file (where the token lives) or connect to `127.0.0.1` directly.
  Anything with that level of access to the machine already has access to the collection file itself; this bridge does not attempt to raise the bar above "same machine, same user account".
- A browser extension with broad host permissions, which can read responses CORS would otherwise hide and can often read local files (including the config file) outright.
  This is a browser-security problem, not one an HTTP server can solve from its side of the socket.
- The token leaking - screen-shared while the status dialog is open, copied into a misconfigured client that logs headers.
  Treat it like any other locally-stored shared secret: regenerate by clearing `bridge_token` in config and restarting the bridge if you suspect this happened.

### Main-thread dispatch

`bridge_server.py` never touches `mw.col`, `mw`, or any Qt object.
The HTTP listener runs on whatever thread `ThreadingHTTPServer` spins up per connection, and that file has no `aqt` import at all to make the mistake even possible.
Every request is handled by a `dispatcher` object (`bridge_dispatch.AqtBridgeDispatcher` in production, a plain fake in `test/test_bridge_server.py`) whose methods hand the actual work to Anki's own operation queue: `aqt.operations.QueryOp` for reads, `aqt.operations.CollectionOp` for writes that should produce a real undo step and fire Anki's own change hooks, so the browser, deck list and editor all notice a note or deck the bridge just touched, the same as if it came from Anki's UI.
Each dispatch then blocks the calling (HTTP) thread on a plain `threading.Event` until Anki calls back with a result.
See `bridge_dispatch.py`'s own module docstring for exactly which operations use which, and why `add_media` uses `QueryOp`: it touches the media folder, not the undo-tracked collection database, and `QueryOp`'s own docstring names "adding/deleting files" as exactly its other intended use.

### Cross-transport parity

`test/test_cross_transport.py` is the test that actually matters for "the UI can pick either transport and not care": it runs the Node layer and this bridge's `bridge_ops.py` against the *same* collection file, one after the other, and asserts they agree.
A deck one side creates is recognised, not duplicated, by the other; a note one side adds is read back correctly, with the same fields, tags and note type id, by the other's own reader.
An assertion that only one side agrees with its own writer would prove nothing about that interchangeability - this is what actually pins it down.
See that file's own module docstring for the full reasoning, and "Testing" below for how to run it.

## Testing

### What is actually verified

`test/test_deck_text.py`, `test/test_core_config.py`, `test/test_generator.py`, `test/test_bridge_auth.py` and `test/test_bridge_server.py` need no `anki` pip package and no network.
`pnpm test` runs them.

- `test_deck_text.py` checks `deck_text.py` against `plusaudio/lib/deck.js` and `audio-store.js` themselves, by shelling out to Node on the same inputs and asserting equality - not against a second, hand-written idea of what those functions do.
- `test_generator.py` checks the subprocess seam - the command built, the environment passed through, exit-code and stderr handling, temp-file cleanup, and the actionable errors for a missing Node, a missing repo checkout, and a missing API key - by mocking `subprocess.run`.
  There is no OpenAI API key available to these tests, and live calls are not authorised; mocking at the transport boundary is what "keep the seam narrow enough to mock" (see the top of `generator.py`) means in practice.
  `../../plusaudio/test/generate-clip.test.js` checks the other side of the same contract from Node, with a stubbed generator - also never a real OpenAI client.
- `test_core_config.py` checks `AudioFillConfig`'s own validation.
- `test_bridge_auth.py` checks the token and Origin logic (`bridge_auth.py`) as plain functions: valid token and allowed origin succeeds; a missing or wrong token fails; a foreign origin fails, even with the right token; a "simple" request shaped so a browser would never preflight it still fails, because it cannot carry the token header without losing its "simple" status.
- `test_bridge_server.py` proves the same claims again, against a real listening socket and a real `http.client` connection, plus routing (every endpoint in the table above), request/response JSON shapes, and error-status mapping (`ValueError` to 400, `BridgeBusy` to 503, anything else to 500) - all against a fake dispatcher, so none of it needs Anki or Qt.

`test/test_core_collection.py` runs `core.plan_fill`/`core.apply_fill` against a REAL `anki.collection.Collection`: real notes, real `Note.__setitem__`, real `col.media.add_file`/`write_data`/`check()`.
It proves: a note gets its clip and reference written and nothing else in the field disturbed; `col.media.check()` reports the clip used and nothing missing; a second run changes nothing; editing the text regenerates and leaves exactly one owned reference; switching `--audio-tag` converts without regenerating; a note missing the mapped field is skipped, not crashed on; a failed generation is retried on the next run rather than losing the note; and a cancelled run commits the notes finished so far and leaves the rest for next time.
One class of that file runs against a hand-built fixture.
Another (`SampleDeckTests`, gated on the `AMGI_SAMPLE_APKG` environment variable) runs the same checks against a real 333-note shared deck with the deck author's own `[sound:]` tags and `<img>` tags already in the audio field, confirming those are left alone.

`test/test_bridge_ops.py` is the same style of test for the bridge side: every function in `bridge_ops.py` (`status`, `list_decks`, `list_notetypes`, `create_deck`, `add_note`, `update_note`, `list_notes_in_deck`, `add_media`) against a REAL `anki.collection.Collection`.
Its pagination test adds 2,500 notes to one deck and pages through all of them in fixed-size batches, checking every note is returned exactly once and the total count is right on every page - proving the SQL `LIMIT`/`OFFSET` path is what actually runs, not something that loads the whole deck and slices it in Python, which is what "must not choke on a 20k-note collection" requires in practice.
Its own `SampleDeckTests` (also gated on `AMGI_SAMPLE_APKG`) pages through the same real 333-note deck and checks every note's note type is one `list_notetypes` also reports, with non-empty field names.

`test/test_cross_transport.py` is the one described above in "Cross-transport parity": it needs both `anki` and a `node` on `PATH`, and runs the Node layer and `bridge_ops.py` against the same collection file, checking they agree.

None of these three are wired into `pnpm test`: the `anki` pip package is a large, Rust-backed wheel this repo does not otherwise depend on, and `pnpm test` has to pass on a plain checkout with no Python environment at all.
Run them with a Python that has `anki` installed:

```bash
python -m venv anki-test-env
anki-test-env/bin/pip install anki
cd anki/addon/amgi_bridge   # see "A namespace collision worth knowing about" below - the cd matters
AMGI_SAMPLE_APKG=/path/to/a/real.apkg anki-test-env/bin/python -m unittest discover -s test -p "test_core_collection.py" -v
AMGI_SAMPLE_APKG=/path/to/a/real.apkg anki-test-env/bin/python -m unittest discover -s test -p "test_bridge_ops.py" -v
anki-test-env/bin/python -m unittest discover -s test -p "test_cross_transport.py" -v
```

### A namespace collision worth knowing about

The real `anki` pip package ships with no `__init__.py` at its top level - it is an implicit [namespace package](https://peps.python.org/pep-0420/) - and so is this repo's own top-level `anki/` directory, which holds this add-on, the review-loop note type, and their own JS/CSS assets, and has nothing to do with the pip package.
If both end up on `sys.path` at once and the *repo root* is also on `sys.path` (which happens by default for a plain `python -c`, `python -m module`, or `python script.py` run with the repo root as the working directory), Python merges the two into one `anki` namespace: `import anki` then resolves against both directories at once.

For any name the pip package actually defines (`anki.media`, `anki.collection`, ...), the real module wins - that part of PEP 420 favours a genuine module over a bare namespace directory - so this has not caused a wrong answer here.
But it is fragile: it would only take a stray top-level `anki/<name>.py` appearing in this repo, sharing a name the pip package uses, to have the repo's own file silently shadow the real one for anyone who happens to also have `anki` installed and runs Python from the repo root.

Every test file under `test/` avoids the whole question by adding this add-on's own directory to `sys.path` and importing its modules directly (`import core`, `import deck_text`, `import generator`) rather than through any `anki.*` path - the same way Anki's own add-on loader imports them, which never goes through a path named `anki` at all (an installed add-on is `amgi_bridge`, full stop; see manifest.json's `package` key).
Running `python -m unittest` from this directory, as the commands above do, keeps the repo root off `sys.path` in the first place.

## What is unverified

`__init__.py`, `dialogs.py` and `bridge_dispatch.py` import `aqt`, which needs a working Qt installation this environment does not have (only the pure `anki` package could be installed here, not `aqt`).
Everything in them is written to the operations API modern Anki add-ons use (`aqt.operations.CollectionOp`, `QueryOp`, `.with_progress()`, `mw.progress.want_cancel()`, `mw.taskman.run_on_main()`), but none of it has run inside real Anki.
To check it:

1. **The menu item and dialog appear and populate correctly.**
   Install the add-on, open a profile with at least one deck of notes, and confirm Tools > amgi: Fill missing audio... opens, the deck combo lists your decks, and picking a deck fills the two field combos with that deck's note types' field names.

2. **The run actually happens as one undoable step.**
   Run it on a small test deck, confirm the notes are updated, then Edit > Undo once and confirm every note the run touched reverts together, not one at a time.

3. **Progress and cancellation.**
   Run it on a deck large enough to take a few seconds, confirm the progress dialog shows a note's text and a moving count, and that clicking its cancel button stops the run, leaves the notes done so far updated, and that running it again finishes the rest without redoing them.

4. **The `CollectionOp` / `QueryOp` API shape itself.**
   This was written against the operations API's documented shape as of Anki 2.1.45+, but its exact keyword arguments (`.with_progress(label=...)` in particular) have not been checked against the installed Anki version's `aqt/operations/__init__.py`.
   If the dialog or the run raises a `TypeError` about an unexpected keyword, that file is the first place to look.

5. **`generate-clip.js` against a real OpenAI key.**
   `test_generator.py` proves the command this add-on builds and the way it handles the result are correct; `generate-clip.test.js` proves the Node side of the same contract. Neither proves a real OpenAI account accepts the request, because there is no API key available to test against here.
   To check: set `OPENAI_API_KEY` (or `plusaudio/.env`), configure `plusaudio_dir` in this add-on, run it on a small test deck, and confirm a clip comes back and plays.

6. **The bridge actually starts, stops, and is reachable from a browser.**
   `bridge_server.py` and `bridge_ops.py` are proven directly (see "Testing" above); what is not proven without Qt is the wiring around them in `__init__.py` and `bridge_dispatch.py`.
   To check: enable the bridge in `Tools > amgi: Bridge status...`, confirm the dialog reports a port and the checkbox stays checked, then from a browser console on a page served from an allowed origin (for example `http://localhost:3000`), run
   ```js
   fetch("http://127.0.0.1:8798/status", { headers: { "X-Amgi-Bridge-Token": "<paste the token>" } }).then(r => r.json()).then(console.log)
   ```
   and confirm it returns `{"collectionOpen": true, ...}`. From a page on a *different* origin, confirm the same call fails.

7. **The bridge tears down and reopens cleanly across a profile switch.**
   Enable the bridge, switch to a different Anki profile (`File > Switch Profile`), and confirm `Tools > amgi: Bridge status...` shows "Not running" until it is enabled again for that profile - `gui_hooks.profile_will_close` is what is supposed to make this happen (`_stop_bridge` in `__init__.py`), and has not run inside real Anki.

8. **A write through the bridge shows up in Anki's own UI immediately.**
   With the Browse window or the deck list open, add a note or create a deck through the bridge (via the `fetch()` snippet above, or the amgi UI once it is wired up) and confirm it appears without needing a manual refresh - this is what routing writes through `CollectionOp` rather than a bare `col` call is supposed to buy, per `bridge_dispatch.py`'s module docstring, and has not been checked against a real `aqt.operations` implementation.

9. **A port already in use is reported clearly, not silently.**
   Start two Anki profiles with the bridge enabled at the same `bridge_port`, or occupy the configured port with `nc -l 8798` first, and confirm the second one to start shows the `showWarning` message in `_start_bridge_if_enabled` (`__init__.py`) rather than crashing or failing silently.

## What v2 would need

Adding new notes, not just filling in audio for ones that exist.
Given this add-on already has a live `Collection`, most of what made that hard before is gone:

- **Anki does the writing.** `col.new_note(notetype)` / `col.add_note(note, deck_id)` are the same shape `apply_fill` already uses for `update_note` - no GUID minting, no card creation math (Anki creates a note's cards itself from its note type's templates), no revlog to leave alone because there is none yet for a new card.
- **What is actually new work**: a source of terms (the missing piece `plusaudio/README.md`'s own "What this is not" section already names - "it needs a source of terms... not a different generator"), and a new Node entry point alongside `generate-clip.js` for `cardGeneration.ts`'s text-generation path (`generateCardText`, not just `generateCardAudio`), since writing a new note needs both sides' text, not just a clip for text that already exists.
- **The dialog** would grow an input for what to generate cards *about*, or a way to point at a word list, in place of - or alongside - the deck+field picker this version has.
- **Duplicate handling** the CLI tools never had to consider: Anki's own `col.find_dupes` / note-duplicate detection is not currently called anywhere in `core.py`, and a v2 that creates notes should use it before adding one, since nothing here currently stops the same term being generated twice into the same deck.
