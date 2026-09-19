import { NextResponse } from 'next/server';
import { readSettings } from '../../../../server/anki/settings';
import { discoverProfiles } from '../../../../server/anki/transport';

// Profile discovery: what the Setup screen calls to find real Anki profiles
// on this machine, or to say plainly that it found none - "no Anki installed
// yet" is a normal, expected first-run answer here, not an error.
export async function GET(request) {
  const settings = readSettings(request);
  const { baseDir, baseDirExists, profiles } = discoverProfiles(settings.baseDirOverride);
  return NextResponse.json({ baseDir, baseDirExists, profiles });
}
