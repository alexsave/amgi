import { readSettings } from '../../../../../server/anki/settings';
import { resolveTransport } from '../../../../../server/anki/transport';
import { notReadyResponse } from '../../../../../server/anki/respond';

// Serving one clip out of the collection's media folder, so the app can play
// a card back before you ever open Anki.
//
// This is the one thing the redesign needed that no existing route could do:
// every other route moves JSON, and a note field only ever holds a filename.
// Both transports implement readMedia, because "play this clip" has to work
// whether Anki is open or closed, and the folder is reachable in both cases
// even though the collection file is not.
export async function GET(request, { params }) {
  const { filename } = await params;
  const settings = readSettings(request);
  const transport = await resolveTransport(settings);
  if (!transport.ops) return notReadyResponse(transport);

  const data = await transport.ops.readMedia(filename);
  if (!data) return new Response('no such clip', { status: 404 });

  return new Response(data, {
    headers: {
      // Content-hashed names (see plusaudio/lib/audio-store.js) mean a given
      // name is always the same bytes, so this can be cached hard.
      'Content-Type': contentTypeFor(filename),
      'Content-Length': String(data.length),
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}

function contentTypeFor(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  return 'application/octet-stream';
}
