import { NextResponse } from 'next/server';
import { readSettings } from '../../../../server/anki/settings';
import { resolveTransport } from '../../../../server/anki/transport';
import { notReadyResponse } from '../../../../server/anki/respond';
import { buildStarterDeck, starterState } from '../../../../server/anki/starterDeck';

// The free sample deck - see src/server/anki/starterDeck.js for what it is
// and why it can exist without an OpenAI key.

// Whether to offer it, and in which languages. Deliberately needs no Anki
// transport: this answers "does this build have a starter deck in it", which
// is true or false before anybody has picked a profile.
export async function GET() {
  return NextResponse.json(starterState());
}

export async function POST(request) {
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const body = await request.json().catch(() => ({}));
  const known = typeof body?.known === 'string' ? body.known : '';
  const learning = typeof body?.learning === 'string' ? body.learning : '';
  const name = (body?.name || '').trim();
  if (!known || !learning) {
    return NextResponse.json({ error: 'known and learning languages are required' }, { status: 400 });
  }

  try {
    const built = await buildStarterDeck({
      ops: result.ops,
      known,
      learning,
      deckName: name || 'amgi starter',
    });
    return NextResponse.json({ mode: result.mode, ...built });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
