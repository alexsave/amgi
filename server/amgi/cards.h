/* The card generation policy in C (cards.c says what it ports). */
#ifndef AMGI_CARDS_H
#define AMGI_CARDS_H
#include "gemini.h"

/* ---- cardText.ts ---- */
str card_normalize_language_code(arena *a, str language);
str card_language_name(arena *a, str language);
int card_reading_is_ambiguous(arena *a, str language);
int card_uses_non_latin_script(arena *a, str language);
int card_has_native_script(arena *a, str text, str language);
str card_spoken_form(arena *a, str text);
str card_speakable_utterance(arena *a, str text);
const char *card_unspeakable_reason(arena *a, str text);
/* composeKnownSide with up to two tags (NULL or empty: none) */
str card_compose_known_side(arena *a, str text, str tag1, const char *tag2);
/* registerTag: the label, or NULL */
const char *card_register_tag(arena *a, str language, str level);
str card_normalize_for_comparison(arena *a, str text, str language);
str card_korean_pronunciation(arena *a, str text);

/* ---- cardPrompts.ts ---- */
/* input_language: "known", "learning" or NULL */
str card_generation_prompt(arena *a, str user_input, str known, str learning, const char *input_language);
str card_unspeakable_retry_prompt(arena *a, str previous, str rejected, const char *reason);
/* The response formats' schemas, as google.protobuf.Value bytes (for the request and the tests). */
void card_schema_generated(buf *out);
void card_schema_audio_verdict(buf *out);
void card_schema_transcription_match(buf *out);

/* ---- sideOrder.js ---- */
typedef struct { str front_text, back_text, spoken_reading; } card_text;
card_text card_correct_swapped_sides(arena *a, card_text t, str learning);
const char *card_detect_input_language(arena *a, str input, str known, str learning);

/* ---- cardGeneration.ts ---- */
int card_generate_text(arena *a, str user_input, str known, str learning, const char *input_language, card_text *out,
                       gem_err *e);
/* generateCardAudio: a whole WAV that passed validation, or -1 with *e. */
int card_generate_audio(arena *a, str text, str language, str reading, str *wav, gem_err *e);
#endif
