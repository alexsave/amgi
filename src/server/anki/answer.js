// A route's answer. The handlers under src/server/api return the answer as an object, kept on the
// Response under ANSWER, and the server (ui/server/serve.mjs) writes it in amgi's wire format by the
// kind its route table names. The Response carries only the status and the headers.

export const ANSWER = Symbol.for('amgi.answer');

export function answer(body, init = {}) {
  const response = new Response(null, { status: init.status ?? 200, headers: init.headers });
  response[ANSWER] = body;
  return response;
}

// A route's request body: the object the server decoded from the wire (ui/server/serve.mjs), kept
// on the Request under BODY. A route reads it with bodyOf; a route that takes none never asks.
export const BODY = Symbol.for('amgi.body');

/** The decoded body of `request`, or {} when it carried none. */
export function bodyOf(request) {
  return request[BODY] ?? {};
}

/** `request` with `body` as its decoded body: what the server does, for a caller that builds requests (the tests). */
export function withBody(request, body) {
  request[BODY] = body;
  return request;
}
