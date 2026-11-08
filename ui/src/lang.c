/* The languages (src/constants/languages.js, in its order), and the pair each deck remembers. */
#include "app.h"

const language LANGUAGES[] = {
  {"en", "English", "🇺🇸"}, {"zh_cn", "中文", "🇨🇳"}, {"es", "Español", "🇪🇸"}, {"fr", "Français", "🇫🇷"},
  {"pt", "Português", "🇵🇹"}, {"ru", "Русский", "🇷🇺"}, {"id", "Bahasa Indonesia", "🇮🇩"}, {"de", "Deutsch", "🇩🇪"},
  {"ja", "日本語", "🇯🇵"}, {"tr", "Türkçe", "🇹🇷"}, {"zh_hk", "廣東話", "🇭🇰"}, {"vi", "Tiếng Việt", "🇻🇳"},
  {"ko", "한국어", "🇰🇷"}, {"it", "Italiano", "🇮🇹"}, {"th", "ภาษาไทย", "🇹🇭"}, {"hi", "हिन्दी", "🇮🇳"},
  {"ur", "اردو", "🇵🇰"}, {"ar", "العربية", "🇸🇦"},
};
const uint32_t NLANGUAGES = sizeof LANGUAGES / sizeof *LANGUAGES;

const char *language_name(const char *code, uint32_t len) {
  for (uint32_t i = 0; i < NLANGUAGES; i++)
    if (same_z(code, len, LANGUAGES[i].code)) return LANGUAGES[i].name;
  return 0;
}

/* A deck's pair in the store under "amgi:deck-languages:<id>", as "<known> <learning>": the
 * deckLanguagePrefs.js defaults (en, ko) when there is none. One load at a time is all a screen
 * needs; a later load wins over an earlier one still in flight. */
#define KEY_PREFIX "amgi:deck-languages:"
enum { LANG_TOKEN = 1 };
static int64_t loading_deck = -1;
static uint32_t loading_seq;

static uint32_t key_for(char *dst, int64_t id) {
  __builtin_memcpy(dst, KEY_PREFIX, sizeof KEY_PREFIX - 1);
  return (uint32_t)sizeof KEY_PREFIX - 1 + id_dec(dst + sizeof KEY_PREFIX - 1, id);
}

void deck_langs_load(int64_t deck_id) {
  char key[64];
  loading_deck = deck_id;
  loading_seq = (loading_seq + 1) & 0xffff;
  cd_store_get(STORE_TOKEN(M_DECK, LANG_TOKEN << 16 | loading_seq), key, key_for(key, deck_id), CD_STORE_DEADLINE_MS);
}

static int copy_code(char *dst, const char *p, uint32_t n) {
  if (!n || n >= 8 || !language_name(p, n)) return 0;
  __builtin_memcpy(dst, p, n);
  dst[n] = 0;
  return 1;
}

/* cd_on_store for M_DECK (shell.c routes it here). */
void deck_langs_got(uint32_t token, const uint8_t *p, int32_t len) {
  if ((token & 0xffff) != loading_seq || loading_deck < 0) return;
  lang_pair pair = {"en", "ko"};
  if (len > 0) {
    const char *s = (const char *)p;
    uint32_t sp = 0;
    while (sp < (uint32_t)len && s[sp] != ' ') sp++;
    lang_pair got;
    if (sp < (uint32_t)len && copy_code(got.known, s, sp) && copy_code(got.learning, s + sp + 1, (uint32_t)len - sp - 1))
      pair = got;
  }
  int64_t id = loading_deck;
  loading_deck = -1;
  deck_langs_loaded(id, &pair);
}

void deck_langs_save(int64_t deck_id, const lang_pair *p) {
  char key[64], value[16];
  uint32_t k = zlen(p->known), l = zlen(p->learning);
  __builtin_memcpy(value, p->known, k);
  value[k] = ' ';
  __builtin_memcpy(value + k + 1, p->learning, l);
  cd_store_put(STORE_TOKEN(M_DECK, 2 << 16), key, key_for(key, deck_id), value, k + 1 + l);
}
