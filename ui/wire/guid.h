/* A note's guid as Anki writes one: base 91 of a 64-bit integer, never 0. The one owner of the alphabet, for the
 * server's writer (server/collection/notes.c) and the page (ui/src/bulk.c), which makes a note's guid before its first
 * write so the same write sent again is known for the same note. */
#ifndef AMGI_GUID_H
#define AMGI_GUID_H
#include <stdint.h>

#define WIRE_GUID_MAX 11 /* 91^10 < 2^64 < 91^11 */
/* n in base 91 into out (no terminator): its length, 1 to WIRE_GUID_MAX. n is 0 only if the caller drew 0: it is "a". */
uint32_t wire_guid(uint64_t n, char out[WIRE_GUID_MAX]);
#endif
