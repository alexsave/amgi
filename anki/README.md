# amgi's review loop, as an Anki card template

This is amgi's listening-and-speaking loop packaged as an Anki note type.

The card plays a prompt, opens the microphone by itself, ends the turn when you stop speaking, reveals the answer with the native audio, and grades on the same keys Anki already uses.
The answer text is never on the page until the turn is over, because the whole point is to answer from listening rather than from reading.

Where the microphone is not available, and on the desktop client that means everywhere without the companion add-on, the same card degrades into a listening card: the prompt plays, the text stays hidden, you press space when you have answered out loud, the native audio plays, and you grade yourself.

```
anki/
  notetype/          what you paste into Anki: front, back, styling
  media/             what you copy into collection.media: _amgi-loop.js, _amgi-loop.css
  src/anki-loop.js   the Anki-specific half of the loop (source, not shipped)
  tools/build-loop.js  builds media/_amgi-loop.js from amgi's own source
  test/              a node:test suite, and a Chrome harness that drives the template
  addon/amgi_mic/    the desktop add-on that grants the microphone
  addon/amgi_bridge/  the desktop add-on that fills in missing audio, and exposes a local HTTP bridge, from inside a live collection
```

## Install

1. Copy `media/_amgi-loop.js` and `media/_amgi-loop.css` into your collection's media folder, keeping the leading underscores.
   The folder is next to your collection: Tools > Check Database shows the profile path, and the folder is `collection.media` inside it.
   Anki never reports a file whose name starts with an underscore as unused, so Check Media will leave both alone ([rslib/src/media/check.rs](https://github.com/ankitects/anki/blob/main/rslib/src/media/check.rs)).

2. Make a note type called `amgi Listening` (Tools > Manage Note Types > Add > Add: Basic, then rename) with exactly these fields, in this order:

   | Field | Holds | Required |
   | --- | --- | --- |
   | `Prompt` | the prompt in text, shown only after the reveal | no |
   | `PromptAudio` | the prompt audio, as an HTML media reference | yes |
   | `Answer` | the target phrase in text, shown only after the reveal | no |
   | `AnswerAudio` | the native audio of the target phrase | yes |
   | `Notes` | anything extra to show on the answer | no |

3. Open Cards... on that note type and paste in `notetype/front.html`, `notetype/back.html` and `notetype/styling.css`.

4. For hands-free review on the desktop client, install the add-on in `addon/amgi_mic`.
   Read `addon/amgi_mic/README.md` first: it is asking for your microphone, and it is short enough to read in full.

## What goes in the audio fields

```html
<audio src="hello-prompt.mp3"></audio>
```

Not `[sound:hello-prompt.mp3]`.

Anki strips sound tags out of a card before the template's JavaScript ever sees them and plays them through its own player, which gives the template no way to know when playback ended and so no way to sequence the loop ([rslib/src/text.rs](https://github.com/ankitects/anki/blob/main/rslib/src/text.rs), `AV_TAGS`).
An `<audio src="...">` element survives into the page, and Anki still counts it as a used media file, so Check Media keeps it and exporting the deck carries it along ([rslib/src/text.rs](https://github.com/ankitects/anki/blob/main/rslib/src/text.rs), `HTML_MEDIA_TAGS` covers `img`, `audio`, `video`, `object` and `source` with a `src` or `data` attribute).

A bare filename in the field also works, because the loop falls back to reading the field as text.
It is not recommended: Anki does not recognise a bare filename as a media reference, so Check Media will offer to delete the file and an export will leave it behind.

### Generating the audio

`plusaudio/` writes the fields for you.
Give it `--audio-tag html` and it writes `<audio src="...">` references in exactly the form above:

```bash
node plusaudio/add-audio.js "My Deck.apkg" --audio-tag html
```

Its default is `--audio-tag sound`, which is right for an ordinary Anki deck and wrong for this note type.
A deck already generated one way converts to the other by re-running with the other flag: the clip filenames are content hashes, so nothing is regenerated and no note ends up with two references to the same clip.
See [`../plusaudio/README.md`](../plusaudio/README.md).

If the deck you want audio in is one you already have open in Anki, [`addon/amgi_bridge/`](addon/amgi_bridge/README.md) does the same generation directly against your live collection, with no export or import step.
It runs entirely on your own machine against your own OpenAI key - no amgi account, same as `plusaudio/` itself - but it does need Node and a checkout of this repo; see its README's "Install" section.

### Converting a deck you cannot regenerate

If the deck is not one you can put back through `plusaudio/` - someone else's, or one you have edited in Anki since - convert it in Anki itself, with no scripting.
Browse, select the notes, Notes > Find and Replace, tick "treat input as regular expression", limit it to the audio field, and replace

```
\[sound:(.+?)\]
```

with

```
<audio src="${1}"></audio>
```

## What each platform does

Verified means read out of Anki's source; the last column says what actually happens to a learner.

| Client | Microphone from a card | Media resolves | `pycmd` | The loop |
| --- | --- | --- | --- | --- |
| Desktop, with `amgi_mic` | yes, the add-on answers Qt's permission request | yes, `<base href="http://127.0.0.1:PORT/">` points at the media folder ([main.py](https://github.com/ankitects/anki/blob/main/qt/aqt/main.py), `baseHTML`) | yes ([reviewer.py](https://github.com/ankitects/anki/blob/main/qt/aqt/reviewer.py), `_linkHandler`) | the full hands-free loop |
| Desktop, stock | no: `qt/aqt` has no permission handler at all, and Qt denies a request nobody answers | yes | yes | prompt plays, press space to reveal, native audio, grade |
| AnkiDroid 2.25+ | yes, after turning on Advanced > "Allow templates to record audio" ([PR 20113](https://github.com/ankidroid/Anki-Android/pull/20113)) | yes, the card is loaded with the media server as its base URL ([CardViewerFragment.kt](https://github.com/ankidroid/Anki-Android/blob/main/AnkiDroid/src/main/java/com/ichi2/anki/previewer/CardViewerFragment.kt)) | yes | the full hands-free loop |
| AnkiDroid 2.18 to 2.24 | the legacy reviewer grants audio capture outright ([AbstractFlashcardViewer.kt](https://github.com/ankidroid/Anki-Android/blob/main/AnkiDroid/src/main/java/com/ichi2/anki/AbstractFlashcardViewer.kt)) | yes | yes | expected to be hands-free, untested |
| AnkiMobile | no, by the maintainer's stated position ([forum](https://forums.ankiweb.net/t/microphone-access-via-javascript-on-cards-desktop-and-mobile/61563)) | yes, relative media references are how every Anki card shows an image | yes | prompt plays, tap "Done speaking", native audio, grade |
| AnkiWeb | unknown, treat as no | unknown | unknown | prompt needs one tap, then reveal and grade fall back to AnkiWeb's own buttons |

Two behaviours are the same everywhere.
The answer text is not in the DOM until the answer side renders, so no client can leak it early.
And nothing in the loop ever blocks: every clip has a timeout, every microphone failure has a fallback, and a template error is caught, printed on the card and left there while the client's own buttons keep working.

### Known deviations from ordinary Anki cards

- The loop plays its audio itself, so the deck option "Don't play audio automatically" does not apply to it, and Anki's Replay Audio (`R`) has nothing to replay.
- The card has no `[sound:]` tags, so Anki's own replay buttons do not appear.
  The answer side offers Prompt, Native and You instead.
- "You" only appears on clients that keep one page across the reveal, which is the desktop client.
  Elsewhere the recording is gone by the time the answer renders, and the button is hidden rather than dead.

## Keys

| Key | While the prompt plays | While the microphone is open | On the answer |
| --- | --- | --- | --- |
| space or enter | skip the prompt | end the turn and reveal | Good, as `pycmd("ease3")` |
| 1 | - | - | Again, as `pycmd("ease1")` |
| 3 | - | - | Good |

That is amgi's keyboard, and it is also Anki's own: space reveals then rates Good, 1 rates Again.

On the desktop client Anki binds those keys itself, at the Qt level, and whether the webview also sees them is untested here.
If you ever see one keypress grade two cards, turn the template's keys off by putting this line in both templates, above the `<script src="_amgi-loop.js">` line:

```html
<script>window.amgiLoopConfig = { keys: false };</script>
```

The same object takes `record: false` to stop the loop from recording you at all, and `vad: { silenceMs: 1500 }` and friends to retune the detector.
The detector's settings and their defaults are documented in `src/utils/voiceActivity.js`.

## How this stays the same loop as the app

`media/_amgi-loop.js` is generated, not written.
`tools/build-loop.js` concatenates amgi's own `src/utils/voiceActivity.js` and `src/utils/reviewLoop.js` with the Anki host in `src/anki-loop.js`, strips the ES module syntax, and wraps the result in an IIFE.
A card template has to be a classic script, because Anki re-runs `<script>` tags by cloning them into the page on every render ([ts/reviewer/index.ts](https://github.com/ankitects/anki/blob/main/ts/reviewer/index.ts), `setInnerHTML`), and a module would not re-execute.

The generated file is committed, because it has to ship inside a collection, and `test/build-loop.test.js` rebuilds it and fails if the committed copy has drifted.
The same suite asserts that whole blocks of the shared sources appear in the bundle verbatim, so the build cannot quietly turn into a rewrite.

```bash
node anki/tools/build-loop.js     # after changing either shared file
pnpm test                         # includes anki/test
```

The alternative was a documented copy with a diffing test, which is the same amount of machinery for a weaker guarantee: a copy can be edited and the test then tells you the two files differ, rather than making the deck's copy impossible to edit at all.

## Testing

### What the Chrome harness proves

```bash
node anki/test/harness/drive.js          # add HEADLESS=false to watch it
```

`test/harness/reviewer.html` is a stand-in for Anki's reviewer: one long-lived document with a `#qa` element whose `innerHTML` is replaced per side, scripts re-executed the way `ts/reviewer/index.ts` re-executes them, a `pycmd` that accepts the commands `_linkHandler` whitelists, and a media folder served over HTTP so filenames resolve the way Anki resolves them.
`drive.js` runs the real template files out of `notetype/` against it, with the synthetic microphone from `.claude/skills/e2e-ui/scripts/fakevoice.js`.

It checks, and at the time of writing passes, 23 assertions across two sessions:

- the microphone opens by itself once the prompt has finished,
- the answer text is nowhere in the DOM while the learner is speaking, and a watcher polling every 25ms and on every mutation never sees it appear before the reveal,
- voice activity ends the turn about 3.3s after the microphone opens, which is the speech plus the detector's 1200ms of silence, and not the 8s no-speech timeout,
- the reveal goes through `pycmd("ans")` and nothing is sent before it,
- the native audio plays on the answer side and the learner's own recording is offered for replay,
- space sends `pycmd("ease3")` and `1` sends `pycmd("ease1")`, each exactly once,
- and with `getUserMedia` rejecting, the card holds at "press space", reveals on space, plays the native audio, hides the "You" button and still grades.

### What cannot be checked without Anki

Anki is not installed on the machine this was written on, so everything below is reasoned from Anki's source and is unverified by running it.
In rough order of how much would break if it were wrong:

1. **The `pycmd` bridge in a real reviewer.**
   Read from [reviewer.py](https://github.com/ankitects/anki/blob/main/qt/aqt/reviewer.py) `_linkHandler`, which accepts `ans` and `ease1` to `ease4`, and `_answerCard`, which ignores an ease while the question is still up.
   To check: install the note type, add one note, review it, and confirm the card reveals itself and that space advances to the next card exactly once.

2. **Media resolution in the reviewer.**
   Read from [main.py](https://github.com/ankitects/anki/blob/main/qt/aqt/main.py) `baseHTML` and [mediasrv.py](https://github.com/ankitects/anki/blob/main/qt/aqt/mediasrv.py), where a request that is not under `/_anki/` or `/_addons/` is served from the collection media folder.
   To check: review a card and watch for the audio, then open the reviewer's dev console (Tools > Debug Console does not cover the webview; use `QTWEBENGINE_REMOTE_DEBUGGING=8080 anki` and visit `http://localhost:8080`) and confirm `_amgi-loop.js` loaded with status 200.

3. **The add-on's permission grant.**
   See `addon/amgi_mic/README.md` for the exact steps.

4. **Whether the webview sees space and 1 at all on desktop, or whether Qt's own shortcuts swallow them.**
   To check: review a card, press space once on the answer, and confirm exactly one card is graded.
   If two are, set `keys: false` as described above and the on-screen buttons still work.

5. **Anki's exporter carrying `_amgi-loop.js` and `_amgi-loop.css` into an `.apkg`.**
   Read from [rslib/src/text.rs](https://github.com/ankitects/anki/blob/main/rslib/src/text.rs), `UNDERSCORED_REFERENCES` and `UNDERSCORED_CSS_IMPORTS`, which is why the template quotes the filenames rather than building them in JavaScript.
   `test/build-loop.test.js` runs those two regexes against the templates, but only real Anki can prove the exporter agrees.
   To check: export the deck with media, unzip it, and look for both files in the media map.

6. **AnkiDroid, AnkiMobile and AnkiWeb, all of it.**
   The table above is read from AnkiDroid's source and from AnkiMobile's and AnkiWeb's documented behaviour, and none of it has been run.
