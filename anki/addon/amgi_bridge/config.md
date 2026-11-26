## amgi bridge settings

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
authenticate. Stored in plain text in this add-on's config file, readable to anything with access to your Anki profile folder, and to nothing
else.

`bridge_allowed_origins`
Default `["http://localhost:3000", "http://127.0.0.1:3000"]` - the amgi web UI's local dev server.
A request whose `Origin` header names anything not in this list is rejected, whether or not its
token is correct. Add your own deployed amgi origin here (for example
`https://app.example.com`) if you want a non-local build of the UI to reach this bridge too.
