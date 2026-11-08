# C backend: hands-on checklist for Alex

Do this once `verify-c-backend.sh` has passed on the branch you are about to merge.
It takes about 20 minutes and spends a few Gemini requests (two cards, five to seven requests each).

## 0. Before you start

Quit Anki (Anki's own File > Quit, so it writes everything and closes the collection).
Make your own copy of the whole Anki folder, so you can roll back even if amgi's backup misses something:
`cp -Rp ~/Library/Application\ Support/Anki2 ~/Anki2-before-c-backend-$(date +%Y%m%d-%H%M)`
Check that the copy is there and about the same size: `du -sh ~/Library/Application\ Support/Anki2 ~/Anki2-before-c-backend-*`.
Make sure nothing else is on port 3000 (`lsof -nP -iTCP:3000 -sTCP:LISTEN` prints nothing); stop it if something is.
Use port 3000 and no other, because the bridge add-on only allows the page's origin at `http://localhost:3000` and `http://127.0.0.1:3000` out of the box.
Nothing else needs quitting: the agents' servers on other ports do not matter.

## 1. Get the build

In your amgi checkout: `git pull`, then `git submodule update --init --recursive` (a plain pull does not fetch the new `cbase` submodule).
Check that `.env.local` holds one line, `GEMINI_API_KEY=<your key>`; a trailing `# comment` after the key is ignored, as the Node server did.
Run `npm start` and wait for `cbase: listening 127.0.0.1:3000`.
Open <http://localhost:3000>.
Your settings (Anki folder, profile, bridge) should still be there, because the origin is the same as before.

## 2. Update the add-ons

Press **Install into Anki** with Anki still closed.
It should say it installed both add-ons and the card template, and it should not report an error.
This also refreshes `amgi_bridge`, so the add-on and the server speak the same bridge protocol.

## 3. A card through the bridge (Anki open)

Open Anki and wait until your profile is loaded.
Reload the amgi page.
The page should show it is using the bridge (not "locked" and not "outdated").
If it asks for a bridge token, copy it from Anki's Tools > amgi: Bridge status... and paste it into amgi's settings.
Make a test deck in amgi called `amgi C test` (a new deck, so nothing you study is touched).
Paste one phrase, for example `where is the station`, and make the card.
Wait until the card shows both sides and both clips, and play each clip once in amgi.
In Anki, open Browse, find the `amgi C test` deck, and check the note: Cue, Target and both audio fields are filled, and both clips play.

## 4. A card through the file (Anki closed)

Quit Anki with File > Quit.
Reload the amgi page.
The page should now be on the collection file (direct), not the bridge.
Add a second phrase to `amgi C test`, for example `how much is this`, and make the card.
Wait until both clips are there, and play each once in amgi.
Check that a backup was made: `ls -lt ~/Library/Application\ Support/Anki2/<your profile>/amgi-collection-backups/ | head -3` shows a `collection.anki2.<time>.bak` from just now.

## 5. Check it in Anki

Open Anki.
Tools > Check Database should finish with no problems found (it recomputes the checksums the C code wrote).
In Browse, the `amgi C test` deck has both notes, each with its two cards, and every clip plays.
Study one card from that deck in the reviewer: the prompt plays, the microphone opens, and your recording plays back.
Run Sync if you use AnkiWeb, and check it finishes with no full-sync prompt you did not expect.
Delete the `amgi C test` deck when you are done, from amgi or from Anki.

## 6. Rolling back

amgi's own backup covers what amgi wrote to the file with Anki closed (step 4).
amgi makes one at most once every 30 minutes per collection and keeps the newest ten, in `~/Library/Application Support/Anki2/<your profile>/amgi-collection-backups/`.
To restore one, quit Anki first.
Move the current `collection.anki2` in that profile folder aside (along with any `collection.anki2-wal` or `collection.anki2-shm` next to it).
Copy the `.bak` you want into the profile folder as `collection.anki2`.
Open Anki and run Tools > Check Database.
What amgi wrote through the bridge (step 3) was written by Anki itself, so it is covered by Anki's own backups.
To restore one of those, use Anki's File > Switch Profile, then Open Backup..., and pick a `.colpkg` from before the test.
If anything else looks wrong, quit Anki and put your own copy from step 0 back in place: `mv ~/Library/Application\ Support/Anki2 ~/Anki2-broken && cp -Rp ~/Anki2-before-c-backend-<time> ~/Library/Application\ Support/Anki2`.
To go back to the Node server itself, check out the last commit before the C server became the default, run `npm install`, then `npm start`, and press **Install into Anki** again so the add-ons match it.
