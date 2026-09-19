import { NextResponse } from 'next/server';
import { readSettings } from '../../../../server/anki/settings';
import { resolveTransport } from '../../../../server/anki/transport';

// The single source of truth for "which mode is amgi in right now" - the
// mode banner polls this on an interval instead of trusting whatever it
// last knew, which is what makes the state re-probe without a page reload
// (see transport.js's module comment).
export async function GET(request) {
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  // Never a non-200: unlike every other /api/anki/* route, a "bad" mode here
  // (locked, not-found, unconfigured) is the actual, correct answer to the
  // question this endpoint exists to answer, not a failure of the request.
  return NextResponse.json({
    mode: result.mode,
    schemaVersion: result.schemaVersion,
    detail: result.detail,
  });
}
