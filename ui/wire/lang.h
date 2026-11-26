/* The languages amgi knows, in one table: the page offers them in this order, the server names
 * them to Gemini, and a deck's stored pair is only ever two of these codes. Compiled into the page
 * (ui/Makefile) and into the server (server/Makefile) from the same lang.c, so the two cannot
 * drift. */
#ifndef AMGI_LANG_H
#define AMGI_LANG_H
#include <stdint.h>

typedef struct {
    const char *code;    /* "zh_cn": what the wire and the add-on key carry */
    const char *name;    /* its own name, for the page's pickers */
    const char *flag;
    const char *english; /* its English name, for the prompts ("Mandarin Chinese") */
} lang_entry;

extern const lang_entry LANGUAGES[];
extern const uint32_t NLANGUAGES;

/* The entry for code (len bytes, not terminated), or 0 when it is not one of the table's. */
const lang_entry *lang_find(const char *code, uint32_t len);
/* Whether code is one of the table's. */
int lang_known(const char *code, uint32_t len);
/* Whether known and learning are two different codes of the table: what a deck's stored pair must be. */
int lang_pair_ok(const char *known, uint32_t known_len, const char *learning, uint32_t learning_len);
#endif
