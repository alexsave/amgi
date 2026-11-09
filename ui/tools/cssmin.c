/* Strip CSS block comments from stdin to stdout, leaving everything else byte for byte.
 *
 * A comment opens with slash-star and closes with star-slash, but only outside a string: inside
 * '...' or "..." those two characters are literal, so the authored comments in the css sources come
 * out of the shipped app.css while content:'...' and url("...") are left intact. CSS has no line
 * comments, so block comments are all there is. */
#include <stdio.h>

int main(void) {
  int c, quote = 0, prev = 0;
  while ((c = getchar()) != EOF) {
    if (quote) {                                  /* inside a string: copy, honour backslash escapes */
      putchar(c);
      if (c == '\\') { int n = getchar(); if (n != EOF) putchar(n); continue; }
      if (c == quote) quote = 0;
      continue;
    }
    if (c == '\'' || c == '"') { quote = c; putchar(c); continue; }
    if (prev == '/' && c == '*') {                /* a comment opened: we held the slash, drop it */
      int p = 0, d;
      while ((d = getchar()) != EOF) { if (p == '*' && d == '/') break; p = d; }
      prev = 0;
      continue;
    }
    if (c == '/') { prev = '/'; continue; }        /* hold a slash until we know it is not an opener */
    if (prev == '/') { putchar('/'); prev = 0; }
    putchar(c);
  }
  if (prev == '/') putchar('/');
  return 0;
}
