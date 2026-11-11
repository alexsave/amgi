/* The Gemini model's structured answer, the one other JSON reader in amgi's C (plusaudio/lib/json/
 * modelAnswer.js in C). The API's structured output is JSON text and nothing else
 * (plusaudio/ANSWER_FORMAT.md records what was measured against the alternatives), so this one parse
 * stays; it is the quarantine's own JSON.parse (anki_json.h), under its own name so the no-JSON
 * scan counts it with its own reason. The caller checks the value against its format
 * (server/amgi/cards.c, parse_structured). */
#ifndef AMGI_MODEL_ANSWER_H
#define AMGI_MODEL_ANSWER_H
#include "anki_json.h"

/* The answer's value, or NULL with *detail saying why the text is not JSON: not JSON: "<the first
 * 80 UTF-16 units of the text>". */
aj *model_answer_parse(arena *a, str text, str *detail);
#endif
