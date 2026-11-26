/* The languages are wire/lang.c's table; this is the page's lookup of one. */
#include "app.h"

const char *language_name(const char *code, uint32_t len) {
    const lang_entry *l = lang_find(code, len);
    return l ? l->name : 0;
}

static void copy_code(char *dst, wire_str s) {
    if (s.len < 8 && language_name(s.p, s.len)) {
        __builtin_memcpy(dst, s.p, s.len);
        dst[s.len] = 0;
    } else {
        dst[0] = 0;
    }
}

void lang_pair_set(lang_pair *p, wire_str known, wire_str learning) {
    copy_code(p->known, known);
    copy_code(p->learning, learning);
}
