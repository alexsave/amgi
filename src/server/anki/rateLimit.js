// What the app's generation routes say about Gemini's limits, in one place.
//
// The rate gate itself (plusaudio/lib/rateGate.js) is the one owner of WHEN
// a request may go; this file only turns its answers, and the typed errors a
// generator subprocess reports (plusaudioCli.js), into HTTP:
//
//   - admissionRefusal(): asked before a route starts any new card or clip.
//     While the gate says a model is blocked, the answer is 429 at once,
//     {error, retryAfterMs, notStarted: true} - no subprocess, no Gemini
//     call, and so no text call spent on a card that could only be refused.
//   - limitResponse(error): a card or clip that WAS started and then hit a
//     long per-minute limit answers 429 {error, retryAfterMs} with a
//     Retry-After header; a spent daily cap answers 429 {error, dailyCap}.
//     Anything else is not ours to answer and returns null.
//
// retryAfterMs is always the gate's own jittered wait; the browser displays
// it and waits exactly that long (BulkRun.js), and has no timing of its own.

import { NextResponse } from 'next/server';
import { sharedGate } from 'plusaudio/lib/rateGate';

function retryAfterResponse(error, retryAfterMs, extra = {}) {
  return NextResponse.json(
    { error, retryAfterMs, ...extra },
    { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } },
  );
}

/** A 429 when new work may not start yet, or null when it may. */
export function admissionRefusal(gate = sharedGate()) {
  const wait = gate.admissionWait();
  if (wait <= 0) return null;
  return retryAfterResponse(
    `Gemini's per-minute limit is reached; this card waits ${Math.ceil(wait / 1000)}s before starting.`,
    wait,
    { notStarted: true },
  );
}

/** The 429 for a typed limit error from a generator, or null for any other error. */
export function limitResponse(error) {
  if (error?.rateLimited === true && Number.isFinite(error.retryAfterMs)) {
    return retryAfterResponse(error.message, error.retryAfterMs);
  }
  if (error?.dailyCap === true) {
    return NextResponse.json({ error: error.message, dailyCap: true }, { status: 429 });
  }
  return null;
}
