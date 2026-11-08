// amgi_app.c - the amgi app on cbase serve: what cbase's serve binary (build/amgi) runs, in place of
// ui/server/serve.mjs. Storeless: amgi keeps its data in the user's Anki collection, opened per call
// by the collection core, never in a platform store. Its routes, the page's files and the Gemini
// client are the product library in server/amgi (amgi.h says what is where).
//
// No CORS origin is declared, so no Access-Control-* header is ever sent: the page and the API come
// from one origin, which needs none, and a page on any other site gets no permission (cbase refuses
// its preflight 403).
#include "cbase/app.h"

#include <stdio.h>

extern const cb_route_list AMGI_ROUTE_LIST;
int amgi_gen_open(char *err, size_t cap);
void amgi_gen_close(void);

static int amgi_open(cb_ctx *ctx, char *err, size_t cap) {
    (void)ctx;
    return amgi_gen_open(err, cap);
}

static void amgi_close(cb_ctx *ctx) {
    (void)ctx;
    amgi_gen_close();
}

static const cb_route_list *const AMGI_ROUTES[] = { &AMGI_ROUTE_LIST };

// DNS rebinding: a page on a name its owner points at 127.0.0.1 is same-origin with this server,
// and CORS cannot stop it, but its Host still names it. Only this machine's own names, at the port
// serve bound, are answered; any other Host is 403 before any route runs (test/parity/host.test.mjs).
static const char *const AMGI_HOSTS[] = { "127.0.0.1", "localhost", "[::1]" };

static const cb_app AMGI_APP = {
    .name = "amgi",
    .routes = AMGI_ROUTES,
    .n_route_lists = 1,
    .storeless = true,
    .serve_open = amgi_open,
    .serve_close = amgi_close,
    // Gemini calls hold a request's thread for up to about 30 s, and the bulk screen keeps five cards
    // in flight beside the status poll and the page's reads.
    .req_workers = 12,
    // A desktop app's terminal: warnings and errors only.
    .log_level = "warn",
    .host_allow = AMGI_HOSTS,
    .n_host_allow = 3,
};

const cb_app *const cb_main_app = &AMGI_APP;
