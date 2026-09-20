import { NextResponse } from 'next/server';
import { readSettings } from '../../../../server/anki/settings';
import { resolveTransport } from '../../../../server/anki/transport';
import { notReadyResponse } from '../../../../server/anki/respond';
import { generateCardTextAndAudio } from '../../../../server/anki/cardText';

// Generates both sides of a card and its audio in one request - never two,
// see cardText.js's own module comment for why splitting them would throw
// away the reading that steers Japanese/Chinese pronunciation.
export async function POST(request) {
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const body = await request.json();
  const userInput = (body?.userInput || '').trim();
  const knownLanguage = body?.knownLanguage;
  const learningLanguage = body?.learningLanguage;
  if (!userInput || !knownLanguage || !learningLanguage) {
    return NextResponse.json(
      { error: 'userInput, knownLanguage and learningLanguage are required' },
      { status: 400 },
    );
  }

  try {
    const card = await generateCardTextAndAudio({
      userInput,
      knownLanguage,
      learningLanguage,
      ops: result.ops,
    });
    return NextResponse.json({ mode: result.mode, ...card });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
