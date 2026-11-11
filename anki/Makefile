# The Anki card template's script, built from amgi's own sources (anki/tools/build-loop.sh).
# Run from the repository root's make (make build) or alone: make -C anki
#
#   anki/media/_amgi-loop.js   voiceActivity.js + reviewLoop.js + anki-loop.js as one classic script
#                              (not committed; server/amgi/install.c copies it into a collection)
LOOP := media/_amgi-loop.js
LOOP_SRC := ../src/utils/voiceActivity.js ../src/utils/reviewLoop.js src/anki-loop.js

all: $(LOOP)

$(LOOP): tools/build-loop.sh $(LOOP_SRC)
	cd .. && anki/tools/build-loop.sh anki/$(LOOP)

.PHONY: all
