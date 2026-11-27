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
/* input_language: "learning" (the input is in the learning language's own script) or NULL (the prompt's both-ways rule) */
str card_generation_prompt(arena *a, str user_input, str known, str learning, const char *input_language);
str card_unspeakable_retry_prompt(arena *a, str previous, str rejected, const char *reason);

/* ---- sideOrder.js ---- */
typedef struct { str front_text, back_text, spoken_reading; } card_text;
card_text card_correct_swapped_sides(arena *a, card_text t, str learning);
const char *card_detect_input_language(arena *a, str input, str learning);

/* ---- which languages a deck is in ---- */
/* One note of the sample: its note type's name and field names, and the note's field values (raw: the prompt strips them). */
typedef struct { str notetype; const str *field_names; const str *fields; size_t nfields; } card_sample;
/* Gemini's answer: each of learning and known is a language table code or "none"; high is its confidence. */
typedef struct { str learning, known; int high; } card_deck_guess;
/* The request's pieces, for the call and for the tests: the system prompt (names every code), the strict schema (learning
 * and known: the table's codes and "none"; confidence: high or low), and the text (the deck's name, up to 10 notes with
 * each field's HTML and [sound:...] gone and cut to about 80 characters, and fact_code, when not empty, as fact). */
const char *card_deck_languages_system(arena *a);
void card_schema_deck_languages(arena *a, buf *out);
str card_deck_languages_prompt(arena *a, str deck_name, const card_sample *notes, size_t n, str fact_code);
/* One text request on the cards' model: 0 and *out, or -1 with *e (the failure's kind and message, as the card calls). */
int card_detect_deck_languages(arena *a, str deck_name, const card_sample *notes, size_t n, str fact_code, card_deck_guess *out,
                               gem_err *e);

/* ---- cardGeneration.ts ---- */
/* p hears each step as it begins (progress.h; NULL: nobody watches). */
int card_generate_text(arena *a, progress *p, str user_input, str known, str learning, const char *input_language,
                       card_text *out, gem_err *e);
/* generateCardAudio: a whole WAV that passed validation, or -1 with *e. */
int card_generate_audio(arena *a, progress *p, str text, str language, str reading, str *wav, gem_err *e);
/* The same, saying which voice made the clip and how many takes it took (take may be NULL). On a failure, it says the takes tried. */
typedef struct { const char *voice; int attempts; } card_audio_take;
int card_generate_audio_take(arena *a, progress *p, str text, str language, str reading, str *wav, card_audio_take *take, gem_err *e);
#endif
