import { NextResponse } from 'next/server';
import { readSettings } from '../../../../server/anki/settings';
import { collectionDrift, installAddons, installState } from '../../../../server/anki/install';
import { discoverProfiles, resolveTransport } from '../../../../server/anki/transport';

// One-button setup: copy amgi's two add-ons and its card type into the Anki
// data folder. See src/server/anki/install.js for why the note type itself is
// created by the add-on rather than here.
export async function POST(request) {
  const settings = readSettings(request);
  // The override in the request body wins over the one in the saved settings
  // header. The Settings panel holds an unsaved override in React state, so
  // reading only the saved value silently installs somewhere other than the
  // folder the person is looking at - which is how add-ons end up written
  // into a real Anki profile by accident.
  const body = await request.json().catch(() => ({}));
  const override = typeof body.baseDirOverride === 'string' && body.baseDirOverride.trim()
    ? body.baseDirOverride.trim()
    : settings.baseDirOverride;
  const { baseDir } = discoverProfiles(override);
  const result = installAddons({ baseDir });
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
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
  return NextResponse.json({
    ...state,
    collectionChecked: collection.checked,
    collectionStale: collection.stale,
    // "Everything amgi controls is in place AND Anki is running it."
    ready: state.upToDate === true && collection.checked && collection.stale.length === 0,
  });
}
