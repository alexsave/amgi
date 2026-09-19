## amgi audio fill settings

This add-on generates entirely on your own machine: no amgi account, no hosted service, and no
quota but your own OpenAI account's.
It needs three things to do that, and checks all three before a run starts so a bad setting is one
clear message, not a stall or a traceback partway through.

`plusaudio_dir`
Required.
The full path to the `plusaudio` folder of a checkout of this add-on's own repo
(`https://github.com/alexsave/amgi`), for example `/Users/you/amgi/plusaudio`.
This is where `generate-clip.js` lives, and it is what actually makes a clip: this add-on has no
generation logic of its own, and is never going to grow a second copy of it in Python.
See `../../README.md` (the repo root) if you have not checked the repo out yet.

`node_path`
Optional.
Leave it blank to use whatever `node` resolves to on your system `PATH`.
Anki is usually launched as a GUI app rather than from a terminal, and on macOS in particular a GUI
app does not see the `PATH` a shell's startup file (`nvm`, Homebrew, ...) sets up - so "`node` works
in Terminal" and "`node` works inside Anki" can genuinely differ.
If Tools > amgi: Fill missing audio... says it cannot find Node, run `which node` in a terminal
where you know it works and paste that full path in here.

`openai_api_key`
Optional.
If you already export `OPENAI_API_KEY` in the environment Anki itself runs in, or keep it in a
`.env` file in your `plusaudio` checkout (the same file `plusaudio/add-audio.js` reads), leave this
blank and either of those is used.
Setting it here overrides both, and is stored in this add-on's own config file, in plain text:
readable to anything with access to your Anki profile folder, and to nothing else - the same
tradeoff `plusaudio/.env` already makes for the same key.

None of this add-on's earlier Supabase/amgi-account settings (`supabase_url`, `supabase_anon_key`,
`email`, `password`) exist any more.
Generation used to go through a deployed edge function and your amgi account's quota; now it runs
locally against your own OpenAI key, and there is no amgi account or password stored here at all.

## Local HTTP bridge settings

These control the local HTTP bridge that lets the amgi web UI talk to this collection while Anki
is running - see `README.md`, "Local HTTP bridge", for what it does and the security model behind
it. `Tools > amgi: Bridge status...` is the easier way to see and change most of this; the fields
below are what it reads and writes.

`bridge_enabled`
Off (`false`) by default.
Set to `true`, or check the box in `Tools > amgi: Bridge status...`, to have Anki start listening
the next time a profile opens (or immediately, if you toggle it from that dialog while a profile is
already open).

`bridge_port`
Default `8798`.
The bridge always binds to `127.0.0.1`, never to `0.0.0.0` or any other interface - there is no
setting that changes that. If this port is already taken (another profile, a leftover process), the
bridge logs a warning and does not start; pick a different port here and reopen the status dialog.

`bridge_token`
Generated automatically the first time the bridge starts; leave this blank and it fills itself in.
Every request to the bridge must carry it in an `X-Amgi-Bridge-Token` header, or it is rejected
before anything it asks for happens - see `bridge_auth.py` for exactly what this does and does not
defend against. Paste this value into the amgi web UI's own local-bridge settings so it can
authenticate. Stored in plain text in this add-on's config file, the same tradeoff `openai_api_key`
above already makes: readable to anything with access to your Anki profile folder, and to nothing
else.

`bridge_allowed_origins`
Default `["http://localhost:3000", "http://127.0.0.1:3000"]` - the amgi web UI's local dev server.
A request whose `Origin` header names anything not in this list is rejected, whether or not its
token is correct. Add your own deployed amgi origin here (for example
`https://app.example.com`) if you want a non-local build of the UI to reach this bridge too.
