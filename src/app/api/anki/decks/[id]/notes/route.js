import { NextResponse } from 'next/server';
import { readSettings } from '../../../../../../server/anki/settings';
import { resolveTransport } from '../../../../../../server/anki/transport';
import { notReadyResponse } from '../../../../../../server/anki/respond';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request, { params }) {
  const { id } = await params;
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const url = new URL(request.url);
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT));

  const page = await result.ops.listNotesInDeck(Number(id), { offset, limit });
  return NextResponse.json({ mode: result.mode, ...page });
}
