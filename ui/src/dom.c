/* Shorthand over cdom's builder, and the icons. */
#include "app.h"

void el(cd_str tag, cd_str cls) {
  cd_open(tag);
  if (cls) cd_class(cls);
}
cd_id el_id(cd_str tag, cd_str cls) {
  cd_id id = cd_open_id(tag);
  if (cls) cd_class(cls);
  return id;
}
void el_text(cd_str tag, cd_str cls, cd_str s) {
  el(tag, cls);
  cd_text(s);
  cd_close();
}
void tmp_text(const char *p, uint32_t len) { cd_text(cd_tmp(p, len)); }
void attr_tmp(cd_str name, const char *p, uint32_t len) { cd_attr(name, cd_tmp(p, len)); }

void icon_with(const char *d1, const char *d2, cd_str style, cd_str cls) {
  cd_open(CD_LIT("svg"));
  cd_attr(CD_LIT("xmlns"), CD_LIT("http://www.w3.org/2000/svg"));
  cd_attr(CD_LIT("fill"), CD_LIT("none"));
  cd_attr(CD_LIT("viewBox"), CD_LIT("0 0 24 24"));
  cd_attr(CD_LIT("stroke-width"), CD_LIT("1.5"));
  cd_attr(CD_LIT("stroke"), CD_LIT("currentColor"));
  cd_attr(CD_LIT("aria-hidden"), CD_LIT("true"));
  cd_attr(CD_LIT("data-slot"), CD_LIT("icon"));
  if (cls) cd_attr(CD_LIT("class"), cls);
  if (style) cd_attr(CD_LIT("style"), style);
  for (int i = 0; i < 2; i++) {
    const char *d = i ? d2 : d1;
    if (!d) continue;
    cd_open(CD_LIT("path"));
    cd_attr(CD_LIT("stroke-linecap"), CD_LIT("round"));
    cd_attr(CD_LIT("stroke-linejoin"), CD_LIT("round"));
    cd_attr(CD_LIT("d"), cd_internz(d));
    cd_close();
  }
  cd_close();
}

void icon(const char *d1, const char *d2, cd_str style) { icon_with(d1, d2, style, 0); }

const char ICON_COG[] =
  "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083."
  "22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003."
  "827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1."
  "298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.5"
  "81.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.6"
  "86-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2."
  "247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43"
  "-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.07"
  "6-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z";
const char ICON_COG_HUB[] = "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z";
const char ICON_PLUS[] = "M12 4.5v15m7.5-7.5h-15";
const char ICON_TRASH[] =
  "m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 "
  "2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 "
  "1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18."
  "037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0";
const char ICON_X[] = "M6 18 18 6M6 6l12 12";
