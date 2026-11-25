/* The language table (lang.h), in the order the page offers it. */
#include "lang.h"

const lang_entry LANGUAGES[] = {
  {"en", "English", "🇺🇸", "English"}, {"zh_cn", "中文", "🇨🇳", "Mandarin Chinese"},
  {"es", "Español", "🇪🇸", "Spanish"}, {"fr", "Français", "🇫🇷", "French"},
  {"pt", "Português", "🇵🇹", "Portuguese"}, {"ru", "Русский", "🇷🇺", "Russian"},
  {"id", "Bahasa Indonesia", "🇮🇩", "Indonesian"}, {"de", "Deutsch", "🇩🇪", "German"},
  {"ja", "日本語", "🇯🇵", "Japanese"}, {"tr", "Türkçe", "🇹🇷", "Turkish"},
  {"zh_hk", "廣東話", "🇭🇰", "Cantonese"}, {"vi", "Tiếng Việt", "🇻🇳", "Vietnamese"},
  {"ko", "한국어", "🇰🇷", "Korean"}, {"it", "Italiano", "🇮🇹", "Italian"},
  {"th", "ภาษาไทย", "🇹🇭", "Thai"}, {"hi", "हिन्दी", "🇮🇳", "Hindi"},
  {"ur", "اردو", "🇵🇰", "Urdu"}, {"ar", "العربية", "🇸🇦", "Arabic"},
};
const uint32_t NLANGUAGES = sizeof LANGUAGES / sizeof *LANGUAGES;

const lang_entry *lang_find(const char *code, uint32_t len) {
  for (uint32_t i = 0; i < NLANGUAGES; i++) {
    const char *c = LANGUAGES[i].code;
    uint32_t k = 0;
    while (k < len && c[k] && c[k] == code[k]) k++;
    if (k == len && !c[k]) return &LANGUAGES[i];
  }
  return 0;
}

int lang_known(const char *code, uint32_t len) { return lang_find(code, len) != 0; }

int lang_pair_ok(const char *known, uint32_t known_len, const char *learning, uint32_t learning_len) {
  const lang_entry *k = lang_find(known, known_len), *l = lang_find(learning, learning_len);
  return k && l && k != l;
}
