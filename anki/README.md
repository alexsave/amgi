# amgi's review loop, as an Anki card template

This is amgi's listening-and-speaking loop packaged as an Anki note type.

The card plays a phrase in the language you're learning, opens the microphone by itself, ends the turn when you stop speaking, reveals the answer with the native audio, and grades on Anki's own Again/Hard/Good/Easy bar.
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
   | `Cue` | a gloss or translation, shown small on the answer side, never on the front | no |
   | `CueAudio` | the audio played first, before the microphone opens, as an HTML media reference | yes |
   | `Target` | the target-language phrase, shown as the hero on the answer side | no |
   | `TargetAudio` | the native audio of the target phrase, played on reveal | yes |
   | `Language` | a BCP-47 language tag (`ko`, `ja`, ...) for the target phrase's `lang` attribute | no |
   | `Notes` | anything extra to show on the answer | no |

   Earlier versions of this note type used `Prompt`/`PromptAudio`/`Answer`/`AnswerAudio`.
   Those names told you nothing about which direction the phrase went, and a deck built with the target-language phrase in the wrong field looked no different from one built correctly - only the visual hierarchy on the answer side gave it away, and only if you already knew which field was supposed to be the hero.
   If you have an existing deck on the old names, Anki lets you rename a note type's fields without losing any data (Tools > Manage Note Types > Fields > Rename); rename `Prompt` to `Cue`, `PromptAudio` to `CueAudio`, `Answer` to `Target`, `AnswerAudio` to `TargetAudio`, and re-paste the templates below.

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

The amgi app itself (the Next.js app under `src/`) already writes both audio
fields in this form when it adds or bulk-adds notes to this note type - it
guesses `CueAudio`/`TargetAudio` from the field names (see
`src/utils/ankiFields.js`) and renders every clip with
`plusaudio/lib/deck.js`'s own `renderAudioReference(..., 'html')`, the same
function `plusaudio/` and `addon/amgi_bridge/` use. A deck built entirely
through the app needs no conversion step at all.

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

### Notes you already added through the amgi app, before this fix

Earlier versions of the amgi app (`src/`) wrote `[sound:...]` into whichever field you picked as the audio field, and had no way at all to fill in `CueAudio` - it could not even guess that field existed, since `CueAudio`/`TargetAudio` did not match its old field-name guesser.
If you have notes like that already in a deck, each one needs two things: `TargetAudio` converted from `[sound:...]` to `<audio src="...">`, and `CueAudio` generated from scratch.

For a deck you can still put through the app - re-run the affected notes' text through the bulk-add screen's audio pass, or the single-note form's "Generate Audio", now that both write the right fields in the right form; the clip filenames are content hashes, so this never pays for a clip it already generated.

For notes you would rather fix in place, `addon/amgi_bridge/`'s Tools > amgi: Fill missing audio... dialog (its own README, "Field mapping") does this without touching the app at all: run it once with "Read this field aloud" set to `Target` and "Write the clip into" set to `TargetAudio`, reference form `html`; run it again with `Cue` and `CueAudio`.
Each run only ever touches the one field you name, so running it twice is safe.

### Converting a deck you cannot regenerate

If the deck is not one you can put back through `plusaudio/` or the app - someone else's, or one you have edited in Anki since - convert it in Anki itself, with no scripting.
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
| Desktop, stock | no: `qt/aqt` has no permission handler at all, and on Qt 6.11 an unanswered request is never denied - it just never settles, confirmed by driving real Anki 26.09.2 | yes | yes | prompt plays, `getUserMedia` is raced against a `micTimeoutMs` timeout (default 15s) so the card falls back instead of hanging forever, press space to reveal, native audio, grade |
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
  The answer side offers "Hear it again", "Hear the answer" and "Hear yourself" instead.
- "Hear yourself" only appears on clients that keep one page across the reveal, which is the desktop client.
  Elsewhere the recording is gone by the time the answer renders, and the button is hidden rather than dead.
- The card draws no grading buttons of its own.
  Grading is entirely Anki's own Again/Hard/Good/Easy bar's job - see "Keys" below for why.

## Keys

| Key | While the prompt plays | While the microphone is open | On the answer |
| --- | --- | --- | --- |
| space or enter | skip the prompt | end the turn and reveal | Good, as Anki's own native shortcut |
| 1 | - | - | Again, as Anki's own native shortcut |
| 3 | - | - | Good, as Anki's own native shortcut |

Confirmed in real Anki (26.09.2, Qt 6.11): desktop Anki binds space/1/2/3/4 itself, at the Qt level, as native `QShortcut`s on the main window, and the webview's own keydown handler sees the same keypress at the same time.
Which of the two wins is nondeterministic - it varies from keypress to keypress, not just from machine to machine.
Revealing the answer twice is harmless (Anki's own `_answerCard` ignores an ease while the question is still up, and this template's own `data-amgi-graded` guard makes a second reveal a no-op), but grading twice is not: a second `pycmd("easeN")` after the answer is already up grades the *next* card, corrupting its schedule with no error and no visible sign anything went wrong.

Because of that, the back template has no keydown handler at all, and draws no grading buttons of its own either - see anki-loop.js's `bootBack`.
Anki's own Again/Hard/Good/Easy bar, visible right below this template's replay buttons, already grades correctly on every client without any help from the template, so there is nothing to gain and a silent scheduling bug to lose by competing for the same keys.
An earlier version of this card drew its own Again/Good row above Anki's bar, in different colours, offering two grades where Anki's own bar offers four; that read as a second, half-working control rather than a deliberate design, independent of the key race, and it is gone now for that reason too.
The front template still binds space/enter itself (to skip the prompt or end the turn early), because there is no equivalent double-*grading* risk there: ending a turn twice is a no-op once the first call has resolved it, and Anki has no native shortcut for "the microphone is done listening".
If you want the template to stop touching the keyboard entirely - including that front-side space - put this line in both templates, above the `<script src="_amgi-loop.js">` line:

```html
<script>window.amgiLoopConfig = { keys: false };</script>
```

The same object takes `record: false` to stop the loop from recording you at all, `micTimeoutMs` to change how long it waits for a microphone permission prompt before giving up and falling back to "press space" (default 15000ms - see "What each platform does" below), and `vad: { silenceMs: 1500 }` and friends to retune the detector.
The detector's settings and their defaults are documented in `src/utils/voiceActivity.js`.

## How this stays the same loop as the app

`media/_amgi-loop.js` is generated, not written.
`tools/build-loop.js` concatenates amgi's own `src/utils/voiceActivity.js` and `src/utils/reviewLoop.js` with the Anki host in `src/anki-loop.js`, strips the ES module syntax, and wraps the result in an IIFE.
A card template has to be a classic script, because Anki re-runs `<script>` tags by cloning them into the page on every render ([ts/reviewer/index.ts](https://github.com/ankitects/anki/blob/main/ts/reviewer/index.ts), `setInnerHTML`), and a module would not re-execute.

The generated file is committed, because it has to ship inside a collection, and `test/build-loop.test.js` rebuilds it and fails if the committed copy has drifted.
The same suite asserts that whole blocks of the shared sources appear in the bundle verbatim, so the build cannot quietly turn into a rewrite.

```bash
node anki/tools/build-loop.js     # after changing either shared file
npm test                          # includes anki/test
```

The alternative was a documented copy with a diffing test, which is the same amount of machinery for a weaker guarantee: a copy can be edited and the test then tells you the two files differ, rather than making the deck's copy impossible to edit at all.

## Testing

### What the Chrome harness proves

```bash
node anki/test/harness/drive.js          # add HEADLESS=false to watch it
```

`test/harness/reviewer.html` is a stand-in for Anki's reviewer: one long-lived document with a `#qa` element whose `innerHTML` is replaced per side, scripts re-executed the way `ts/reviewer/index.ts` re-executes them, a `pycmd` that accepts the commands `_linkHandler` whitelists, and a media folder served over HTTP so filenames resolve the way Anki resolves them.
`drive.js` runs the real template files out of `notetype/` against it, with the synthetic microphone from `.claude/skills/e2e-ui/scripts/fakevoice.js`.

It checks, across five sessions (with a microphone, with one that refuses outright, with one that never answers at all, with a card that has no cue audio, and with no Web Audio in the client at all):

- the microphone opens by itself once the prompt has finished, through its own visible "Asking for the microphone..." phase,
- the answer text is nowhere in the DOM while the learner is speaking, and a watcher polling every 25ms and on every mutation never sees it appear before the reveal,
- voice activity ends the turn about 3.3s after the microphone opens, which is the speech plus the detector's 1200ms of silence, and not the 8s no-speech timeout,
- the reveal goes through `pycmd("ans")` and nothing is sent before it,
- the native audio plays on the answer side and the learner's own recording is offered for replay,
- the card draws no grading buttons of its own, and space/1 do nothing at all on the answer side (see "Keys" above) - grading is simulated the way Anki's own native shortcut actually reaches the card, a direct `pycmd("ease1")`/`pycmd("ease3")` that never touches the template,
- a card with no cue audio never asks for the microphone at all, and tells the learner it has no audio yet rather than opening a mic onto nothing,
- a remembered mic refusal is not re-asked on the next card - no second "Asking for the microphone..." phase, and the "no microphone" note is said once per session, not on every card,
- with `getUserMedia` rejecting, the card holds at "press space", reveals on space, plays the native audio, hides "Hear yourself" and still grades,
- and with `getUserMedia` never settling at all (neither resolving nor rejecting - real Qt 6.11 desktop behaviour, see below), the same fallback is reached once `micTimeoutMs` elapses instead of hanging the card forever.

### Verified against real Anki

The rest of this section used to say Anki was not installed on the machine this was written on.
It has since been driven directly: Anki 26.09.2 (Qt 6.11), launched against an isolated base folder, with `QTWEBENGINE_REMOTE_DEBUGGING` and CDP for the reviewer webview.
What that run confirmed, and changed:

- **The `pycmd` bridge in a real reviewer.** Confirmed: `ans`, `ease1` and `ease3` all reach `_linkHandler`, the note's scheduling genuinely changes (New -> Learn, the deck browser's studied-card counter incrementing 1:1 with keypresses), and a template error is caught and printed on the card rather than crashing the review.
- **Media resolution in the reviewer.** Confirmed: `_amgi-loop.js` and `_amgi-loop.css` both load with status 200 from the collection media folder, no 404s.
- **The add-on's permission grant (`amgi_mic`).** Confirmed: `getUserMedia({ audio: true })` resolves with a real device inside the reviewer when the add-on is installed.
- **Whether the webview sees space and 1 at all on desktop, or whether Qt's own shortcuts swallow them.** Confirmed real, and confirmed nondeterministic: across repeated trials some keypresses were seen by the webview's own listener and some were not, with Qt's native `QShortcut` winning the race often enough to matter. This is why the back template no longer binds space/1 to grading at all - see "Keys" above.
- **The no-microphone fallback without `amgi_mic` installed.** This was the one place reasoning from source turned out to be wrong: Qt 6.11 does not deny an unanswered permission request, it leaves it pending forever, and the card used to hang at "Listen" with no working escape. Fixed with a timeout around `openMic()` in `src/utils/reviewLoop.js` (`micTimeoutMs`, default 15s) - confirmed the card now reaches the "press space" fallback instead of hanging.

### What still cannot be checked without Anki

1. **Anki's exporter carrying `_amgi-loop.js` and `_amgi-loop.css` into an `.apkg`.**
   Read from [rslib/src/text.rs](https://github.com/ankitects/anki/blob/main/rslib/src/text.rs), `UNDERSCORED_REFERENCES` and `UNDERSCORED_CSS_IMPORTS`, which is why the template quotes the filenames rather than building them in JavaScript.
   `test/build-loop.test.js` runs those two regexes against the templates, but only real Anki can prove the exporter agrees.
   To check: export the deck with media, unzip it, and look for both files in the media map.

2. **AnkiDroid, AnkiMobile and AnkiWeb, all of it.**
   The table above is read from AnkiDroid's source and from AnkiMobile's and AnkiWeb's documented behaviour, and none of it has been run.
