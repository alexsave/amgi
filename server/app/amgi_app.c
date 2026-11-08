// amgi_app.c - the amgi app on cbase serve: what cbase's serve binary (build/amgi) runs. Today it
// is the shell L2 fills: storeless (amgi keeps its data in the user's Anki collection, opened per
// call by the collection core, never in a platform store), and with no routes yet. L2 adds the
// /api/anki routes, the page's files and the startup line.
#include "cbase/app.h"

static const cb_app AMGI_APP = {
    .name = "amgi",
    .storeless = true,
};

const cb_app *const cb_main_app = &AMGI_APP;
