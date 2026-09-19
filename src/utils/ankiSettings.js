// Where amgi remembers which Anki profile and bridge a person picked -
// entirely in this browser's localStorage, since there is no server-side
// account for any of this (the whole point of local-first). Every call to
// the /api/anki/* routes attaches this as a header (see ankiApi.js), and the
// server re-resolves the real transport from it on every single request -
// nothing about the choice itself is trusted or cached server-side.

const STORAGE_KEY = 'amgi:anki-settings';

export const DEFAULT_ANKI_SETTINGS = Object.freeze({
  baseDirOverride: '',
  collectionPath: '',
  profileName: '',
  bridge: Object.freeze({ enabled: false, baseUrl: 'http://127.0.0.1:8798', token: '' }),
});

export function loadAnkiSettings() {
  if (typeof window === 'undefined') return DEFAULT_ANKI_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ANKI_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_ANKI_SETTINGS, ...parsed, bridge: { ...DEFAULT_ANKI_SETTINGS.bridge, ...parsed.bridge } };
  } catch {
    return DEFAULT_ANKI_SETTINGS;
  }
}

export function saveAnkiSettings(settings) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  // Other components (the mode banner, DeckContext) hold their own copy in
  // React state; this tells same-tab listeners to reread it, since the
  // native `storage` event only fires for *other* tabs/windows.
  window.dispatchEvent(new Event('amgi:anki-settings-changed'));
}

export const ANKI_SETTINGS_CHANGED_EVENT = 'amgi:anki-settings-changed';
