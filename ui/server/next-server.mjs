// What the route handlers import as 'next/server', without Next: NextResponse.json keeps the
// answer as an object on the response, and the server decides how it crosses (amgi's wire format
// for the app, JSON for everyone else; see serve.mjs). The handlers themselves are not changed.
export const ANSWER = Symbol('amgi answer');

export class NextResponse extends Response {
  static json(body, init = {}) {
    const response = new Response(null, { status: init.status ?? 200, headers: init.headers });
    response[ANSWER] = body;
    return response;
  }
}
