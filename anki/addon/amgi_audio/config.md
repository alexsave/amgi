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
