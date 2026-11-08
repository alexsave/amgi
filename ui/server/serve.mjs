// amgi's server: one plain Node http server that serves the C app (the HTML shell with cdom's shim
// inlined, app.wasm, the app's CSS, the icons) and the /api/anki routes (src/server/api), through a
// small adapter from Node's request to the web Request they take.
//
//   node ui/server/serve.mjs            (PORT, default 3000, the origin the Anki bridge allows by
//                                        default; PORT=0 takes a free one; binds 127.0.0.1)
//
// Every /api/anki answer and request body crosses in amgi's wire format (ui/wire/wire.h): the
// handler's answer object is written by the kind ROUTES names, and a body is read into the object
// the handler reads with bodyOf (src/server/anki/answer.js). There is no JSON on this path.
import './hooks.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ANSWER, withBody } from '../../src/server/anki/answer.js';
import { WIRE_MIME, decode, encode } from './wire.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const out = path.join(root, 'ui', 'out');
const apiDir = path.join(root, 'src', 'server', 'api', 'anki');
const PORT = Number(process.env.PORT ?? 3000);
// What `next dev` and `next start` did for the server: .env.local (GEMINI_API_KEY) into the
// environment, with a variable already set winning, as Next's does.
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Every route.js under src/server/api/anki, as a pattern: "[id]" segments are parameters.
function discoverRoutes(dir, segments = []) {
  const routes = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) routes.push(...discoverRoutes(path.join(dir, entry.name), [...segments, entry.name]));
    else if (entry.name === 'route.js') routes.push({ segments, file: path.join(dir, entry.name) });
  }
  return routes;
}
// Fixed segments before parameters, so /notes/bulk wins over /notes/[id].
const routes = discoverRoutes(apiDir).sort((a, b) =>
  b.segments.filter((s) => !s.startsWith('[')).length - a.segments.filter((s) => !s.startsWith('[')).length);
const modules = new Map(); // route file -> its module, imported on first use

function matchRoute(parts) {
  for (const route of routes) {
    if (route.segments.length !== parts.length) continue;
    const params = {};
    let ok = true;
    route.segments.forEach((segment, i) => {
      if (segment.startsWith('[')) params[segment.slice(1, -1)] = decodeURIComponent(parts[i]);
      else if (segment !== parts[i]) ok = false;
    });
    if (ok) return { route, params };
  }
  return null;
}

// What each route reads and answers: [the request body's kind or null, the answer's kind]. Any
// 4xx or 5xx answer is the error kind. A route missing here answers 501, never a guess.
const ROUTES = {
  'GET status': [null, 'status'],
  'GET decks': [null, 'decks'],
  'POST decks': ['q_deck_name', 'deck_created'],
  'PATCH decks/[id]': ['q_deck_name', 'deck_renamed'],
  'GET decks/[id]/notes': [null, 'notes'],
  'GET decks/[id]/notes/field-values': [null, 'field_values'],
  'GET install': [null, 'install_state'],
  'POST install': ['q_install', 'installed'],
  'GET profiles': [null, 'profiles'],
  'GET notetypes': [null, 'notetypes'],
  'POST notes': ['q_note', 'note_added'],
  'POST notes/bulk': ['q_notes', 'notes_added'],
  'PATCH notes/[id]': ['q_note_update', 'note_changed'],
  'DELETE notes/[id]': [null, 'note_changed'],
  'POST card-text': ['q_card_text', 'card_text'],
  'POST audio': ['q_audio', 'clip'],
  'GET starter': [null, 'starter_state'],
  'POST starter': ['q_starter', 'starter_built'],
  'GET media/[filename]': [null, null], // a clip's own bytes
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// An error answer as the error kind: the install route says what went wrong as `message`.
const asError = (answer) => (typeof answer?.error === 'string' || typeof answer?.message !== 'string'
  ? answer : { ...answer, error: answer.message });

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(2); // after /api/anki
  const found = matchRoute(parts);
  if (!found) return send(res, 404, 'text/plain', 'no such route');
  const shape = ROUTES[`${req.method} ${found.route.segments.join('/')}`];
  if (!shape) return send(res, 501, 'text/plain', `no wire layout for ${req.method} ${url.pathname}`);
  let mod = modules.get(found.route.file);
  if (!mod) {
    mod = await import(pathToFileURL(found.route.file).href);
    modules.set(found.route.file, mod);
  }
  const handler = mod[req.method];
  if (!handler) return send(res, 405, 'text/plain', 'method not allowed');
  let body = null;
  if (shape[0]) {
    if (!(req.headers['content-type'] || '').startsWith(WIRE_MIME)) {
      return send(res, 415, WIRE_MIME, encode('error', { error: `send the body as ${WIRE_MIME}` }));
    }
    body = decode(shape[0], await readBody(req));
    if (!body) return send(res, 400, WIRE_MIME, encode('error', { error: 'the body is not a whole message of its kind' }));
  }
  const request = new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
  });
  // What the handlers read with bodyOf: the object the wire body decoded to.
  if (body) withBody(request, body);
  const response = await handler(request, { params: Promise.resolve(found.params) });
  if (!(ANSWER in response)) {
    // Not an object answer (a clip's bytes from /media): passed through as it is.
    const headers = Object.fromEntries(response.headers);
    res.writeHead(response.status, headers);
    return res.end(Buffer.from(await response.arrayBuffer()));
  }
  const answer = response[ANSWER];
  const headers = Object.fromEntries(response.headers);
  if (response.status >= 400) return send(res, response.status, WIRE_MIME, encode('error', asError(answer)), headers);
  return send(res, response.status, WIRE_MIME, encode(shape[1], answer), headers);
}

// The app's own files. Every page path is the one shell: C routes.
const PAGES = /^\/(decks|settings|deck\/[^/]+)?$/;
const FILES = {
  '/app.wasm': [path.join(out, 'app.wasm'), 'application/wasm'],
  '/app.css': [path.join(out, 'app.css'), 'text/css; charset=utf-8'],
};
const PUBLIC_TYPES = { '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { ...extra, 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function serveFile(res, file, type) {
  fs.readFile(file, (err, data) => (err ? send(res, 404, 'text/plain', 'not found') : send(res, 200, type, data)));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname.startsWith('/api/anki/')) return await api(req, res, url);
    if (url.pathname === '/') {
      res.writeHead(307, { location: '/decks' });
      return res.end();
    }
    if (PAGES.test(url.pathname)) return serveFile(res, path.join(out, 'index.html'), 'text/html; charset=utf-8');
    if (FILES[url.pathname]) return serveFile(res, ...FILES[url.pathname]);
    const pub = path.join(root, 'public', path.basename(url.pathname));
    const type = PUBLIC_TYPES[path.extname(pub)];
    if (type && path.dirname(url.pathname) === '/') return serveFile(res, pub, type);
    return send(res, 404, 'text/plain', 'not found');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, 'text/plain', String(error?.message || error));
    else res.end();
  }
});
// The line the drives read to learn the port when they ask for a free one.
server.listen(PORT, '127.0.0.1', () => console.log(`amgi on http://127.0.0.1:${server.address().port}`));
