// How every screen explains "which Anki transport is live, or why neither
// is" - the single central piece of state this app has (see
// src/server/anki/transport.js for where these modes come from). Shared
// between the always-visible navbar badge and any screen's own empty/error
// state, so a locked collection is explained the same way everywhere
// instead of the badge saying one thing and the page under it saying
// another (or worse, the page just showing "you have no decks yet").
export const ANKI_READY_MODES = new Set(['bridge', 'direct']);

export const ANKI_MODE_PRESENTATION = {
  bridge: {
    // Both working modes read as the same thing to a person - amgi can see
    // their collection - so they say the same thing. Which transport got
    // there is in the tooltip, where it belongs: it matters when something
    // breaks and never otherwise. "Anki (closed)" in particular read as a
    // fault rather than as the ordinary, fastest case that it is.
    label: 'Anki connected',
    color: '#4caf50',
    title: 'Reading your live collection through the Anki bridge add-on.',
  },
  direct: {
    label: 'Anki connected',
    color: '#4caf50',
    title: 'Reading your Anki collection file directly - Anki is closed.',
  },
  locked: {
    label: 'Anki locked',
    color: '#e07050',
    title: 'Anki is open and the bridge is not reachable, so your collection cannot be read right now. ' +
      'Close Anki, or start the bridge (Tools > amgi: Bridge status...) and paste its token into Settings.',
  },
  'bridge-no-collection': {
    label: 'Anki: no profile',
    color: '#e07050',
    title: 'The bridge is running but no Anki profile is open yet - pick one in Anki.',
  },
  'not-found': {
    label: 'Anki: not found',
    color: '#e07050',
    title: 'No collection.anki2 was found at the selected profile. Open Settings to pick a different one.',
  },
  'unsupported-schema': {
    label: 'Anki: unsupported',
    color: '#e07050',
    title: 'This collection uses a schema version amgi does not support yet.',
  },
  unconfigured: {
    label: 'Anki: not set up yet',
    color: '#808080',
    title: 'amgi has not been installed into Anki on this machine yet.',
  },
};

export function ankiModePresentation(mode) {
  return ANKI_MODE_PRESENTATION[mode] || ANKI_MODE_PRESENTATION.unconfigured;
}
