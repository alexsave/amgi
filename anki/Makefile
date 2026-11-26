# The Anki card template's script, built from amgi's own sources (anki/tools/build-loop.sh).
# Run from the repository root's make (make build) or alone: make -C anki
#
#   anki/media/_amgi-loop.js   voiceActivity.mjs + reviewLoop.mjs + anki-loop.js as one classic script
#                              (not committed; server/amgi/install.c copies it into a collection)
#   addon/amgi_bridge/wire_schema.py   the wire format's table as Python, for the bridge add-on, written by
#                              ui/wire/wire_py.c from ui/wire/wire.c (not committed; install copies the add-on)
LOOP := media/_amgi-loop.js
LOOP_SRC := src/voiceActivity.mjs src/reviewLoop.mjs src/anki-loop.js

SCHEMA := addon/amgi_bridge/wire_schema.py

all: $(LOOP) $(SCHEMA)

$(LOOP): tools/build-loop.sh $(LOOP_SRC)
	cd .. && anki/tools/build-loop.sh anki/$(LOOP)

# ui/Makefile owns the rule (it builds the generator from wire.c); asking it every time costs nothing when the file is fresh.
$(SCHEMA): FORCE
	$(MAKE) -s -C ../ui ../anki/$(SCHEMA)

FORCE:

.PHONY: all FORCE
