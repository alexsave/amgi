import { answer, bodyOf } from '../../../anki/answer';
import { readSettings } from '../../../../server/anki/settings';
import { INSTALLED_MESSAGE, collectionDrift, installAddons, installNotetypeDirect, installState } from '../../../../server/anki/install';
import { discoverProfiles, resolveTransport } from '../../../../server/anki/transport';

// One-button setup: copy amgi's two add-ons and its card type into the Anki
// data folder, and, when Anki is closed, create the note type in the
// collection right here. With Anki open the add-on does that at its next
// start. See src/server/anki/install.js for how the two writers split.
export async function POST(request) {
  const settings = readSettings(request);
  // The override in the request body wins over the one in the saved settings
  // header. The Settings panel holds an unsaved override of its own, so
  // reading only the saved value silently installs somewhere other than the
  // folder the person is looking at - which is how add-ons end up written
  // into a real Anki profile by accident.
  const body = bodyOf(request);
  const override = typeof body.baseDirOverride === 'string' && body.baseDirOverride.trim()
    ? body.baseDirOverride.trim()
    : settings.baseDirOverride;
  const { baseDir } = discoverProfiles(override);
  const result = installAddons({ baseDir });
  if (!result.ok) return answer(result, { status: 409 });

  // Whichever transport is live right now: only the direct one can write.
  const transport = await resolveTransport(settings);
  const notetype = await installNotetypeDirect({ ops: transport.ops });
  const ready = notetype.created || notetype.existed === true;
  return answer(
    { ...result, notetypeCreated: notetype.created, needsRestart: !ready, message: ready ? INSTALLED_MESSAGE : result.message },
    { status: 200 },
  );
}

// Whether amgi is already in this Anki, and whether Anki has caught up.
//
// Two questions, deliberately both answered here, because answering only the
// first is what let a stale card design look like a finished install: the
// files can be perfectly current on disk while the collection still holds
// last week's template, and only opening Anki closes that gap.
//
// The collection half needs a transport and the file half does not, so a
// locked or unconfigured collection still gets a real answer to "is amgi
// installed" rather than an error.
export async function GET(request) {
  const settings = readSettings(request);
  const { baseDir } = discoverProfiles(settings.baseDirOverride);
  const state = installState({ baseDir });

  const transport = await resolveTransport(settings);
  const collection = await collectionDrift({ ops: transport.ops });
  return answer({
    ...state,
    collectionChecked: collection.checked,
    collectionStale: collection.stale,
    // "Everything amgi controls is in place AND Anki is running it."
    ready: state.upToDate === true && collection.checked && collection.stale.length === 0,
  });
}
