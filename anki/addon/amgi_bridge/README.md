# amgi: bridge

This add-on is part of amgi and runs inside Anki; it is licensed with the rest of amgi under the GNU Affero General Public License, version 3 or later (see LICENSE at the repository root).

Two things live in this one add-on, both about reaching a live Anki collection while Anki has it open:

1. **A local HTTP bridge** (`Tools > amgi: Bridge status...`) - lets the amgi web UI read and write the collection while Anki is running, the same way it reads and writes a closed collection's file directly (the server's `server/collection/`) when Anki is closed.
   Off by default; see "Local HTTP bridge" below for what it does and its security model.
2. **amgi's note type** - `amgi Listening` is installed into the collection when a profile opens (`notetype.py`), together with the review-loop script it plays audio with.

Audio is filled by the amgi app, and works on a live collection through the bridge: the deck page's "Fill" line, or `amgi audio fill --deck NAME` on the command line (`skills/amgi/SKILL.md`).

This is a separate add-on from `../amgi_mic/`, installed on its own.
The two do unrelated jobs with unrelated risk: `amgi_mic` is passive infrastructure that answers one Qt permission request and touches no collection data.
This add-on has a local HTTP listener (for the bridge) and edits notes.
`amgi_mic`'s own README promises it is short enough to read in full.
Folding this add-on's jobs into it would break that promise for no reason, since Anki add-ons are already the unit both `Tools > Add-ons` and AnkiWeb manage independently.

## Fill missing audio

Open the deck page in amgi and use its "Fill" line, or run `server/build/amgi audio fill --deck NAME`.
Both write only the audio field, and only where a clip is missing or no longer matches the text.
A reference in that field that amgi did not write - the deck author's own recording, someone else's `[sound:...]` tag, an `<img>` - stays exactly where it is.
Clip filenames are content hashes of the text, so a note already carrying the right clip is skipped, and running a fill twice does nothing the second time.

## Install

1. Copy the `amgi_bridge` folder into your Anki add-ons folder (Tools > Add-ons > View Files puts you in the right place), then restart Anki.
   The amgi app's Install button does this for you.
2. Tools > amgi: Bridge status... to turn the bridge on (see "Turning it on" below).

## Local HTTP bridge

amgi is local-first: its web UI is a visual deck builder, and reviewing and editing happen against a local Anki collection instead of a hosted backend.
When Anki is closed, the UI reaches the collection file directly, through the server's collection code (`server/collection/`, C, no Anki install required).
When Anki is open, it holds the collection in `locking_mode=exclusive`, so the only way in is from inside Anki itself.
Outside Anki, amgi's server never lets SQLite open a collection that has a `-wal` or a `-shm` beside it (it reports it locked, and checks again right after its own open), nor one without SQLite's header (damaged), and it never asks for a checkpoint (`server/collection/db.c`, `collection_openable`).
The reason is that Anki's backup on close drops its exclusive lock while its `-wal` is still live, and a checkpoint from a second connection then resets that `-wal` (the incident of 2026-11-08, `docs/INCIDENT_1842.md`; the full rule is in `skills/amgi/references/collection-internals.md`, "Locking").
That is what this bridge is: a small local HTTP server, run by this add-on, that the UI can talk to instead of the file, picking whichever transport is available and otherwise not caring which one it is using.

### What it exposes

One endpoint per capability the server's collection core exposes, deliberately matching its vocabulary so the two are interchangeable (see "Cross-transport parity" below).
The bodies are not JSON: every request body and every answer is a message in amgi's wire format (`ui/wire/wire.h`), `Content-Type: application/x-amgi-wire`.
The shapes below are its fields, by name; the layouts themselves are written down once, in `ui/wire/wire.c`'s schema table (the `b_*` kinds and the request kinds `q_deck_name`, `q_note`, `q_notes`, `q_note_update`).
`ui/build.sh` writes that table into this add-on as `wire_schema.py`, and `bridge_wire.py` reads and writes messages with it, so the add-on holds no layout of its own.

| Method & path | Direct equivalent (`server/collection/collection.h`) | Notes |

| Method & path | Direct equivalent (`server/collection/collection.h`) | Notes |
| --- | --- | --- |
| `GET /status` | `Collection.status()` | Works even with no collection open (`collectionOpen: false`) - the whole point of a status endpoint. Also reports the Anki and Qt versions and the open profile's name. |
| `GET /decks` | `Collection.listDecks()` | Each row is `{id, name, known, learning}`: the deck's language pair (protocol 3), read from the deck's own `amgiLanguages` key, a string `"<known> <learning>"`; `""` and `""` when it holds none or anything else. |
| `GET /notetypes` | `Collection.listNotetypes()` | |
| `GET /decks/:id/notes?offset=&limit=` | `Collection.listNotesInDeck(id, {offset, limit})` | Response is `{notes, total, offset, limit}`. The total count is for the UI's pager controls. |
| `GET /decks/:id/notes/field-values?notetypeId=&fieldIndex=` | `Collection.listFieldValuesInDeck(id, notetypeId, fieldIndex)` | One field's raw value for every note of that note type already in the deck - what the bulk-add-from-paste screen checks a pasted line against before writing it. Response is `{values: string[]}`. |
| `POST /decks` `{name}` | `Collection.createDeck(name)` | Creates missing `::` ancestors; returns the existing deck (`created: false`) on a name match rather than duplicating - see `bridge_ops.create_deck`'s docstring for why this matches even Anki's own real Unicode case-folding. |
| `POST /notes` `{deckId, notetypeId, fields, tags}` | `Collection.addNote({deckId, notetypeId, fields, tags})` | |
| `POST /notes/bulk` `{notes: [{deckId, notetypeId, fields, tags, language, learningFieldIndex}, ...]}` | the C core's `addNotesBulk`-shaped loop | The bulk-add-from-paste screen's write path. Runs as one `CollectionOp` on the bridge side (see `bridge_ops.add_notes_bulk`) rather than one per note, so a 60-line paste produces one undo step and one UI refresh instead of 60. Response is `{results: [{ok, noteId, guid, cardIds, warning?} \| {ok: false, error}, ...]}`, one entry per note in the same order, so one bad line never aborts the rest of the batch. |
| `GET /notes/:id` | `Collection.getNote(id)` | One note, as `listNotesInDeck` lists it: `{id, notetypeId, fields, tags}`. A note that is not there is a 404 (protocol 2 added this route). |
| `PATCH /notes/:id` `{fields}` | `Collection.updateNote(id, fields)` | Never touches tags or regenerates cards, on either side. |
| `DELETE /notes/:id` | `Collection.removeNote(id)` | Through `col.remove_notes`: the note, its cards, and their graves. Response is `{noteId, cardsRemoved}`. |
| `PUT /decks/:id/languages` `{known, learning}` | `Collection.setDeckLanguages(id, known, learning)` | Sets `deck["amgiLanguages"] = "<known> <learning>"` through `col.decks.update_dict` (what `col.decks.save` calls for a deck dict, but it hands back the `OpChanges` a `CollectionOp` needs), as one undo step. Response is `{id, known, learning}`; an unknown deck is a 404. The server checks the codes, the add-on only stores them (protocol 3 added this route). |
| `PATCH /decks/:id` `{name}` | `Collection.renameDeck(id, name)` | Through `col.decks.rename`, subdecks included. Response is `{id, name}`; an unknown deck is a 404. |
| `GET /decks/:id` | `Collection.deckRemovalSummary(id)` | What deleting the deck would take, changing nothing: `{id, name, subdecks, cards, notes}`. The cards are those in its normal decks or borrowed from them by a filtered deck; the notes are those left with no card. A deck that is not there is a 404. |
| `DELETE /decks/:id` | `Collection.removeDeck(id)` | Through `col.decks.remove`: the deck, its subdecks, their cards, the notes left with no card, a filtered subdeck's borrowed cards sent home, and graves for every deletion, as one undo step. Response is `{id, name, decks, cards, notes}`. The Default deck (id 1) is a 400, since Anki would only empty it; a deck that is not there is a 404. |
| `POST /media` `{filename, data}` | `Collection.addMedia(filename, data)` | The file's own bytes; response is `{filename}`, the name Anki actually stored it under. |
| `GET /media/:filename/data` | `Collection.readMedia(filename)` | Response is `{found, data}`, the file's own bytes. |
| `GET /media/:filename` | `Collection.hasMedia(filename)` | The name is percent-encoded once in the path (`encodeURIComponent`) and decoded once here, for this route and `/data` alike, so a space, Korean, `#` or a literal `%` in a stored name all work; an escape that is not valid is a 400, "the clip name is not a valid name". Response is `{exists: boolean}`. The resumability check a fill makes before calling out to a real TTS API, so re-running audio generation over a deck never regenerates a clip it already made. |

Every answer is the payload above as its kind's message (or a `b_error` message, `{error}`, with a 4xx/5xx status on failure).
HTTP's own status code carries success or failure, so there is no envelope around the payload.

### The protocol version

Every request carries `X-Amgi-Bridge-Protocol: <n>` and every answer names this add-on's own (`WIRE_BRIDGE_PROTOCOL` in `ui/wire/wire.h`).
A request in another protocol, or naming none, is refused with a 409 before it is routed, saying to press **Install into Anki** again and restart Anki: the add-on running in Anki is from another amgi, so its layouts may not be the server's.
The server treats an answer in another protocol the same way, and an add-on old enough to speak JSON (which names none) too: the page shows "Anki: update amgi" with the same instruction.
A refused token or origin from such an old add-on says nothing about its version and is not called outdated.

The one deliberate behavioural difference worth calling out beyond the table: **every mutation here goes through Anki's own API** (`col.decks.id_for_name`/`add_deck_legacy`, `col.add_note`, `col.update_note`, `col.media.write_data`) rather than hand-rolled SQL.
`server/collection/` computes `usn`, `mod`, `sfld` and `csum` itself because it is talking to a *closed* file with nothing else to do that bookkeeping.
In-process, Anki already holds the pen, so `bridge_ops.py` never touches a byte Anki's own engine didn't write.
See `bridge_ops.py`'s module docstring and each function's own docstring for the specifics.

### Turning it on

Off by default (`bridge_enabled: false`).
`Tools > amgi: Bridge status...` shows whether it is listening, on what port, and its token, and has a checkbox that turns it on or off immediately, with no restart needed.
See `config.md`, "amgi bridge settings", for the underlying config keys (`bridge_enabled`, `bridge_port`, `bridge_token`, `bridge_allowed_origins`) if you would rather edit them directly.
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
Every request is handled by a `dispatcher` object (`bridge_dispatch.AqtBridgeDispatcher` in production, a plain fake in `tests/anki/addon/test_bridge_server.py`) whose methods hand the actual work to Anki's own operation queue: `aqt.operations.QueryOp` for reads, `aqt.operations.CollectionOp` for writes that should produce a real undo step and fire Anki's own change hooks, so the browser, deck list and editor all notice a note or deck the bridge just touched, the same as if it came from Anki's UI.
Each dispatch then blocks the calling (HTTP) thread on a plain `threading.Event` until Anki calls back with a result.
See `bridge_dispatch.py`'s own module docstring for exactly which operations use which, and why `add_media` uses `QueryOp`: it touches the media folder, not the undo-tracked collection database, and `QueryOp`'s own docstring names "adding/deleting files" as exactly its other intended use.

### Cross-transport parity

`tests/anki/addon/test_cross_transport.py` is the test that actually matters for "the UI can pick either transport and not care": it runs the C collection core and this bridge's `bridge_ops.py` against the *same* collection file, one after the other, and asserts they agree.
A deck one side creates is recognised, not duplicated, by the other; a note one side adds is read back correctly, with the same fields, tags and note type id, by the other's own reader.
An assertion that only one side agrees with its own writer would prove nothing about that interchangeability - this is what actually pins it down.
See that file's own module docstring for the full reasoning, and "Testing" below for how to run it.

## Testing

### What is actually verified

`tests/anki/addon/test_bridge_auth.py` and `tests/anki/addon/test_bridge_server.py` need no `anki` pip package and no network.
`npm test` runs every test below, the ones that need `anki` included, with the Python that `tests/anki-python.sh` finds, and fails at the start when there is none, so nothing skips for want of the library.
That script uses `ANKI_PYTHON_BIN` when it is set.
Otherwise it uses Anki.app's own `anki` library (`Contents/Resources/app_packages`) with a CPython of the version Anki.app was built for (`Contents/Frameworks/Python.framework/Versions/X.Y`), found on `PATH` or under uv's python directory (`uv python install X.Y`), through a venv at `server/build/anki-venv` whose site-packages names that library (a `.pth` file), so it needs no environment variable and works under `python -I` and the tests' temp HOMEs.

- `test_bridge_auth.py` checks the token and Origin logic (`bridge_auth.py`) as plain functions: valid token and allowed origin succeeds; a missing or wrong token fails; a foreign origin fails, even with the right token; a "simple" request shaped so a browser would never preflight it still fails, because it cannot carry the token header without losing its "simple" status.
- `test_bridge_server.py` proves the same claims again, against a real listening socket and a real `http.client` connection, plus routing (every endpoint in the table above), the request and answer messages, the protocol check, and error-status mapping (`ValueError` to 400, `BridgeBusy` to 503, anything else to 500) - all against a fake dispatcher, so none of it needs Anki or Qt.

`tests/anki/addon/test_bridge_ops.py` tests the bridge's operations: every function in `bridge_ops.py` (`status`, `list_decks`, `list_notetypes`, `create_deck`, `add_note`, `update_note`, `list_notes_in_deck`, `add_media`) against a REAL `anki.collection.Collection`.
Its pagination test adds 2,500 notes to one deck and pages through all of them in fixed-size batches, checking every note is returned exactly once and the total count is right on every page - proving the SQL `LIMIT`/`OFFSET` path is what actually runs, not something that loads the whole deck and slices it in Python, which is what "must not choke on a 20k-note collection" requires in practice.
Its own `SampleDeckTests` (also gated on `AMGI_SAMPLE_APKG`) pages through the same real 333-note deck and checks every note's note type is one `list_notetypes` also reports, with non-empty field names.

`tests/anki/addon/test_bridge_dispatch.py` runs `bridge_dispatch.py`'s writes through its real code against a real collection, with a stand-in for `aqt.mw` and `aqt.operations` that does what Anki's `CollectionOp` does with a result: hand it to the success callback, then read the `OpChanges` off it.
A write that returns anything but an `OpResult` with real changes fails there as it would inside Anki.

`tests/anki/addon/test_cross_transport.py` is the one described above in "Cross-transport parity": it needs `anki` and the built C collection CLI, and runs the C collection core and `bridge_ops.py` against the same collection file, checking they agree.

`npm test` runs all of them, with the interpreter above.
To run one alone, use that interpreter (`export ANKI_PYTHON_BIN="$(tests/anki-python.sh)"`) or any Python that has `anki` installed (`python -m venv .venv && .venv/bin/pip install anki`):

```bash
export ANKI_PYTHON_BIN="$(tests/anki-python.sh)"
AMGI_SAMPLE_APKG=/path/to/a/real.apkg "$ANKI_PYTHON_BIN" -m unittest discover -s tests/anki/addon -p "test_bridge_ops.py" -v
"$ANKI_PYTHON_BIN" -m unittest discover -s tests/anki/addon -p "test_cross_transport.py" -v
```

Run these from the repository root. Each test puts this add-on's own directory on `sys.path` (see "A namespace collision worth knowing about" below), so the working directory only matters for the paths the tests use.

### A namespace collision worth knowing about

The real `anki` pip package ships with no `__init__.py` at its top level - it is an implicit [namespace package](https://peps.python.org/pep-0420/) - and so is this repo's own top-level `anki/` directory, which holds this add-on, the review-loop note type, and their own JS/CSS assets, and has nothing to do with the pip package.
If both end up on `sys.path` at once and the *repo root* is also on `sys.path` (which happens by default for a plain `python -c`, `python -m module`, or `python script.py` run with the repo root as the working directory), Python merges the two into one `anki` namespace: `import anki` then resolves against both directories at once.

For any name the pip package actually defines (`anki.media`, `anki.collection`, ...), the real module wins - that part of PEP 420 favours a genuine module over a bare namespace directory - so this has not caused a wrong answer here.
But it is fragile: it would only take a stray top-level `anki/<name>.py` appearing in this repo, sharing a name the pip package uses, to have the repo's own file silently shadow the real one for anyone who happens to also have `anki` installed and runs Python from the repo root.

Every test file under `tests/anki/addon/` avoids the whole question by adding this add-on's own directory to `sys.path` and importing its modules directly (`import bridge_ops`, `import bridge_server`) rather than through any `anki.*` path - the same way Anki's own add-on loader imports them, which never goes through a path named `anki` at all (an installed add-on is `amgi_bridge`, full stop; see manifest.json's `package` key).
Running `python -m unittest` from this directory, as the commands above do, keeps the repo root off `sys.path` in the first place.

## What is unverified

`__init__.py`, `dialogs.py` and `bridge_dispatch.py` import `aqt`, which needs a working Qt installation this environment does not have (only the pure `anki` package could be installed here, not `aqt`).
Everything in them is written to the operations API modern Anki add-ons use (`aqt.operations.CollectionOp`, `QueryOp`, `.with_progress()`, `mw.progress.want_cancel()`, `mw.taskman.run_on_main()`), but none of it has run inside real Anki.
To check it:

1. **The `CollectionOp` / `QueryOp` API shape itself.**
   This was written against the operations API's documented shape as of Anki 2.1.45+, but its exact keyword arguments have not been checked against the installed Anki version's `aqt/operations/__init__.py`.
   If a bridge write raises a `TypeError` about an unexpected keyword, that file is the first place to look.

2. **The bridge actually starts, stops, and is reachable from a browser.**
   `bridge_server.py` and `bridge_ops.py` are proven directly (see "Testing" above); what is not proven without Qt is the wiring around them in `__init__.py` and `bridge_dispatch.py`.
   To check: enable the bridge in `Tools > amgi: Bridge status...`, confirm the dialog reports a port and the checkbox stays checked, then from a browser console on a page served from an allowed origin (for example `http://localhost:3000`), run
   ```js
   fetch("http://127.0.0.1:8798/status", { headers: { "X-Amgi-Bridge-Token": "<paste the token>", "X-Amgi-Bridge-Protocol": "2" } }).then(r => console.log(r.status, r.headers.get("X-Amgi-Bridge-Protocol")))
   ```
   and confirm it logs `200 2` (the body is a `b_status` message, not text). From a page on a *different* origin, confirm the same call fails.

3. **The bridge tears down and reopens cleanly across a profile switch.**
   Enable the bridge, switch to a different Anki profile (`File > Switch Profile`), and confirm `Tools > amgi: Bridge status...` shows "Not running" until it is enabled again for that profile - `gui_hooks.profile_will_close` is what is supposed to make this happen (`_stop_bridge` in `__init__.py`), and has not run inside real Anki.

4. **A write through the bridge shows up in Anki's own UI immediately.**
   With the Browse window or the deck list open, add a note or create a deck through the bridge (via the `fetch()` snippet above, or the amgi UI once it is wired up) and confirm it appears without needing a manual refresh - this is what routing writes through `CollectionOp` rather than a bare `col` call is supposed to buy, per `bridge_dispatch.py`'s module docstring, and has not been checked against a real `aqt.operations` implementation.

5. **A port already in use is reported clearly, not silently.**
   Start two Anki profiles with the bridge enabled at the same `bridge_port`, or occupy the configured port with `nc -l 8798` first, and confirm the second one to start shows the `showWarning` message in `_start_bridge_if_enabled` (`__init__.py`) rather than crashing or failing silently.
