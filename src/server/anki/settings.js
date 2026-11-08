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
  bridge: Object.freeze({ baseUrl: '', token: '' }),
});

// The same five facts as plain headers, one each, every value percent-encoded UTF-8
// (encodeURIComponent's form, since a header carries only Latin-1 and a profile path may be
// Korean). This is what the C app sends: no JSON to write in the browser, and nothing to parse
// here but the percent escapes. The JSON header stays for the documented API (skills/amgi).
export const PLAIN_HEADERS = Object.freeze({
  baseDirOverride: 'x-amgi-base-dir',
  collectionPath: 'x-amgi-collection',
  profileName: 'x-amgi-profile',
  bridgeUrl: 'x-amgi-bridge-url',
  bridgeToken: 'x-amgi-bridge-token',
});

function plainHeader(request, name) {
  const raw = request.headers.get(name);
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

function readPlainSettings(request) {
  if (!Object.values(PLAIN_HEADERS).some((name) => request.headers.has(name))) return null;
  return {
    baseDirOverride: plainHeader(request, PLAIN_HEADERS.baseDirOverride),
    collectionPath: plainHeader(request, PLAIN_HEADERS.collectionPath),
    profileName: plainHeader(request, PLAIN_HEADERS.profileName),
    bridge: {
      baseUrl: plainHeader(request, PLAIN_HEADERS.bridgeUrl),
      token: plainHeader(request, PLAIN_HEADERS.bridgeToken),
    },
  };
}

/**
 * Read and validate the settings off a Request: the plain headers when any is present, else the
 * JSON header, falling back to defaults on anything malformed.
 */
export function readSettings(request) {
  const plain = readPlainSettings(request);
  if (plain) return plain;
  const raw = request.headers.get(HEADER_NAME);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw);
    return {
      baseDirOverride: typeof parsed.baseDirOverride === 'string' ? parsed.baseDirOverride : '',
      collectionPath: typeof parsed.collectionPath === 'string' ? parsed.collectionPath : '',
      profileName: typeof parsed.profileName === 'string' ? parsed.profileName : '',
      // No `enabled`: a configured address and token IS the enabled state.
      // Older saved settings may still carry the flag; it is ignored rather
      // than honoured, so somebody who had switched the bridge off does not
      // stay locked out after upgrading.
      bridge: {
        baseUrl: typeof parsed.bridge?.baseUrl === 'string' ? parsed.bridge.baseUrl : '',
        token: typeof parsed.bridge?.token === 'string' ? parsed.bridge.token : '',
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
