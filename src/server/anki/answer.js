// A route's answer. The handlers under src/server/api return the answer as an object, kept on the
// Response under ANSWER, and the server (ui/server/serve.mjs) writes it in amgi's wire format by the
// kind its route table names. The Response carries only the status and the headers.

export const ANSWER = Symbol.for('amgi.answer');

export function answer(body, init = {}) {
  const response = new Response(null, { status: init.status ?? 200, headers: init.headers });
  response[ANSWER] = body;
  return response;
}
