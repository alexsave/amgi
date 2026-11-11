## amgi audio fill settings

This add-on generates entirely on your own machine: no amgi account, no hosted service, and no
quota but your own Gemini account's.
It needs two things to do that, a built checkout and a Gemini key, and checks both before a run
starts so a bad setting is one clear message, not a stall or a traceback partway through.

`amgi_dir`
Required.
The full path of a checkout of this add-on's own repo (`https://github.com/alexsave/amgi`), for
example `/Users/you/amgi`, with the server built in it (`make -C server`, run in that folder).
What makes a clip is that build's `server/build/amgi-clip`, the same C code the amgi app makes its
own clips with: this add-on has no generation logic of its own, and is never going to grow a second
copy of it in Python.
It runs in this folder, so the `.env.local` there is where it looks for a key (see below).
See `../../README.md` (the repo root) if you have not checked the repo out yet.

`gemini_api_key`
Optional.
Gemini speaks every clip and checks it; get a key at https://aistudio.google.com/apikey.
Its free tier allows 10 requests per day per model, so a real deck needs billing enabled on the
key's Google project.
If you already export `GEMINI_API_KEY` in the environment Anki itself runs in, or keep it in the
`.env.local` file at the root of your checkout (the file the amgi app and `amgi-clip` both read),
leave this blank and either of those is used.
Setting it here overrides both, and is stored in this add-on's own config file, in plain text:
readable to anything with access to your Anki profile folder, and to nothing else - the same
tradeoff `.env.local` already makes for the same key.

`plusaudio_dir` and `node_path`, from before audio was made by `amgi-clip`, are no longer read.
If your config still has them, they are ignored, and you can delete them; set `amgi_dir` instead.
Node is not needed any more, and a key in `plusaudio/.env` is not read: move it to `.env.local`.

None of this add-on's earlier Supabase/amgi-account settings (`supabase_url`, `supabase_anon_key`,
`email`, `password`) exist any more.
Generation used to go through a deployed edge function and your amgi account's quota; now it runs
locally against your own Gemini key, and there is no amgi account or password stored here at all.

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
authenticate. Stored in plain text in this add-on's config file, the same tradeoff `gemini_api_key`
above already makes: readable to anything with access to your Anki profile folder, and to nothing
else.

`bridge_allowed_origins`
Default `["http://localhost:3000", "http://127.0.0.1:3000"]` - the amgi web UI's local dev server.
A request whose `Origin` header names anything not in this list is rejected, whether or not its
token is correct. Add your own deployed amgi origin here (for example
`https://app.example.com`) if you want a non-local build of the UI to reach this bridge too.
