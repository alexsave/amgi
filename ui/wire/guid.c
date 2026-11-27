#include "guid.h"

static const char BASE91[] = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";

uint32_t wire_guid(uint64_t n, char out[WIRE_GUID_MAX]) {
    char tmp[WIRE_GUID_MAX];
    uint32_t k = WIRE_GUID_MAX;
    do {
        tmp[--k] = BASE91[n % 91];
        n /= 91;
    } while (n > 0);
    uint32_t len = WIRE_GUID_MAX - k;
    for (uint32_t i = 0; i < len; i++) out[i] = tmp[k + i];
    return len;
}
