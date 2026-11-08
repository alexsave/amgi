/* The card generation policy in C: plusaudio/lib/cardGeneration/cardText.ts (the text policy: names,
 * register, variety, readings, the speakable rules, Korean pronunciation), cardPrompts.ts (the
 * prompts), cardGeneration.ts (the structured calls, the corrective retry, the synthesise-
 * transcribe-judge loop) and src/server/anki/sideOrder.js (which side is which, by script).
 * Only the paths the server takes are here: a new card from input (generateCardText's 'generate'
 * mode) and a clip of one side (generateCardAudio). cards.h says what each call answers. */
#include "cards.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unicode/uchar.h>
#include <unicode/unorm2.h>
#include <unicode/uscript.h>

#include "../json/model_answer.h"

static const struct { const char *code, *name; } LANGUAGE_NAMES[] = {
  {"en", "English"},
  {"es", "Spanish"},
  {"fr", "French"},
  {"pt", "Portuguese"},
  {"it", "Italian"},
  {"de", "German"},
  {"ru", "Russian"},
  {"zh_cn", "Mandarin Chinese"},
  {"zh_hk", "Cantonese"},
  {"ja", "Japanese"},
  {"ko", "Korean"},
  {"vi", "Vietnamese"},
  {"th", "Thai"},
  {"id", "Indonesian"},
  {"hi", "Hindi"},
  {"ur", "Urdu"},
  {"ar", "Arabic"},
  {"tr", "Turkish"},
};
static const struct { const char *code, *guidance; } REGISTER_POLICIES[] = {
  {"ko", "Korean marks politeness in the verb ending, so a level is chosen on every card. Default to 해요체, the polite informal style (-요 / -아요 / -어요, questions in -요?): it is what an adult uses with a stranger of any age without sounding either rude or ceremonial. Use 반말 (plain style) only when the input is itself in 반말 or explicitly says it is for a close friend, and use 합쇼체 (-습니다 / -십시오) only where it is the fixed normal form of the expression (감사합니다, 죄송합니다, 안녕하세요) or the input is explicitly a formal or service-industry line. Keep one level across the whole utterance."},
  {"ja", "Japanese marks politeness in the verb, so a level is chosen on every card. Default to the です／ます style (丁寧語): it is usable with a stranger, a colleague or a teacher without offence. Use plain / dictionary-form endings only when the input is itself in plain form or explicitly says it is for a close friend, and use 尊敬語 or 謙譲語 only when the input is explicitly about serving or addressing a customer or a superior. Keep one level across the whole utterance."},
  {"es", "Spanish chooses a second person on every card that addresses someone. Default to usted (with third-person verb agreement) for a single listener, which is safe with a stranger. Use tú when the input itself implies closeness (a friend, a child, a term of endearment, \"I love you\")."},
  {"fr", "French chooses a second person on every card that addresses someone. Default to vous for a single listener, which is what a stranger expects. Use tu only when the input itself implies closeness (a friend, a child, a term of endearment)."},
  {"de", "German chooses a second person on every card that addresses someone. Default to Sie, which is what a stranger expects. Use du only when the input itself implies closeness (a friend, a child, a family member)."},
  {"it", "Italian chooses a second person on every card that addresses someone. Default to Lei (third-person agreement) for a single listener. Use tu only when the input itself implies closeness."},
  {"pt", "European Portuguese chooses a form of address on every card that addresses someone. Default to the polite third person (o senhor / a senhora, or the bare third-person verb without a pronoun), which is what a stranger expects in Portugal. Use tu only when the input itself implies closeness. Avoid bare \"você\", which is not neutral in European Portuguese."},
  {"ru", "Russian chooses a second person on every card that addresses someone. Default to вы for a single listener. Use ты only when the input itself implies closeness (a friend, a child, a family member)."},
  {"tr", "Turkish chooses a second person on every card that addresses someone. Default to siz for a single listener. Use sen only when the input itself implies closeness."},
  {"vi", "Vietnamese encodes the relationship in the pronouns themselves. Default to tôi for the speaker and anh / chị for an adult listener, which is neutral and safe with a stranger. Follow the input when it names the relationship (em, bạn, con, ông, bà)."},
  {"hi", "Hindi chooses a second person on every card that addresses someone. Default to आप with plural-verb agreement. Use तुम only when the input itself implies closeness, and never तू."},
  {"ur", "Urdu chooses a second person on every card that addresses someone. Default to آپ with plural-verb agreement. Use تم only when the input itself implies closeness, and never تو."},
  {"id", "Indonesian chooses a form of address on every card that addresses someone. Default to Anda for a single listener, and saya for the speaker. Use kamu / aku only when the input itself implies closeness."},
  {"ar", "Write Modern Standard Arabic in its neutral register. When the addressee's gender is not given by the input, use the masculine singular, which is the unmarked form."},
  {"th", "Thai marks politeness with a sentence-final particle that depends on the SPEAKER's gender, and this app does not know the learner's gender, so do not assign one: include ครับ / ค่ะ only where the particle is part of the fixed expression itself (สวัสดีครับ, ขอบคุณครับ), and otherwise write the polite-neutral sentence without a final particle rather than guessing. Address the listener as คุณ."},
};
static const struct { const char *code, *variety; } LANGUAGE_VARIETIES[] = {
  {"es", "European Spanish as spoken in Spain (the voice that reads this card is Castilian)."},
  {"pt", "European Portuguese as spoken in Portugal (the voice that reads this card is European)."},
  {"ar", "Modern Standard Arabic, not a regional dialect (the voice that reads this card speaks MSA)."},
  {"zh_cn", "Mandarin as spoken on the mainland, written in simplified characters."},
  {"zh_hk", "Colloquial Cantonese as spoken in Hong Kong, written the way it is spoken (traditional characters, Cantonese vocabulary and particles - not Standard Written Chinese)."},
  {"ja", "Standard Tokyo Japanese."},
  {"ko", "Standard Seoul Korean."},
  {"en", "Neutral, widely understood English."},
};
#define CARD_GENERATION_SYSTEM_PROMPT "You write flashcards for an app in which every card is heard and spoken, never only read. Both sides are sent to a speech synthesiser exactly as you write them, and the learner repeats the learning-language side out loud.\n\nSo a card side is one natural utterance that a person could actually say - not a dictionary entry, not a list of senses, not a headword with a gloss attached. A side that cannot be said out loud is a broken card even when every word in it is correct."
#define TEXT_MODEL "gemini-3.8-flash"
#define TRANSCRIBE_MODEL "gemini-3.8-flash"
#define JUDGE_MODEL "gemini-3.8-flash"
#define THINKING_LEVEL "LOW"
static const struct { const char *code, *system; } READING_SYSTEMS[] = {
  {"ja", "hiragana (for example 行った read as one word: \"いった\" - never romaji)"},
  {"zh_cn", "Zhuyin/Bopomofo (注音符号) with tone marks (for example \"ㄒㄧㄥˊ ㄌㄜ˙\" - never pinyin)"},
  {"zh_hk", "Cantonese Bopomofo (粵語注音符號) - never Jyutping or Yale romanization"},
};
#define N(x) (sizeof(x) / sizeof *(x))

/* ---- text as code points ---- */
typedef struct { uint32_t *v; size_t n; } cps;
static cps cps_of(arena *a, str s) {
  cps c = {ar_alloc(a, (s.n + 1) * sizeof(uint32_t)), 0};
  for (size_t at = 0; at < s.n;) c.v[c.n++] = utf8_next(s, &at);
  return c;
}
static str str_of(arena *a, cps c) {
  buf b = {0};
  for (size_t i = 0; i < c.n; i++) utf8_put(&b, c.v[i]);
  str out = buf_str(a, &b);
  buf_free(&b);
  return out;
}
static cps cps_new(arena *a, size_t cap) { return (cps){ar_alloc(a, (cap + 1) * sizeof(uint32_t)), 0}; }
static int in_set(uint32_t c, const uint32_t *set, size_t n) {
  for (size_t i = 0; i < n; i++)
    if (set[i] == c) return 1;
  return 0;
}
#define IN(c, ...) in_set((c), (const uint32_t[]){__VA_ARGS__}, sizeof((const uint32_t[]){__VA_ARGS__}) / sizeof(uint32_t))

/* ---- languages ---- */
str card_normalize_language_code(arena *a, str language) {
  str low = js_lower(a, language);
  char *p = ar_alloc(a, low.n + 1);
  for (size_t i = 0; i < low.n; i++) p[i] = low.p[i] == '-' ? '_' : low.p[i];
  return js_trim((str){p, low.n});
}
#define LOOKUP(table, field, code)                                  \
  for (size_t i_ = 0; i_ < N(table); i_++)                          \
    if (str_eq_c((code), table[i_].code)) return table[i_].field;
static const char *name_of(str code) { LOOKUP(LANGUAGE_NAMES, name, code) return NULL; }
static const char *policy_of(str code) { LOOKUP(REGISTER_POLICIES, guidance, code) return NULL; }
static const char *variety_of(str code) { LOOKUP(LANGUAGE_VARIETIES, variety, code) return NULL; }
static const char *reading_of(str code) { LOOKUP(READING_SYSTEMS, system, code) return NULL; }

str card_language_name(arena *a, str language) {
  str code = card_normalize_language_code(a, language);
  const char *n = name_of(code);
  return n ? str_c(n) : code.n ? code : S("the target language");
}
int card_reading_is_ambiguous(arena *a, str language) {
  str c = card_normalize_language_code(a, language);
  return str_eq_c(c, "ja") || str_eq_c(c, "zh_cn") || str_eq_c(c, "zh_hk");
}

/* NATIVE_SCRIPT_PATTERNS: the scripts each non-Latin-script language is written in. */
static int native_scripts(str code, UScriptCode out[3]) {
  static const struct { const char *code; UScriptCode s[3]; int n; } P[] = {
    {"ko", {USCRIPT_HANGUL}, 1}, {"ja", {USCRIPT_HIRAGANA, USCRIPT_KATAKANA, USCRIPT_HAN}, 3},
    {"zh_cn", {USCRIPT_HAN}, 1}, {"zh_hk", {USCRIPT_HAN}, 1}, {"ru", {USCRIPT_CYRILLIC}, 1},
    {"ar", {USCRIPT_ARABIC}, 1}, {"ur", {USCRIPT_ARABIC}, 1}, {"hi", {USCRIPT_DEVANAGARI}, 1}, {"th", {USCRIPT_THAI}, 1}};
  for (size_t i = 0; i < N(P); i++)
    if (str_eq_c(code, P[i].code)) {
      memcpy(out, P[i].s, sizeof P[i].s);
      return P[i].n;
    }
  return 0;
}
int card_uses_non_latin_script(arena *a, str language) {
  UScriptCode s[3];
  return native_scripts(card_normalize_language_code(a, language), s) > 0;
}
int card_has_native_script(arena *a, str text, str language) {
  UScriptCode s[3];
  int n = native_scripts(card_normalize_language_code(a, language), s);
  for (size_t at = 0; n && at < text.n;) {
    uint32_t cp = utf8_next(text, &at);
    UErrorCode err = U_ZERO_ERROR;
    UScriptCode sc = uscript_getScript((UChar32)cp, &err);
    for (int i = 0; i < n; i++)
      if (sc == s[i]) return 1;
  }
  return 0;
}

/* REGISTER_LEVELS, the one list of them: the register field's enum in the schema, the check of the
 * model's answer, and the known side's label all read it. Every policy's default is "polite". */
static const char *const REGISTER_LEVELS[] = {"casual", "polite", "formal"};
#define DEFAULT_LEVEL 1
static int register_level(str s) {
  for (int i = 0; i < (int)N(REGISTER_LEVELS); i++)
    if (str_eq_c(s, REGISTER_LEVELS[i])) return i;
  return -1;
}

const char *card_register_tag(arena *a, str language, str level) {
  if (!policy_of(card_normalize_language_code(a, language)) || !level.n) return NULL;
  int i = register_level(js_lower(a, js_trim(level)));
  return i < 0 || i == DEFAULT_LEVEL ? NULL : REGISTER_LEVELS[i];
}

/* ---- text shaping ---- */
static int ws(uint32_t c) { return js_space(c); }

/* tidy: blanks collapsed, the space before punctuation dropped, the ends cleaned, trimmed. */
static cps tidy(arena *a, cps in) {
  cps one = cps_new(a, in.n);
  for (size_t i = 0; i < in.n; i++) {
    if (ws(in.v[i])) {
      one.v[one.n++] = ' ';
      while (i + 1 < in.n && ws(in.v[i + 1])) i++;
    } else {
      one.v[one.n++] = in.v[i];
    }
  }
  cps two = cps_new(a, one.n);
  for (size_t i = 0; i < one.n; i++) {
    if (one.v[i] == ' ' && i + 1 < one.n &&
        IN(one.v[i + 1], ',', '.', '!', '?', ';', ':', 0x3001, 0x3002, 0xff01, 0xff1f, 0xff0c, 0xff1b, 0xff1a))
      continue;
    two.v[two.n++] = one.v[i];
  }
  size_t from = 0, to = two.n;
  while (from < to && (ws(two.v[from]) || IN(two.v[from], ',', 0x3001, 0xff0c, ';', 0xff1b, ':', 0xff1a, '.', 0x3002, '!',
                                              0xff01, '?', 0xff1f, '/', '|')))
    from++;
  while (to > from && (ws(two.v[to - 1]) || IN(two.v[to - 1], ',', 0x3001, 0xff0c, ';', 0xff1b, ':', 0xff1a, '/', '|'))) to--;
  while (from < to && ws(two.v[from])) from++;
  while (to > from && ws(two.v[to - 1])) to--;
  return (cps){two.v + from, to - from};
}

/* One pass of /[open][^set]*[close]/g, each match replaced by a space. */
static cps strip_pass(arena *a, cps in, const uint32_t *open, size_t nopen, const uint32_t *stop, size_t nstop,
                      const uint32_t *close, size_t nclose) {
  cps out = cps_new(a, in.n);
  for (size_t i = 0; i < in.n;) {
    if (in_set(in.v[i], open, nopen)) {
      size_t j = i + 1;
      while (j < in.n && !in_set(in.v[j], stop, nstop)) j++;
      if (j < in.n && in_set(in.v[j], close, nclose)) {
        out.v[out.n++] = ' ';
        i = j + 1;
        continue;
      }
    }
    out.v[out.n++] = in.v[i++];
  }
  return out;
}
static cps strip_annotations(arena *a, cps in) {
  static const uint32_t PO[] = {0xff08, '('}, PS[] = {0xff08, '(', ')', 0xff09}, PC[] = {0xff09, ')'};
  static const uint32_t BO[] = {0xff3b, '['}, BS[] = {0xff3b, '[', ']', 0xff3d}, BC[] = {0xff3d, ']'};
  cps one = strip_pass(a, in, PO, 2, PS, 4, PC, 2);
  return strip_pass(a, one, BO, 2, BS, 4, BC, 2);
}

str card_spoken_form(arena *a, str text) {
  cps t = tidy(a, strip_annotations(a, cps_of(a, text)));
  return t.n ? str_of(a, t) : js_trim(text);
}

/* /^\s*(?:[-*•]|\d+\s*[.)、])\s*​/: the length of the list marker at the start, or 0 for none. */
static size_t list_marker(cps c) {
  size_t i = 0;
  while (i < c.n && ws(c.v[i])) i++;
  if (i < c.n && IN(c.v[i], '-', '*', 0x2022)) {
    i++;
  } else {
    size_t d = i;
    while (d < c.n && c.v[d] >= '0' && c.v[d] <= '9') d++;
    if (d == i) return 0;
    while (d < c.n && ws(c.v[d])) d++;
    if (d >= c.n || !IN(c.v[d], '.', ')', 0x3001)) return 0;
    i = d + 1;
  }
  while (i < c.n && ws(c.v[i])) i++;
  return i;
}

str card_speakable_utterance(arena *a, str text) {
  str source = js_trim(text);
  if (!source.n) return S("");
  cps without = strip_annotations(a, cps_of(a, source));
  cps first = without;
  for (size_t i = 0; i < without.n; i++)
    if (IN(without.v[i], '/', '|', 0xff5c)) {
      first.n = i;
      break;
    }
  size_t m = list_marker(first);
  cps rest = {first.v + m, first.n - m};
  while (rest.n && IN(rest.v[0], '"', '\'', 0x201c, 0x201d, 0x201e, 0xab, 0x300e, 0x300c)) rest.v++, rest.n--;
  while (rest.n && IN(rest.v[rest.n - 1], '"', '\'', 0x201c, 0x201d, 0x201e, 0xbb, 0x300f, 0x300d)) rest.n--;
  cps t = tidy(a, rest);
  if (t.n) return str_of(a, t);
  t = tidy(a, without);
  return t.n ? str_of(a, t) : source;
}

const char *card_unspeakable_reason(arena *a, str text) {
  str source = js_trim(text);
  if (!source.n) return "it is empty";
  cps c = cps_of(a, source);
  for (size_t i = 0; i < c.n; i++)
    if (IN(c.v[i], 0xff08, '(', 0xff3b, '[')) return "it contains a parenthesized gloss or annotation";
  for (size_t i = 0; i < c.n; i++)
    if (IN(c.v[i], '/', '|', 0xff5c)) return "it offers alternatives separated by a slash";
  for (size_t i = 0; i < c.n; i++)
    if (IN(c.v[i], ';', 0xff1b)) return "it joins separate phrases with a semicolon";
  if (list_marker(c)) return "it is written as a list item rather than an utterance";
  return NULL;
}

/* One label: trimmed, one opening bracket off the front and one closing off the end, trimmed. */
static str label_of(arena *a, str tag) {
  cps c = cps_of(a, js_trim(tag));
  if (c.n && IN(c.v[0], 0xff08, '(')) c.v++, c.n--;
  if (c.n && IN(c.v[c.n - 1], 0xff09, ')')) c.n--;
  return js_trim(str_of(a, c));
}

str card_compose_known_side(arena *a, str text, str tag1, const char *tag2) {
  str base = card_spoken_form(a, text);
  str labels[2], seen[2];
  size_t n = 0;
  str tags[2] = {tag1, tag2 ? str_c(tag2) : S("")};
  for (int i = 0; i < 2; i++) {
    str label = label_of(a, tags[i]);
    if (!label.n) continue;
    str low = js_lower(a, label);
    int dup = 0;
    for (size_t k = 0; k < n; k++) dup |= str_eq(seen[k], low);
    if (dup) continue;
    seen[n] = low;
    labels[n++] = label;
  }
  if (!n) return base;
  buf b = {0};
  buf_s(&b, base);
  buf_c(&b, " (");
  for (size_t i = 0; i < n; i++) {
    if (i) buf_c(&b, " \xc2\xb7 ");
    buf_s(&b, labels[i]);
  }
  buf_ch(&b, ')');
  str out = buf_str(a, &b);
  buf_free(&b);
  return out;
}

/* ---- normalizeForComparison ---- */
static str nfkc(arena *a, str s) {
  UErrorCode err = U_ZERO_ERROR;
  const UNormalizer2 *n = unorm2_getNFKCInstance(&err);
  if (U_FAILURE(err)) return s;
  /* to UTF-16, normalize, back */
  cps c = cps_of(a, s);
  UChar *in = ar_alloc(a, (2 * c.n + 1) * sizeof(UChar));
  int32_t len = 0;
  for (size_t i = 0; i < c.n; i++) {
    if (c.v[i] >= 0x10000) {
      in[len++] = (UChar)(0xd7c0 + (c.v[i] >> 10));
      in[len++] = (UChar)(0xdc00 | (c.v[i] & 0x3ff));
    } else {
      in[len++] = (UChar)c.v[i];
    }
  }
  int32_t cap = len * 18 + 16;
  UChar *out = ar_alloc(a, (size_t)cap * sizeof(UChar));
  int32_t m = unorm2_normalize(n, in, len, out, cap, &err);
  if (U_FAILURE(err)) return s;
  buf b = {0};
  for (int32_t i = 0; i < m; i++) {
    uint32_t u = out[i];
    if (u >= 0xd800 && u < 0xdc00 && i + 1 < m && out[i + 1] >= 0xdc00 && out[i + 1] < 0xe000) {
      u = 0x10000 + ((u - 0xd800) << 10) + (out[i + 1] - 0xdc00u);
      i++;
    }
    utf8_put(&b, u);
  }
  str r = buf_str(a, &b);
  buf_free(&b);
  return r;
}
static int punct_or_symbol(uint32_t c) {
  int8_t t = u_charType((UChar32)c);
  return t == U_CONNECTOR_PUNCTUATION || t == U_DASH_PUNCTUATION || t == U_START_PUNCTUATION || t == U_END_PUNCTUATION ||
         t == U_INITIAL_PUNCTUATION || t == U_FINAL_PUNCTUATION || t == U_OTHER_PUNCTUATION || t == U_MATH_SYMBOL ||
         t == U_CURRENCY_SYMBOL || t == U_MODIFIER_SYMBOL || t == U_OTHER_SYMBOL;
}
str card_normalize_for_comparison(arena *a, str text, str language) {
  cps c = cps_of(a, js_lower(a, nfkc(a, text)));
  cps out = cps_new(a, c.n);
  for (size_t i = 0; i < c.n; i++)
    if (!punct_or_symbol(c.v[i]) && !ws(c.v[i])) out.v[out.n++] = c.v[i];
  str spelled = str_of(a, out);
  str code = card_normalize_language_code(a, language);
  const char *u = memchr(code.p, '_', code.n);
  str first = u ? str_sub(code, 0, (size_t)(u - code.p)) : code;
  return str_eq_c(first, "ko") ? card_korean_pronunciation(a, spelled) : spelled;
}

/* ---- Korean pronunciation (cardText.ts koreanPronunciation: the rules it lists, and only those) ---- */
#define HANGUL_BASE 0xac00
#define HANGUL_LAST 0xd7a3
static const uint32_t INITIALS[] = {0x3131, 0x3132, 0x3134, 0x3137, 0x3138, 0x3139, 0x3141, 0x3142, 0x3143, 0x3145,
                                    0x3146, 0x3147, 0x3148, 0x3149, 0x314a, 0x314b, 0x314c, 0x314d, 0x314e};
static const uint32_t FINALS[] = {0,      0x3131, 0x3132, 0x3133, 0x3134, 0x3135, 0x3136, 0x3137, 0x3139, 0x313a,
                                  0x313b, 0x313c, 0x313d, 0x313e, 0x313f, 0x3140, 0x3141, 0x3142, 0x3144, 0x3145,
                                  0x3146, 0x3147, 0x3148, 0x314a, 0x314b, 0x314c, 0x314d, 0x314e};
enum {
  J_G = 0x3131, J_GG = 0x3132, J_GS = 0x3133, J_N = 0x3134, J_NJ = 0x3135, J_NH = 0x3136, J_D = 0x3137, J_DD = 0x3138,
  J_L = 0x3139, J_LG = 0x313a, J_LM = 0x313b, J_LB = 0x313c, J_LS = 0x313d, J_LT = 0x313e, J_LP = 0x313f, J_LH = 0x3140,
  J_M = 0x3141, J_B = 0x3142, J_BB = 0x3143, J_BS = 0x3144, J_S = 0x3145, J_SS = 0x3146, J_NG = 0x3147, J_J = 0x3148,
  J_JJ = 0x3149, J_CH = 0x314a, J_K = 0x314b, J_T = 0x314c, J_P = 0x314d, J_H = 0x314e,
};
#define VOWEL_I 20
#define VOWEL_YE 7
#define VOWEL_E 5

typedef struct { uint32_t initial; int vowel; uint32_t final; int hangul; uint32_t other; } syl;

static int cluster_of(uint32_t f, uint32_t *x, uint32_t *y) {
  static const uint32_t C[][3] = {{J_GS, J_G, J_S}, {J_NJ, J_N, J_J}, {J_NH, J_N, J_H}, {J_LG, J_L, J_G},
                                  {J_LM, J_L, J_M}, {J_LB, J_L, J_B}, {J_LS, J_L, J_S}, {J_LT, J_L, J_T},
                                  {J_LP, J_L, J_P}, {J_LH, J_L, J_H}, {J_BS, J_B, J_S}};
  for (size_t i = 0; i < N(C); i++)
    if (C[i][0] == f) return *x = C[i][1], *y = C[i][2], 1;
  return 0;
}
/* NEUTRAL[f], or 0 when f has no entry (then the caller keeps f) */
static uint32_t neutral(uint32_t f) {
  switch (f) {
  case J_G: case J_GG: case J_K: case J_GS: case J_LG: return J_G;
  case J_N: case J_NJ: case J_NH: return J_N;
  case J_D: case J_S: case J_SS: case J_J: case J_CH: case J_T: case J_H: return J_D;
  case J_L: case J_LB: case J_LS: case J_LT: case J_LH: return J_L;
  case J_M: case J_LM: return J_M;
  case J_B: case J_P: case J_LP: case J_BS: return J_B;
  case J_NG: return J_NG;
  default: return 0;
  }
}
static uint32_t aspirated(uint32_t c) { return c == J_G ? J_K : c == J_D ? J_T : c == J_B ? J_P : c == J_J ? J_CH : 0; }
static uint32_t tense(uint32_t c) {
  return c == J_G ? J_GG : c == J_D ? J_DD : c == J_B ? J_BB : c == J_S ? J_SS : c == J_J ? J_JJ : 0;
}
static uint32_t nasal(uint32_t c) { return c == J_G ? J_NG : c == J_D ? J_N : c == J_B ? J_M : 0; }
/* WITHOUT_H: 1 and what is left, for an ㅎ final */
static int without_h(uint32_t f, uint32_t *rest) {
  if (f == J_H) return *rest = 0, 1;
  if (f == J_NH) return *rest = J_N, 1;
  if (f == J_LH) return *rest = J_L, 1;
  return 0;
}
static uint32_t aspirate_with_h(uint32_t c, int next_vowel) {
  if (c == J_G || c == J_GG || c == J_K) return J_K;
  if (c == J_B || c == J_P) return J_P;
  if (c == J_J || c == J_CH) return J_CH;
  if (c == J_D || c == J_T) return next_vowel == VOWEL_I ? J_CH : J_T;
  if (c == J_S || c == J_SS) return J_T;
  return 0;
}

static void apply_boundary(syl *a, syl *b) {
  uint32_t original = a->final, fin = a->final, ini = b->initial;
  if (!fin) {
    if (ini == J_NG && b->vowel == VOWEL_YE) b->vowel = VOWEL_E;
    return;
  }
  uint32_t rest;
  if (without_h(fin, &rest)) {
    if (aspirated(ini)) {
      b->initial = aspirated(ini);
      a->final = rest;
      return;
    }
    if (ini == J_S) {
      b->initial = J_SS;
      a->final = rest;
      return;
    }
    if (ini == J_N) {
      a->final = fin == J_H ? J_N : rest;
      if (a->final == J_L) b->initial = J_L;
      return;
    }
    if (ini == J_NG) {
      a->final = rest;
      fin = rest;
      if (!fin) return;
    }
  }
  if (ini == J_H) {
    uint32_t x, y, kept = 0, joined = fin;
    int cl = cluster_of(fin, &x, &y);
    if (cl && !nasal(x) && x != J_S) kept = x, joined = y;
    else if (cl) joined = neutral(fin);
    uint32_t asp = aspirate_with_h(joined, b->vowel);
    if (asp) {
      a->final = kept;
      b->initial = asp;
    }
    return;
  }
  if (ini == J_NG && fin != J_NG) {
    if ((fin == J_D || fin == J_T) && b->vowel == VOWEL_I) {
      b->initial = fin == J_D ? J_J : J_CH;
      a->final = 0;
      return;
    }
    if (fin == J_LT && b->vowel == VOWEL_I) {
      a->final = J_L;
      b->initial = J_CH;
      return;
    }
    uint32_t x, y;
    if (cluster_of(fin, &x, &y)) {
      a->final = x;
      b->initial = nasal(x) && tense(y) ? tense(y) : y;
      return;
    }
    b->initial = fin;
    a->final = 0;
    return;
  }
  if (original == J_LG && ini == J_G) {
    a->final = J_L;
    b->initial = J_GG;
    return;
  }
  fin = neutral(fin) ? neutral(fin) : fin;
  a->final = fin;
  if ((original == J_NJ || original == J_LM || original == J_LB || original == J_LT) && tense(ini)) {
    b->initial = tense(ini);
    return;
  }
  if (ini == J_L) {
    if (fin == J_M || fin == J_NG) b->initial = J_N;
    else if (nasal(fin)) {
      b->initial = J_N;
      a->final = nasal(fin);
    } else if (fin == J_N) a->final = J_L;
    return;
  }
  if (ini == J_N) {
    if (fin == J_L) b->initial = J_L;
    else if (nasal(fin)) a->final = nasal(fin);
    return;
  }
  if (ini == J_M) {
    if (nasal(fin)) a->final = nasal(fin);
    return;
  }
  if (nasal(fin) && tense(ini)) b->initial = tense(ini);
}

static int index_of(const uint32_t *v, size_t n, uint32_t x) {
  for (size_t i = 0; i < n; i++)
    if (v[i] == x) return (int)i;
  return -1;
}

str card_korean_pronunciation(arena *a, str text) {
  cps c = cps_of(a, text);
  syl *u = ar_alloc(a, (c.n + 1) * sizeof *u);
  for (size_t i = 0; i < c.n; i++) {
    uint32_t cp = c.v[i];
    if (cp < HANGUL_BASE || cp > HANGUL_LAST) {
      u[i] = (syl){0, 0, 0, 0, cp};
      continue;
    }
    uint32_t idx = cp - HANGUL_BASE;
    u[i] = (syl){INITIALS[idx / 588], (int)((idx % 588) / 28), FINALS[idx % 28], 1, 0};
  }
  for (size_t i = 0; i < c.n; i++) {
    if (!u[i].hangul) continue;
    if (i + 1 < c.n && u[i + 1].hangul) apply_boundary(&u[i], &u[i + 1]);
    else if (neutral(u[i].final)) u[i].final = neutral(u[i].final);
  }
  buf b = {0};
  for (size_t i = 0; i < c.n; i++) {
    if (!u[i].hangul) {
      utf8_put(&b, u[i].other);
      continue;
    }
    int ii = index_of(INITIALS, N(INITIALS), u[i].initial), ff = index_of(FINALS, N(FINALS), u[i].final);
    /* String.fromCodePoint of an index that is not there (-1) gives a code point below the block */
    utf8_put(&b, (uint32_t)(HANGUL_BASE + (ii * 21 + u[i].vowel) * 28 + ff));
  }
  str out = buf_str(a, &b);
  buf_free(&b);
  return out;
}

/* ---- cardPrompts.ts ---- */
static str rules(arena *a, str known_code, str learning_code) {
  str known = card_language_name(a, known_code), learning = card_language_name(a, learning_code);
  str lc = card_normalize_language_code(a, learning_code);
  const char *variety = variety_of(lc), *reading = reading_of(lc), *policy = policy_of(lc);
  str guidance = policy ? str_c(policy)
                        : str_c(ar_fmt(a, "If %.*s marks politeness or formality grammatically, use the neutral-polite level an "
                                          "adult can use with a stranger, and keep one level across the whole utterance.",
                                       (int)learning.n, learning.p));
  const char *r[8];
  int n = 0;
  r[n++] = "SPEAKABLE TEXT ONLY. known_text and learning_text are synthesised verbatim. They contain the words to be said "
           "and nothing else: no parentheses or brackets, no slashes, no \"or\", no second translation, no romanisation, no "
           "part-of-speech or gender labels, no quotation marks, no numbering, no commentary. Sentence punctuation (? ! . ,) "
           "is fine.";
  r[n++] = "EXACTLY ONE SENSE. If the input can mean more than one thing, pick the single meaning a learner is most likely "
           "to have meant in everyday speech and write the card for that meaning alone. Never put two meanings on one card: "
           "a side that reads \"calendar day, romantic outing\" is not something anyone says.";
  r[n++] = ar_fmt(a,
                  "SENSE_TAG IS EMPTY UNLESS IT TELLS TWO CARDS APART. It is a disambiguator, not a description, and it is "
                  "printed on the card, so a tag that adds nothing is text the learner reads past on every repetition. Before "
                  "writing one, name the OTHER card: the different, equally everyday meaning of the same input that someone "
                  "could have meant instead. If you cannot name that other card, sense_tag is empty. The English word "
                  "\"date\" has one (\"calendar day\" against \"romantic outing\"). \"Are you hungry?\" has none, so its "
                  "sense_tag is empty - \"hungry now\" and \"feeling hungry\" are the same meaning said again. A sentence "
                  "almost never needs a tag; a bare word sometimes does. Never restate or paraphrase the card, never name its "
                  "topic, its situation or its tone, and never repeat what the register field already reports. When a tag is "
                  "genuinely needed, write the meaning in %.*s, two or three words, no parentheses, spelled and capitalised "
                  "the way %.*s spells those words in running text.",
                  (int)known.n, known.p, (int)known.n, known.p);
  r[n++] = "KEEP THE SHAPE OF THE INPUT. A single word becomes a single word in its citation form, a phrase becomes a phrase, "
           "a sentence becomes a sentence. Do not pad a word into a full sentence and do not reduce a sentence to a word.";
  r[n++] = ar_fmt(a,
                  "REGISTER. %.*s Report in the register field which level learning_text actually came out at: \"casual\", "
                  "\"polite\" or \"formal\". When the input is already written in %.*s, keep the level the learner wrote and "
                  "report that.",
                  (int)guidance.n, guidance.p, (int)learning.n, learning.p);
  if (variety) r[n++] = ar_fmt(a, "VARIETY. Write %s", variety);
  if (card_reading_is_ambiguous(a, learning_code) && reading)
    r[n++] = ar_fmt(a,
                    "READING. %.*s spelling does not determine pronunciation, and the audio is checked against the text, so a "
                    "wrong reading of the right characters would go unnoticed. Fill spoken_reading with %s: exactly how "
                    "learning_text must be read aloud, in %.*s's own script, never romanised.",
                    (int)learning.n, learning.p, reading, (int)learning.n, learning.p);
  else
    r[n++] = ar_fmt(a, "READING. Leave spoken_reading empty: %.*s spelling already determines the pronunciation.",
                    (int)learning.n, learning.p);
  buf b = {0};
  for (int i = 0; i < n; i++) buf_fmt(&b, "%s%d. %s", i ? "\n\n" : "", i + 1, r[i]);
  str out = buf_str(a, &b);
  buf_free(&b);
  return out;
}

str card_generation_prompt(arena *a, str user_input, str known_code, str learning_code, const char *input_language) {
  str known = card_language_name(a, known_code), learning = card_language_name(a, learning_code);
#define K (int)known.n, known.p
#define L (int)learning.n, learning.p
  const char *direction;
  if (input_language && !strcmp(input_language, "learning"))
    direction = ar_fmt(a,
                       "DIRECTION. The input is written in %.*s. learning_text IS that input, corrected only for obvious "
                       "typos - do not re-translate it, do not convert it between writing systems, and keep any words it "
                       "already contains from another language exactly as they are. known_text is its translation into "
                       "%.*s, and must contain no %.*s at all.",
                       L, K, L);
  else if (input_language && !strcmp(input_language, "known"))
    direction = ar_fmt(a,
                       "DIRECTION. The input is written in %.*s. known_text IS that input, corrected only for obvious typos, "
                       "and learning_text is its translation into %.*s.",
                       K, L);
  else
    direction = ar_fmt(a,
                       "DIRECTION. If the input is written in %.*s, known_text is that input, corrected only for obvious "
                       "typos, and learning_text is its translation. If the input is written in %.*s, learning_text is that "
                       "input, corrected only for obvious typos, and known_text is its translation. If the input is in any "
                       "other language, translate it into both.",
                       K, L);
  str r = rules(a, known_code, learning_code);
  return str_c(ar_fmt(a,
                      "The learner speaks %.*s and is learning %.*s.\n\nTheir input: \"%.*s\"\n\nWrite one flashcard: "
                      "known_text in %.*s, learning_text in %.*s.\n\n%s\n\n%.*s",
                      K, L, (int)user_input.n, user_input.p, K, L, direction, (int)r.n, r.p));
#undef K
#undef L
}

str card_unspeakable_retry_prompt(arena *a, str previous, str rejected, const char *reason) {
  return str_c(ar_fmt(a,
                      "%.*s\n\nYOUR PREVIOUS ANSWER WAS REJECTED. You returned learning_text as \"%.*s\", but %s. That text "
                      "goes straight to a speech synthesiser, so it has to be one thing a person says. Choose the single most "
                      "likely everyday meaning and write only that utterance in learning_text. Put the meaning you chose in "
                      "sense_tag only if the input really does have a second, equally everyday meaning that a different card "
                      "would teach; otherwise leave sense_tag empty.",
                      (int)previous.n, previous.p, (int)rejected.n, rejected.p, reason));
}

/* ---- the response formats (cardGeneration.ts responseFormat): their properties, in order ---- */
typedef struct {
  const char *key, *type;        /* "string" or "boolean" */
  const char *description;       /* or NULL */
  int register_enum;             /* enum: casual, polite, formal */
} prop;
typedef struct { const char *name; const prop *props; size_t n; } format;

#define SENSE_TAG_DESCRIPTION                                                                                          \
  "Usually empty. Fill it only when the input genuinely has a second, equally everyday meaning that a different card " \
  "could teach - then two or three words in the learner's own language naming which of those meanings this card "    \
  "teaches, for example 'calendar day' for 'date'. Never a restatement, summary, topic or tone of the card itself."
#define REGISTER_DESCRIPTION "The politeness level the learning-language text actually uses"
#define SPOKEN_READING_DESCRIPTION                                                                                       \
  "How the learning-language text must be read aloud, in the learning language's own script (kana for Japanese, "      \
  "zhuyin/bopomofo for Chinese) - never romanised. Empty unless the writing system leaves the reading open (Japanese, " \
  "Chinese)."
static const prop GENERATED_PROPS[] = {
  {"known_text", "string", "The known-language side: one natural utterance, no annotation of any kind", 0},
  {"learning_text", "string", "The learning-language side: one natural utterance in one sense, no annotation of any kind", 0},
  {"sense_tag", "string", SENSE_TAG_DESCRIPTION, 0},
  {"register", "string", REGISTER_DESCRIPTION, 1},
  {"spoken_reading", "string", SPOKEN_READING_DESCRIPTION, 0},
};
static const prop VERDICT_PROPS[] = {
  {"heard", "string", "What the audio actually says, as heard", 0},
  {"matches", "boolean",
   "True if the audio says exactly the expected phrase in the expected language with intelligible pronunciation", 0},
  {"reason", "string", "Brief justification for the verdict", 0},
};
static const prop MATCH_PROPS[] = {{"matches", "boolean", NULL, 0}};
static const format GENERATED_CARD_FORMAT = {"flashcard_generation", GENERATED_PROPS, N(GENERATED_PROPS)};
static const format AUDIO_VERDICT_FORMAT = {"audio_verdict", VERDICT_PROPS, N(VERDICT_PROPS)};
static const format TRANSCRIPTION_MATCH_FORMAT = {"transcription_match", MATCH_PROPS, N(MATCH_PROPS)};

static void value_string(buf *out, const char *s) {
  buf v = {0};
  gv_string(&v, s);
  buf_put(out, v.p, v.n);
  buf_free(&v);
}
/* {type, properties, required, additionalProperties: false, $schema}, as the object literal orders them. */
static void schema_of(const format *f, buf *out) {
  buf props = {0};
  for (size_t i = 0; i < f->n; i++) {
    buf body = {0}, v = {0};
    value_string(&v, f->props[i].type);
    gv_field(&body, "type", &v);
    if (f->props[i].register_enum) {
      buf items = {0}, item = {0}, list = {0};
      for (size_t k = 0; k < N(REGISTER_LEVELS); k++) {
        item.n = 0;
        value_string(&item, REGISTER_LEVELS[k]);
        gv_list_item(&items, &item);
      }
      gv_list_of(&list, &items);
      gv_field(&body, "enum", &list);
      buf_free(&items), buf_free(&item), buf_free(&list);
    }
    if (f->props[i].description) {
      v.n = 0;
      value_string(&v, f->props[i].description);
      gv_field(&body, "description", &v);
    }
    buf obj = {0};
    gv_struct_of(&obj, &body);
    gv_field(&props, f->props[i].key, &obj);
    buf_free(&body), buf_free(&v), buf_free(&obj);
  }
  buf top = {0}, v = {0};
  value_string(&v, "object");
  gv_field(&top, "type", &v);
  v.n = 0;
  gv_struct_of(&v, &props);
  gv_field(&top, "properties", &v);
  buf items = {0}, item = {0};
  for (size_t i = 0; i < f->n; i++) {
    item.n = 0;
    value_string(&item, f->props[i].key);
    gv_list_item(&items, &item);
  }
  v.n = 0;
  gv_list_of(&v, &items);
  gv_field(&top, "required", &v);
  v.n = 0;
  gv_bool(&v, 0);
  gv_field(&top, "additionalProperties", &v);
  v.n = 0;
  value_string(&v, "http://json-schema.org/draft-07/schema#");
  gv_field(&top, "$schema", &v);
  gv_struct_of(out, &top);
  buf_free(&props), buf_free(&top), buf_free(&v), buf_free(&items), buf_free(&item);
}
void card_schema_generated(buf *out) { schema_of(&GENERATED_CARD_FORMAT, out); }
void card_schema_audio_verdict(buf *out) { schema_of(&AUDIO_VERDICT_FORMAT, out); }
void card_schema_transcription_match(buf *out) { schema_of(&TRANSCRIPTION_MATCH_FORMAT, out); }

/* ---- readStructured ---- */
/* A string from the quarantine is WTF-8: a lone surrogate written out by Node is U+FFFD. */
static str usv(arena *a, str s) {
  buf b = {0};
  for (size_t i = 0; i < s.n; i++) {
    unsigned char c = (unsigned char)s.p[i];
    if (c == 0xed && i + 2 < s.n && ((unsigned char)s.p[i + 1] & 0xe0) == 0xa0) {
      buf_c(&b, "\xef\xbf\xbd");
      i += 2;
    } else {
      buf_ch(&b, (char)c);
    }
  }
  str out = buf_str(a, &b);
  buf_free(&b);
  return out;
}
static const char *type_desc(const aj *v) {
  switch (v->type) {
  case AJ_ARR: return "a list";
  case AJ_OBJ: return "a object";
  case AJ_NUM: return "a number";
  case AJ_STR: return "a string";
  case AJ_BOOL: return "a boolean";
  default: return "null";
  }
}
/* String(value).slice(0, 40) for a value inside an enum check (always a string here) */
static str slice_units(str s, size_t max) {
  size_t units = 0, at = 0;
  while (at < s.n) {
    size_t from = at;
    uint32_t cp = utf8_next(s, &at);
    size_t u = cp >= 0x10000 ? 2 : 1;
    if (units + u > max) return str_sub(s, 0, from);
    units += u;
  }
  return s;
}

typedef struct { str s[5]; int b[5]; } fields;
/* 0 and the fields, or -1 with the error parseStructured throws. */
static int parse_structured(arena *a, str text, const format *f, fields *out, gem_err *e) {
  str detail = {0};
  if (!text.n) {
    detail = S("no answer");
  } else {
    aj *v = model_answer_parse(a, text, &detail);
    if (v && v->type != AJ_OBJ) {
      detail = str_c(ar_fmt(a, "not an object: %s", type_desc(v)));
    } else if (v) {
      for (size_t i = 0; i < f->n && !detail.p; i++) {
        const prop *p = &f->props[i];
        aj *x = aj_get(v, str_c(p->key));
        int want_bool = !strcmp(p->type, "boolean");
        if (!x || x->type == AJ_NULL) detail = str_c(ar_fmt(a, "%s is missing", p->key));
        else if ((want_bool && x->type != AJ_BOOL) || (!want_bool && x->type != AJ_STR))
          detail = str_c(ar_fmt(a, "%s is %s, not a %s", p->key, type_desc(x), p->type));
        else if (p->register_enum && register_level(x->s) < 0) {
          str shown = slice_units(usv(a, x->s), 40);
          buf names = {0};
          for (size_t k = 0; k < N(REGISTER_LEVELS); k++) buf_fmt(&names, "%s%s", k ? ", " : "", REGISTER_LEVELS[k]);
          detail = str_c(ar_fmt(a, "%s is \"%.*s\", not one of %.*s", p->key, (int)shown.n, shown.p, (int)names.n, names.p));
          buf_free(&names);
        } else if (want_bool) {
          out->b[i] = x->b;
        } else {
          out->s[i] = usv(a, x->s);
        }
      }
    }
  }
  if (detail.p) {
    gem_fail(a, e, GE_ERROR, "Failed to parse %s from model response: %.*s", f->name, (int)detail.n, detail.p);
    return -1;
  }
  return 0;
}

static int parse_completion(arena *a, const char *system, str prompt, const format *f, fields *out, gem_err *e) {
  buf schema = {0};
  schema_of(f, &schema);
  gem_request req = {0};
  req.system = system;
  req.role = "user";
  req.parts[0].text = prompt;
  req.nparts = 1;
  req.schema = &schema;
  req.thinking = 1;
  gem_response r;
  int rc = gem_generate(a, TEXT_MODEL, &req, &r, e);
  buf_free(&schema);
  if (rc) return -1;
  return parse_structured(a, gem_response_text(a, &r), f, out, e);
}

/* ---- generateCardText, the 'generate' mode ---- */
int card_generate_text(arena *a, str user_input, str known, str learning, const char *input_language, card_text *out,
                       gem_err *e) {
  str base = card_generation_prompt(a, user_input, known, learning, input_language);
  str prompt = base;
  card_text last = {0};
  for (int attempt = 1; attempt <= 2; attempt++) {
    fields f = {0};
    if (parse_completion(a, CARD_GENERATION_SYSTEM_PROMPT, prompt, &GENERATED_CARD_FORMAT, &f, e)) return -1;
    /* assembleCard */
    const char *repaired = card_unspeakable_reason(a, f.s[1]);
    last.front_text = card_compose_known_side(a, f.s[0], f.s[2], card_register_tag(a, learning, f.s[3]));
    last.back_text = card_speakable_utterance(a, f.s[1]);
    last.spoken_reading = card_reading_is_ambiguous(a, learning) ? js_trim(f.s[4]) : S("");
    if (!repaired) break;
    prompt = card_unspeakable_retry_prompt(a, base, f.s[1], repaired);
  }
  *out = last;
  return 0;
}

/* ---- generateCardAudio ---- */
#define AUDIO_JUDGE_SYSTEM_PROMPT                                                                                          \
  "You are a strict quality judge for text-to-speech audio used on language-learning flashcards. You are given the "      \
  "exact phrase the audio must say and the language it must be spoken in, followed by the audio clip. Listen carefully "  \
  "and judge whether the clip:\n1. Says exactly the expected phrase - no missing, extra, or different words. Natural "     \
  "readings (numerals read out as words, expanded abbreviations, spoken or skipped punctuation) are acceptable.\n2. Is "   \
  "spoken in the expected language with clear, intelligible pronunciation.\n3. When an expected reading is given, uses "  \
  "that reading. The written form has more than one possible pronunciation, and reading the same characters a "         \
  "different way is a mismatch even though the words are right.\nJudge only what you actually hear in the audio. "       \
  "Answer with what you heard and your verdict."
#define TRANSCRIPT_JUDGE_SYSTEM_PROMPT                                                                                     \
  "You judge whether an automatic speech transcription plausibly comes from audio of an expected phrase. The "           \
  "transcriber may normalize punctuation, numerals vs words, spacing, and casing, and for some languages it outputs a "   \
  "different script or a translation of what was actually said - those still count as a match when the spoken content " \
  "is plausibly the expected phrase. Count it as a mismatch when the transcription indicates different, missing, or "    \
  "extra spoken content."

static int stops(const gem_err *e) { return e->kind == GE_FATAL || e->kind == GE_DAILY || e->kind == GE_RATE; }

static int transcribe(arena *a, str wav, str language, str *out, gem_err *e) {
  str name = card_language_name(a, language);
  gem_request req = {0};
  req.role = "user";
  req.parts[0].text = str_c(ar_fmt(a,
                                   "Transcribe this %.*s audio exactly as spoken, in %.*s's own writing system. Do not "
                                   "translate, romanise, explain or correct it. Answer with the transcript only.",
                                   (int)name.n, name.p, (int)name.n, name.p));
  req.parts[1].audio = wav.p;
  req.parts[1].audio_len = wav.n;
  req.nparts = 2;
  req.thinking = 1;
  gem_response r;
  if (gem_generate(a, TRANSCRIBE_MODEL, &req, &r, e)) return -1;
  *out = gem_response_text(a, &r);
  return 0;
}

static int judge(arena *a, str wav, str spoken, str language, str reading, int *matches, str *heard, str *reason, gem_err *e) {
  str name = card_language_name(a, language);
  str reading_line = reading.n ? str_c(ar_fmt(a,
                                              "\nIt must be read aloud as: %.*s. This writing system allows more than one "
                                              "reading of the same characters, so a different reading is a mismatch.",
                                              (int)reading.n, reading.p))
                               : S("");
  buf schema = {0};
  schema_of(&AUDIO_VERDICT_FORMAT, &schema);
  gem_request req = {0};
  req.system = AUDIO_JUDGE_SYSTEM_PROMPT;
  req.role = "user";
  req.parts[0].text = str_c(ar_fmt(a, "Expected phrase (language: %.*s): \"%.*s\"%.*s\nJudge this audio:", (int)name.n, name.p,
                                   (int)spoken.n, spoken.p, (int)reading_line.n, reading_line.p));
  req.parts[1].audio = wav.p;
  req.parts[1].audio_len = wav.n;
  req.nparts = 2;
  req.schema = &schema;
  req.thinking = 1;
  gem_response r;
  int rc = gem_generate(a, JUDGE_MODEL, &req, &r, e);
  buf_free(&schema);
  if (rc) return -1;
  fields f = {0};
  if (parse_structured(a, gem_response_text(a, &r), &AUDIO_VERDICT_FORMAT, &f, e)) return -1;
  *heard = f.s[0], *matches = f.b[1], *reason = f.s[2];
  return 0;
}

int card_generate_audio(arena *a, str text, str language, str reading, str *wav, gem_err *e) {
  const int max_attempts = 3;
  str spoken = card_spoken_form(a, text);
  str expected = card_reading_is_ambiguous(a, language) ? js_trim(reading) : S("");
  int must_hear = expected.n > 0;
  str last_failure = S("");
  const char *voice = NULL;
  for (int attempt = 1; attempt <= max_attempts; attempt++) {
    gem_err ae = {0};
    voice = gem_pick_voice(voice);
    str audio, transcript;
    if (gem_synthesize(a, spoken, voice, &audio, &ae) || transcribe(a, audio, language, &transcript, &ae)) {
      if (stops(&ae)) return *e = ae, -1;
      last_failure = ae.message;
      continue;
    }
    int same = str_eq(card_normalize_for_comparison(a, transcript, language), card_normalize_for_comparison(a, spoken, language));
    if (same && !must_hear) return *wav = audio, 0;
    int matches;
    str heard, reason;
    gem_err je = {0};
    if (judge(a, audio, spoken, language, expected, &matches, &heard, &reason, &je)) {
      if (stops(&je)) return *e = je, -1;
      if (same) return *wav = audio, 0; /* the words are right and only the reading was in question */
      fields f = {0};
      str user = str_c(ar_fmt(a,
                              "Expected phrase (language: %.*s): \"%.*s\"\nTranscription: \"%.*s\"\nCould this transcription "
                              "plausibly come from audio of the expected phrase?",
                              (int)language.n, language.p, (int)spoken.n, spoken.p, (int)transcript.n, transcript.p));
      if (parse_completion(a, TRANSCRIPT_JUDGE_SYSTEM_PROMPT, user, &TRANSCRIPTION_MATCH_FORMAT, &f, &ae)) {
        if (stops(&ae)) return *e = ae, -1;
        last_failure = ae.message;
        continue;
      }
      matches = f.b[0], heard = transcript, reason = S("transcript-based fallback judgement");
    }
    if (matches) return *wav = audio, 0;
    last_failure = str_c(ar_fmt(a, "judge heard: \"%.*s\"; transcript: \"%.*s\"; reason: %.*s", (int)heard.n, heard.p,
                                (int)transcript.n, transcript.p, (int)reason.n, reason.p));
  }
  gem_fail(a, e, GE_ERROR, "Failed to generate valid audio for \"%.*s\" after %d attempts (%.*s)", (int)spoken.n, spoken.p,
           max_attempts, (int)last_failure.n, last_failure.p);
  return -1;
}

/* ---- sideOrder.js ---- */
card_text card_correct_swapped_sides(arena *a, card_text t, str learning) {
  if (!card_uses_non_latin_script(a, learning)) return t;
  int back = card_has_native_script(a, t.back_text, learning), front = card_has_native_script(a, t.front_text, learning);
  if (back || !front) return t;
  return (card_text){t.back_text, t.front_text, S("")};
}

const char *card_detect_input_language(arena *a, str input, str known, str learning) {
  if (!card_uses_non_latin_script(a, learning)) return NULL;
  if (card_has_native_script(a, input, learning)) return "learning";
  if (card_uses_non_latin_script(a, known)) return NULL;
  for (size_t i = 0; i < input.n; i++)
    if ((input.p[i] >= 'a' && input.p[i] <= 'z') || (input.p[i] >= 'A' && input.p[i] <= 'Z')) return "known";
  return NULL;
}
