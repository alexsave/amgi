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
static int64_t loading_deck;
static cd_req loading;

static uint32_t key_for(char *dst, int64_t id) {
  __builtin_memcpy(dst, KEY_PREFIX, sizeof KEY_PREFIX - 1);
  return (uint32_t)sizeof KEY_PREFIX - 1 + id_dec(dst + sizeof KEY_PREFIX - 1, id);
}

static int copy_code(char *dst, const char *p, uint32_t n) {
  if (!n || n >= 8 || !language_name(p, n)) return 0;
  __builtin_memcpy(dst, p, n);
  dst[n] = 0;
  return 1;
}

/* The answer to a load: ctx is the load's request, so one a later load overtook, or one already answered, is dropped. */
static void deck_langs_got(void *ctx, const uint8_t *p, int32_t len) {
  if (!cd_req_current(&loading, ctx, 0)) return;
  lang_pair pair = {"en", "ko"};
  if (len > 0) {
    const char *s = (const char *)p;
    uint32_t sp = 0;
    while (sp < (uint32_t)len && s[sp] != ' ') sp++;
    lang_pair got;
    if (sp < (uint32_t)len && copy_code(got.known, s, sp) && copy_code(got.learning, s + sp + 1, (uint32_t)len - sp - 1))
      pair = got;
  }
  cd_req_end(&loading, 1);
  deck_langs_loaded(loading_deck, &pair);
}

void deck_langs_load(int64_t deck_id) {
  char key[64];
  loading_deck = deck_id;
  cd_store_get_cb(deck_langs_got, cd_req_begin(&loading, 0), key, key_for(key, deck_id), CD_STORE_DEADLINE_MS);
}

void deck_langs_save(int64_t deck_id, const lang_pair *p) {
  char key[64], value[16];
  uint32_t k = zlen(p->known), l = zlen(p->learning);
  __builtin_memcpy(value, p->known, k);
  value[k] = ' ';
  __builtin_memcpy(value + k + 1, p->learning, l);
  cd_store_put_cb(store_put_ignored, 0, key, key_for(key, deck_id), value, k + 1 + l);
}
