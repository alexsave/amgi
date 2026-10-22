# Card templates: audio, JavaScript and the microphone

What follows was checked against Anki's source and, where marked, by running real Anki 26.09 (Qt 6.11) under remote debugging.
Source links point at `ankitects/anki` `main`.

## Template syntax traps

- **Fields are substituted inside HTML comments.** `<!-- shows {{Back}} -->` puts the answer into the page source, where a template's JavaScript or the user's browser devtools can read it. `<!-- {{FrontSide}} -->` on the back pastes the whole front template, scripts included, into the comment. Never name a field in a comment.
- **A note gets a card only if that card's front template renders something.** A normal note type creates one card per template whose front is non-empty for that note's fields. A cloze note type creates one card per distinct `{{cN::...}}` number. If a front template renders empty for every template, Anki still creates the first card, and that blank card is a bug report waiting to happen. Check with `anki_tool.py cards NOTE_ID`.
- **`{{FrontSide}}` re-includes the front's scripts.** If the front template has `<script>`, the back side runs it again. Guard initialisation so a second run is harmless, or have the back render its own markup instead of `{{FrontSide}}`.
- **Hiding the answer with CSS is not hiding it.** If text must not be readable before the reveal, it must not be on the front side at all.

## Audio: `[sound:]` vs `<audio>`

| Field holds | Anki plays it? | Template JS can see it? | Replay key `R` / replay buttons | Check Media keeps file | Exported in `.apkg` |
| --- | --- | --- | --- | --- | --- |
| `[sound:x.mp3]` | yes, with its own player | **no**, it is stripped before the HTML reaches the page ([rslib/src/text.rs](https://github.com/ankitects/anki/blob/main/rslib/src/text.rs), `AV_TAGS`) | yes | yes | yes |
| `<audio src="x.mp3"></audio>` | no, the template must call `.play()` | yes | no | yes (`HTML_MEDIA_TAGS` covers `img`, `audio`, `video`, `object` and `source`) | yes |
| bare `x.mp3` | no | as text only | no | **no**, Check Media offers to delete it | **no** |

Use `[sound:]` for ordinary decks. Use `<audio src>` only when a template's JavaScript needs to sequence playback or detect when a clip ends. Then the template is responsible for playing it, and the deck option "Don't play audio automatically" no longer applies.

To convert existing notes inside Anki: Browse, select the notes, Notes > Find and Replace, tick "treat input as regular expression", limit it to the audio field, and replace `\[sound:(.+?)\]` with `<audio src="${1}"></audio>`. `anki_tool.py fill-audio --form html` converts only the clips it generated itself.

## Shared JavaScript and CSS files

- Put them in the media folder with a **leading underscore**: `_mydeck.js`, `_mydeck.css`. Check Media never reports underscore files as unused ([rslib/src/media/check.rs](https://github.com/ankitects/anki/blob/main/rslib/src/media/check.rs)).
- Reference them with a **literal, quoted filename** in the template, `<script src="_mydeck.js"></script>` or `@import url("_mydeck.css");`. The exporter finds them with a regex over the template text (`UNDERSCORED_REFERENCES` and `UNDERSCORED_CSS_IMPORTS` in text.rs), so a filename built in JavaScript is never exported.
- **Classic scripts only, not `type="module"`.** The reviewer re-runs `<script>` tags by cloning them into the page on every render ([ts/reviewer/index.ts](https://github.com/ankitects/anki/blob/main/ts/reviewer/index.ts), `setInnerHTML`), and a module that has already been imported will not run again. Bundle into a classic script, for example as an IIFE.
- **The desktop reviewer is one long-lived page.** Globals, listeners and timers from the last card are still there on the next one. Make startup idempotent and tear down per-card state, such as clearing timers and stopping streams, before you start new work.
- Uploading with `anki_tool.py add-media _mydeck.js` stores it under exactly that name.

## Keyboard

Desktop Anki binds space, 1, 2, 3 and 4 as Qt shortcuts on the main window. A keydown listener in the card sees the same keypress, and **which handler wins changes from one press to the next** (seen in real Anki). So:

- Never grade from a template key handler. A second `pycmd("ease3")` after the answer is already showing grades the *next* card, silently. Leave grading to Anki's own Again/Hard/Good/Easy bar.
- Revealing twice is harmless: Anki ignores a duplicate `ans`.
- `R`, `A` and `V` never reach the page at all on desktop, because Qt resolves them first. A card cannot rebind them. An add-on can, through `gui_hooks.state_shortcuts_will_change`.

`pycmd("ans")` (reveal) and `pycmd("easeN")` are the commands the reviewer's `_linkHandler` accepts on desktop ([qt/aqt/reviewer.py](https://github.com/ankitects/anki/blob/main/qt/aqt/reviewer.py)). AnkiDroid also provides `pycmd`.

## Microphone (`getUserMedia`) by client

| Client | Mic from a card | Notes |
| --- | --- | --- |
| Desktop, stock | **no** | `qt/aqt` never answers Qt's permission request, and on Qt 6.11 an unanswered request **never settles**: neither resolved nor rejected (seen in real Anki). Always race `getUserMedia` against a timeout and fall back. |
| Desktop + a small add-on | yes | The add-on connects to `QWebEnginePage.permissionRequested` (Qt 6.8+) or `featurePermissionRequested` (6.2–6.8) and grants audio capture for the reviewer's own local origin only. Anki's author declined to do this by default for security reasons ([forum](https://forums.ankiweb.net/t/microphone-access-via-javascript-on-cards-desktop-and-mobile/61563)), so make it an add-on the user chooses to install, never something a shared deck can do. |
| AnkiDroid 2.25+ | yes, once the user turns on Advanced > "Allow templates to record audio" | Per-template consent dialog ([PR 20113](https://github.com/ankidroid/Anki-Android/pull/20113)) |
| AnkiDroid 2.18–2.24 | the legacy reviewer grants it outright | Read from source, not tested |
| AnkiMobile (iOS) | **no**, by the maintainer's stated position | Design for a "tap when done speaking" fallback |
| AnkiWeb | treat as no | |

Media files resolve on every client through relative `src` (desktop serves the media folder at `http://127.0.0.1:PORT/`).

Rules for a template that records audio: never block (every clip gets a timeout, and every mic failure gets a fallback that still lets the user reveal and grade); remember a refusal so you don't ask again on every card; drop the recording when the card changes.

## Debugging a template on desktop

Start Anki with `QTWEBENGINE_REMOTE_DEBUGGING=8080`, open `http://localhost:8080` in Chrome, and attach to the reviewer page for a console, the DOM and network (404s for media).
A template error should be caught and printed on the card. An uncaught error leaves the card blank, but Anki's own buttons keep working.
