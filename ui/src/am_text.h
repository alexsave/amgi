/* The app's shipped UI strings, obfuscated.
 *
 * The problem: every CD_LIT("...") literal, and a few strings handed to text_setz/cat, land in the
 * wasm data section as plaintext, so `strings app.wasm` reads the app's whole user-facing text (the
 * labels, the sentences, the class names). A casual reader learns exactly what the app is.
 *
 * The rule, one owner: ui/tools/textgen.c reads the UI sources before the compile and collects every
 * CD_LIT(...) and every AM_Z(...). It concatenates the unique strings into ONE blob, XOR-obfuscated
 * with a fixed compile-time key (ui/tools/textgen.c's am_key: no randomness, no time, so two builds
 * of the same source produce a byte-identical blob), and emits out/gen/am_blob.c holding the blob,
 * the per-string offsets, and am_s/am_z. It also rewrites each source into out/gen/<file> with the
 * CD_LIT/AM_Z call turned into am_s(id)/am_z(id); the Makefile compiles those copies, not src/. So
 * the source the author reads keeps its normal strings, and the shipped module carries none of them.
 *
 * am_s(id) decodes one string the first time it is asked for and interns it (exactly what CD_LIT did,
 * one hash the first time), caches the cd_str, and answers it thereafter. am_z(id) decodes into an
 * owned, zero-terminated buffer once and answers a const char* (for text_setz and cat, which want
 * bytes, not an interned id). Nothing is decoded until it is used.
 *
 * In src/ the markers below keep the sources valid C on their own (editors, the text_dump test):
 * CD_LIT stays cdom's macro, and AM_Z is the identity. The shipped build never compiles src/ - it
 * compiles out/gen/, where textgen has already replaced both with the id lookups. */
#ifndef AMGI_AM_TEXT_H
#define AMGI_AM_TEXT_H

/* The decoded string as an interned cd_str (DOM text, class, attribute values). */
cd_str am_s(unsigned id);
/* The decoded string as an owned, zero-terminated const char* (text_setz, cat, same_z). */
const char *am_z(unsigned id);

/* In src/, a readable literal; in out/gen/ textgen has already turned it into am_z(id). */
#ifndef AM_Z
#define AM_Z(s) (s)
#endif

#endif
