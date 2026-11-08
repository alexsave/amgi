/* src/utils/ankiFields.js's guessFields: which of a note type's fields is the text to read and which
 * holds its audio. The name patterns are ASCII, and JS's /i folds ASCII letters only against them,
 * so ASCII folding here is the same match. */
#include "app.h"

static int in_set(const text *t, const char *const *set) {
  for (; *set; set++)
    if (same_ascii_nocase(t->p, t->len, *set)) return 1;
  return 0;
}
/* ends with audio|sound, case folded: the length of the name without it, or -1 */
static int32_t stem_len(const text *t) {
  static const char *const SUFFIX[] = {"audio", "sound"};
  for (int i = 0; i < 2; i++) {
    uint32_t n = zlen(SUFFIX[i]);
    if (t->len >= n && same_ascii_nocase(t->p + t->len - n, n, SUFFIX[i])) return (int32_t)(t->len - n);
  }
  return -1;
}
static const char *const AUDIO_EXACT[] = {"audio", "sound", "pronunciation", "tts", "speech", 0};
static const char *const TEXT_NAMES[] = {"korean", "japanese", "chinese", "target", "foreign", "learning", "term", "word",
                                         "expression", "sentence", "front", "text", 0};
static int is_audio(const text *t) { return in_set(t, AUDIO_EXACT) || stem_len(t) >= 0; }

field_guess guess_fields(const text *names, uint32_t n, uint32_t sort_field) {
  int32_t audio = -1, text_i = -1, nlike = 0;
  for (uint32_t i = 0; i < n; i++)
    if (is_audio(&names[i])) {
      if (audio < 0) audio = (int32_t)i;
      nlike++;
    }
  for (uint32_t i = 0; i < n && text_i < 0; i++)
    if ((int32_t)i != audio && in_set(&names[i], TEXT_NAMES)) text_i = (int32_t)i;
  if (text_i < 0 && sort_field != WIRE_NONE && (int32_t)sort_field != audio && sort_field < n) text_i = (int32_t)sort_field;
  for (uint32_t i = 0; i < n && text_i < 0; i++)
    if ((int32_t)i != audio) text_i = (int32_t)i;

  int32_t cue = -1;
  if (nlike >= 2) {
    /* the CueAudio/TargetAudio shape: the clip that reads aloud is "<the text field>Audio", else the
     * first audio field after the text field, else the first; the other is the cue's */
    const text *tn = text_i >= 0 ? &names[text_i] : 0;
    int32_t stem_match = -1, after = -1, first = -1;
    for (uint32_t i = 0; i < n; i++) {
      if (!is_audio(&names[i])) continue;
      if (first < 0) first = (int32_t)i;
      if (after < 0 && (int32_t)i > text_i) after = (int32_t)i;
      int32_t sl = stem_len(&names[i]);
      if (stem_match < 0) {
        if (tn && sl >= 0 && (uint32_t)sl == tn->len) {
          int eq = 1;
          for (uint32_t k = 0; k < tn->len && eq; k++) {
            char a = names[i].p[k], b = tn->p[k];
            if (a >= 'A' && a <= 'Z') a = (char)(a + 32);
            if (b >= 'A' && b <= 'Z') b = (char)(b + 32);
            eq = a == b;
          }
          if (eq) stem_match = (int32_t)i;
        } else if (!tn && sl == 0) {
          stem_match = (int32_t)i; /* no text field: its name reads as "", which a bare "Audio" stems to */
        }
      }
    }
    audio = stem_match >= 0 ? stem_match : after >= 0 ? after : first;
    for (uint32_t i = 0; i < n && cue < 0; i++)
      if (is_audio(&names[i]) && (int32_t)i != audio) cue = (int32_t)i;
  }
  return (field_guess){text_i, audio, cue};
}

/* amgiNotetype.js's fieldIndexes: by name, case folded, never by position. The names asked for are
 * ASCII, so folding ASCII letters is the whole of toLowerCase's effect on a match. They are the
 * names anki/notetype's templates read; ui/test/template.test.mjs holds the two to each other. */
const char *const AMGI_FIELD_NAMES[6] = {"Cue", "CueAudio", "Target", "TargetAudio", "Language", "Notes"};
amgi_fields amgi_fields_of(const text *names, uint32_t n) {
  int32_t at[6];
  for (int f = 0; f < 6; f++) {
    at[f] = -1;
    for (uint32_t i = 0; i < n && at[f] < 0; i++)
      if (same_ascii_nocase(names[i].p, names[i].len, AMGI_FIELD_NAMES[f])) at[f] = (int32_t)i;
  }
  return (amgi_fields){at[0], at[1], at[2], at[3], at[4], at[5]};
}
