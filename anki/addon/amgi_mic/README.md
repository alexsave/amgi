# amgi microphone for cards

A desktop add-on that lets a card template open the microphone.
It is 90 lines, all in `__init__.py`, and you should read them before installing it.

## What it does

Anki's reviewer runs your card in a Qt WebEngine view.
When a page calls `navigator.mediaDevices.getUserMedia`, Qt asks the application whether to allow it.
Anki never answers: there is no `permissionRequested` or `featurePermissionRequested` handler anywhere in `qt/aqt`, and Qt denies a request that nobody answers.

This add-on connects one function to that signal.
When the request is for the microphone, and it comes from the local server Anki serves the reviewer and your media from, it grants it.
Every other permission Qt might ask about, the camera and screen capture included, is left untouched and therefore denied.

That is the entire add-on.
It stores nothing, sends nothing anywhere, adds no menu item, and touches no collection data.
The recording itself never leaves the card: the amgi template keeps it in the page so you can replay it, and drops it when you grade.

## Why Anki does not do this by default

It was asked for and declined.
In June 2025 Damien Elmes answered a request for `getUserMedia` on cards with "It's a big security risk, especially on computers where a microphone-in-use indicator is not present", and "very few people have asked for this so far" ([forum thread](https://forums.ankiweb.net/t/microphone-access-via-javascript-on-cards-desktop-and-mobile/61563)).

That reasoning is sound, and it is the reason this is a separate add-on you choose to install rather than something the card template can arrange for itself.
A shared deck cannot turn your microphone on.
You can, by installing this, and you can turn it off again by removing it.

AnkiDroid took the same decision the other way in 2.25, and even there it is behind a setting called "Allow templates to record audio" with a per-template consent dialog, whose code comment reads "otherwise a template could spam requests, pressuring a user into consenting" ([PR 20113](https://github.com/ankidroid/Anki-Android/pull/20113)).
If you want that level of prompting on desktop, do not install this add-on: the amgi template works without it, and just asks you to press space when you have answered.

## Install

Copy the `amgi_mic` folder into your Anki add-ons folder (Tools > Add-ons > View Files puts you in the right place), then restart Anki.

There is nothing to configure.

## Checking that it works

This add-on has not been run against a real Anki, so here is how to prove it does what it says.

1. With the add-on installed and the amgi note type set up, review a card.
   The card should say "Speak your answer" a moment after the prompt finishes, and your operating system's microphone indicator should come on.
2. For the direct test, start Anki with `QTWEBENGINE_REMOTE_DEBUGGING=8080`, open `http://localhost:8080` in Chrome, attach to the reviewer page and run:

   ```js
   navigator.mediaDevices.getUserMedia({ audio: true }).then(
     (stream) => console.log('granted', stream.getAudioTracks()[0].label),
     (error) => console.log('denied', error.name)
   );
   ```

   With the add-on it should log `granted`.
   Without it, `denied NotAllowedError`.
3. Confirm the boundary: in the same console, `navigator.mediaDevices.getUserMedia({ video: true })` should still be denied.

## Compatibility

The add-on uses `QWebEnginePage.permissionRequested` on Qt 6.8 and later, and falls back to the older `featurePermissionRequested` and `setFeaturePermission` on Qt 6.2 to 6.8, which is where Anki 2.1.50 and later live.
If a build turns up with neither, it says so in a warning and does nothing, and the card template falls back to its press-a-key path.

## Licence

GNU AGPL, version 3 or later, to match Anki's own.
