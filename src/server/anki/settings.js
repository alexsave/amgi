// The client's Anki settings, read off a request's headers.
//
// The browser is the only place that knows which profile a person picked and
// whether they pasted in a bridge token, and the page keeps that choice in
// cdom's store (ui/src/settings.c) rather than a server-side session, since
// there is no login for this surface. Every request to /api/anki/* carries it
// in five plain headers so route handlers stay stateless: nothing here is
// cached between requests, which is what makes "re-probe on every call" (see
// transport.js) free instead of a feature that has to be built.
//
// Each value is percent-encoded UTF-8 (encodeURIComponent's form), since a
// header carries only Latin-1 and a profile path may be Korean. A header that
// is missing or not a whole escape reads as empty.

export const PLAIN_HEADERS = Object.freeze({
  baseDirOverride: 'x-amgi-base-dir',
  collectionPath: 'x-amgi-collection',
  profileName: 'x-amgi-profile',
  bridgeUrl: 'x-amgi-bridge-url',
  bridgeToken: 'x-amgi-bridge-token',
});

function header(request, name) {
  const raw = request.headers.get(name);
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

/** The settings a request carries; each one empty when its header is absent. */
export function readSettings(request) {
  return {
    baseDirOverride: header(request, PLAIN_HEADERS.baseDirOverride),
    collectionPath: header(request, PLAIN_HEADERS.collectionPath),
    profileName: header(request, PLAIN_HEADERS.profileName),
    bridge: {
      baseUrl: header(request, PLAIN_HEADERS.bridgeUrl),
      token: header(request, PLAIN_HEADERS.bridgeToken),
    },
  };
}

/** The headers that carry `settings`, for a caller that builds requests (the tests). */
export function settingsHeaders(settings) {
  return {
    [PLAIN_HEADERS.baseDirOverride]: encodeURIComponent(settings.baseDirOverride ?? ''),
    [PLAIN_HEADERS.collectionPath]: encodeURIComponent(settings.collectionPath ?? ''),
    [PLAIN_HEADERS.profileName]: encodeURIComponent(settings.profileName ?? ''),
    [PLAIN_HEADERS.bridgeUrl]: encodeURIComponent(settings.bridge?.baseUrl ?? ''),
    [PLAIN_HEADERS.bridgeToken]: encodeURIComponent(settings.bridge?.token ?? ''),
  };
}
