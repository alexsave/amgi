import { NextResponse } from 'next/server';
import { readSettings } from '../../../../server/anki/settings';
import { resolveTransport } from '../../../../server/anki/transport';
import { notReadyResponse } from '../../../../server/anki/respond';
import { generateAndStoreClip } from '../../../../server/anki/audio';

export async function POST(request) {
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const body = await request.json();
  const text = (body?.text || '').trim();
  const language = body?.language;
  const fresh = body?.fresh === true;
  if (!text || !language) {
    return NextResponse.json({ error: 'text and language are required' }, { status: 400 });
  }

  try {
    const { filename, reference, reused } = await generateAndStoreClip({ text, language, fresh, ops: result.ops });
    return NextResponse.json({ mode: result.mode, filename, reference, reused });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
