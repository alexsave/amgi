'use strict';

// A shared shape for "the transport isn't in a state to do this right now" -
// used by every /api/anki/* route except /status itself (which reports these
// same modes as its normal, 200 answer; see status/route.js).
//
// The message text is what the UI shows verbatim in place of a stack trace or
// a generic "something went wrong" - the whole point of treating a locked
// collection as a first-class state instead of an error path.

const MESSAGES = {
  unconfigured: 'No Anki profile is selected yet. Open Settings to pick one.',
  'not-found': 'No collection.anki2 was found at the selected profile. Open Settings to pick a different one.',
  'unsupported-schema': 'This collection uses a schema version amgi does not support yet.',
  locked:
    'Anki is open on this collection and the local bridge is not reachable. ' +
    'Either close Anki, or turn on the bridge in Anki (Tools > amgi: Bridge status...) and paste its token into Settings.',
  'bridge-no-collection':
    'Anki is open with the bridge enabled, but no profile is loaded yet (the profile picker is showing). Pick a profile in Anki.',
};

function notReadyResponse(mode, extra = {}) {
  return Response.json(
    { mode, error: MESSAGES[mode] || `Anki collection is not available (${mode}).`, ...extra },
    { status: 409 },
  );
}

module.exports = { notReadyResponse };
