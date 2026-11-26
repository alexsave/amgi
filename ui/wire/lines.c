/* The paste's lines and their keys (lines.h). */
#include "lines.h"

static int same_bytes(const char *a, uint32_t alen, const char *b, uint32_t blen) {
    if (alen != blen) return 0;
    for (uint32_t i = 0; i < alen; i++)
        if (a[i] != b[i]) return 0;
    return 1;
}

uint32_t lines_cp(const char *s, uint32_t len, uint32_t i, uint32_t *n) {
    uint8_t c = (uint8_t)s[i];
    uint32_t need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    if (need == 1 || i + need > len) return *n = 1, c;
    uint32_t cp = c & (0x7f >> need);
    for (uint32_t k = 1; k < need; k++) cp = cp << 6 | ((uint8_t)s[i + k] & 0x3f);
    *n = need;
    return cp;
}
uint32_t lines_cp_start(const char *s, uint32_t end) {
    uint32_t i = end - 1;
    while (i > 0 && ((uint8_t)s[i] & 0xc0) == 0x80 && end - i < 4) i--;
    return i;
}
int lines_space(uint32_t c) {
    return (c >= 9 && c <= 13) || c == 0x20 || c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 ||
           c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
}
wire_str lines_trim(wire_str s) {
    uint32_t a = 0, b = s.len, n;
    while (a < b && lines_space(lines_cp(s.p, s.len, a, &n))) a += n;
    while (b > a) {
        uint32_t i = lines_cp_start(s.p, b);
        if (!lines_space(lines_cp(s.p, s.len, i, &n)) || i + n != b) break;
        b = i;
    }
    return (wire_str){s.p + a, b - a};
}
uint32_t lines_collapse(char *dst, uint32_t n) {
    uint32_t w = 0, cl;
    int in_space = 0;
    for (uint32_t i = 0; i < n; i += cl) {
        uint32_t c = lines_cp(dst, n, i, &cl);
        if (lines_space(c)) {
            if (!in_space) dst[w++] = ' ';
            in_space = 1;
        } else {
            for (uint32_t k = 0; k < cl; k++) dst[w++] = dst[i + k];
            in_space = 0;
        }
    }
    return w;
}

/* The class of what was lyricsParse.js's TRAILING_PUNCTUATION_RE: \s and these. */
static int trailing_punct(uint32_t c) {
    static const uint32_t SET[] = {',', '.', '!', '?', ';', ':', 0x3001, 0x3002, 0xff01, 0xff1f, 0xff0c, 0xff1b, 0xff1a,
                                   0x2026, '"', '\'', 0x201c, 0x201d, 0x2018, 0x2019};
    if (lines_space(c)) return 1;
    for (uint32_t i = 0; i < sizeof SET / sizeof *SET; i++)
        if (SET[i] == c) return 1;
    return 0;
}
uint32_t lines_key(char *dst, wire_str s) {
    wire_str t = lines_trim(s);
    if (t.len) __builtin_memmove(dst, t.p, t.len);
    uint32_t n = lines_collapse(dst, t.len), end = n, cl;
    while (end > 0) {
        uint32_t i = lines_cp_start(dst, end);
        if (!trailing_punct(lines_cp(dst, n, i, &cl)) || i + cl != end) break;
        end = i;
    }
    return end ? end : n;
}

void lines_open(lines_reader *r, const char *s, uint32_t len, char *keys) {
    r->s = s;
    r->len = len;
    r->at = r->used = r->cards = 0;
    r->keys = keys;
}

int lines_next(lines_reader *r, wire_str *out) {
    while (r->at <= r->len) {
        uint32_t a = r->at, e = a;
        while (e < r->len && r->s[e] != '\n' && r->s[e] != '\r') e++;
        wire_str line = lines_trim((wire_str){r->s + a, e - a});
        /* \r\n is one break; a lone \r or \n is one too */
        r->at = e + (e + 1 < r->len && r->s[e] == '\r' && r->s[e + 1] == '\n' ? 2 : 1);
        if (!line.len) continue;
        if (line.len > 2 && line.p[0] == '[' && line.p[line.len - 1] == ']') {
            int marker = 1;
            for (uint32_t k = 1; k + 1 < line.len && marker; k++)
                if (line.p[k] == '[' || line.p[k] == ']') marker = 0;
            if (marker) continue;
        }
        uint32_t kn = lines_key(r->keys + r->used, line), dup = 0;
        for (uint32_t i = 0; i < r->cards && i < 512 && !dup; i++)
            dup = same_bytes(r->keys + r->refs[i].at, r->refs[i].n, r->keys + r->used, kn);
        *out = line;
        if (dup) return LINE_REPEAT;
        if (r->cards < 512) r->refs[r->cards] = (lines_key_ref){r->used, kn};
        r->used += kn;
        r->cards++;
        return LINE_CARD;
    }
    return LINE_END;
}

uint32_t lines_split(const char *s, uint32_t len, wire_str *out, uint32_t cap, char *keys) {
    lines_reader r;
    lines_open(&r, s, len, keys);
    wire_str line;
    int kind;
    while ((kind = lines_next(&r, &line)) != LINE_END)
        if (kind == LINE_CARD && r.cards <= cap) out[r.cards - 1] = line;
    return r.cards;
}
