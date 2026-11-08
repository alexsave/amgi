/* The sentences the amgi server says, each written once here. The file named beside each is the
 * JavaScript it was ported from; MISSING_KEY_MESSAGE and GEMINI_KEY_PAGE are also said by
 * plusaudio/generate-clip.js (plusaudio/lib/geminiKey.js), which the Anki add-on runs. */
#ifndef AMGI_MESSAGES_H
#define AMGI_MESSAGES_H

/* by mode (were src/server/anki/respond.js's MESSAGES) */
#define MSG_UNCONFIGURED "No Anki profile is selected yet. Open Settings to pick one."
#define MSG_NOT_FOUND "No collection.anki2 was found at the selected profile. Open Settings to pick a different one."
#define MSG_UNSUPPORTED_SCHEMA "This collection uses a schema version amgi does not support yet."
#define MSG_LOCKED                                                                    \
  "Anki is open on this collection and the local bridge is not reachable. "          \
  "Either close Anki, or turn on the bridge in Anki (Tools > amgi: Bridge status...) " \
  "and paste its token into Settings."
#define MSG_BRIDGE_OUTDATED                                                           \
  "The amgi add-on running in Anki is from a different amgi than this one. "         \
  "Press Install into Anki again (Settings), then restart Anki."
#define MSG_BRIDGE_NO_COLLECTION                                                      \
  "Anki is open with the bridge running, but no profile is loaded yet (the profile picker is showing). " \
  "Pick a profile in Anki."

/* plusaudio/lib/geminiKey.js */
#define GEMINI_KEY_PAGE "https://aistudio.google.com/apikey"
#define MISSING_KEY_MESSAGE                                                                    \
  "GEMINI_API_KEY is not set, so nothing was generated: get a key at " GEMINI_KEY_PAGE ", add it to " \
  ".env.local and restart amgi."

/* were src/server/anki/install.js's */
#define RESTART_MESSAGE                                                                          \
  "Installed. Restart Anki - it will add the \"amgi Listening\" note type and its files to your " \
  "collection on the way up."
#define INSTALLED_MESSAGE                                                                          \
  "Installed. The \"amgi Listening\" card type is already in your collection, so you can add cards " \
  "now. Anki picks the add-ons up the next time it starts."
#define NO_SOURCE_MESSAGE "This copy of amgi has no add-on sources in it, so there is nothing to install from."

/* src/utils/amgiNotetype.js */
#define AMGI_NOTETYPE_NAME "amgi Listening"

/* plusaudio/lib/rateLimits.js */
#define MAX_WAIT_MS 180000
#endif
