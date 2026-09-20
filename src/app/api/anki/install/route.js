import { NextResponse } from 'next/server';
import { readSettings } from '../../../../server/anki/settings';
import { installAddons } from '../../../../server/anki/install';
import { discoverProfiles } from '../../../../server/anki/transport';

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
