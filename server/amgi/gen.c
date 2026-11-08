/* stub until the Gemini port lands */
#include <stdlib.h>

#include "amgi.h"
#include "messages.h"

int amgi_generation_available(void) {
  const char *k = getenv("GEMINI_API_KEY");
  return k && *k;
}
int amgi_gen_open(char *err, size_t cap) { (void)err, (void)cap; return 0; }
void amgi_gen_close(void) {}
void amgi_card_text(arena *a, const amgi_ops *o, const char *mode, const wire_q_card_text *q, cb_http_res *res) {
  (void)o, (void)mode, (void)q;
  amgi_send_message(a, res, 500, S(MISSING_KEY_MESSAGE));
}
void amgi_audio(arena *a, const amgi_ops *o, const char *mode, const wire_q_audio *q, cb_http_res *res) {
  (void)o, (void)mode, (void)q;
  amgi_send_message(a, res, 500, S(MISSING_KEY_MESSAGE));
}
