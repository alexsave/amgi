'use strict';

// Parsing the client's Anki settings out of a request header.
//
// The browser is the only place that knows which profile a person picked and
// whether they pasted in a bridge token, and it remembers that choice in
// localStorage (see src/lib/ankiSettings.js) rather than a server-side
// session, since there is no login for this surface. Every request to
// /api/anki/* carries that choice in one header so route handlers stay
// stateless: nothing here is cached between requests, which is what makes
// "re-probe on every call" (see transport.js) free instead of a feature that
// has to be built.

const HEADER_NAME = 'x-amgi-anki-settings';

const DEFAULT_SETTINGS = Object.freeze({
  baseDirOverride: '',
  collectionPath: '',
  profileName: '',
  bridge: Object.freeze({ enabled: false, baseUrl: '', token: '' }),
});

/** Read and validate the settings header off a Next.js Request, falling back to defaults on anything malformed. */
function readSettings(request) {
  const raw = request.headers.get(HEADER_NAME);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw);
    return {
      baseDirOverride: typeof parsed.baseDirOverride === 'string' ? parsed.baseDirOverride : '',
      collectionPath: typeof parsed.collectionPath === 'string' ? parsed.collectionPath : '',
      profileName: typeof parsed.profileName === 'string' ? parsed.profileName : '',
      bridge: {
        enabled: Boolean(parsed.bridge?.enabled),
        baseUrl: typeof parsed.bridge?.baseUrl === 'string' ? parsed.bridge.baseUrl : '',
        token: typeof parsed.bridge?.token === 'string' ? parsed.bridge.token : '',
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

module.exports = { DEFAULT_SETTINGS, HEADER_NAME, readSettings };
