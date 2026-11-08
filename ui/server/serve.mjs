// amgi without Next: one plain Node http server that serves the C app (the HTML shell with cdom's
// shim inlined, app.wasm, the app's CSS, the icons) and mounts the existing /api/anki route
// handlers unchanged, through a small adapter from Node's request to the web Request they take.
//
//   node ui/server/serve.mjs            (PORT, default 3142; binds 127.0.0.1)
//
// An /api/anki answer crosses in amgi's wire format (ui/wire/wire.h) when the request says
// "Accept: application/x-amgi-wire", which the app always does, and as JSON otherwise, which is
// the API skills/amgi documents for LLMs, scripts and the add-ons.
import './hooks.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ANSWER } from './next-server.mjs';
import { WIRE_MIME, encoders } from './wire.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const out = path.join(root, 'ui', 'out');
const apiDir = path.join(root, 'src', 'app', 'api', 'anki');
const PORT = Number(process.env.PORT || 3142);
// What `next dev` and `next start` did for the server: .env.local (GEMINI_API_KEY) into the
// environment, with a variable already set winning, as Next's does.
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Every route.js under src/app/api/anki, as a pattern: "[id]" segments are parameters.
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

// Which writer a route's success answer goes to; any 4xx or 5xx answer with an error goes to the
// error writer. A route with none answers 406 to a wire request rather than bytes C cannot read.
const WIRE_ROUTES = { 'GET status': 'status', 'GET decks': 'decks', 'GET install': 'install', 'GET profiles': 'profiles' };

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(2); // after /api/anki
  const found = matchRoute(parts);
  if (!found) return send(res, 404, 'text/plain', 'no such route');
  let mod = modules.get(found.route.file);
  if (!mod) {
    mod = await import(pathToFileURL(found.route.file).href);
    modules.set(found.route.file, mod);
  }
  const handler = mod[req.method];
  if (!handler) return send(res, 405, 'text/plain', 'method not allowed');
  const request = new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req),
  });
  const response = await handler(request, { params: Promise.resolve(found.params) });
  const wantsWire = (req.headers.accept || '').includes(WIRE_MIME);
  if (!(ANSWER in response)) {
    // Not an object answer (a clip's bytes from /media): passed through as it is.
    const headers = Object.fromEntries(response.headers);
    res.writeHead(response.status, headers);
    return res.end(Buffer.from(await response.arrayBuffer()));
  }
  const answer = response[ANSWER];
  if (!wantsWire) return send(res, response.status, 'application/json', JSON.stringify(answer));
  const kind = response.status >= 400 ? 'error' : WIRE_ROUTES[`${req.method} ${found.route.segments.join('/')}`];
  if (!kind) return send(res, 406, 'text/plain', `no wire layout for ${req.method} ${url.pathname} yet`);
  return send(res, response.status, WIRE_MIME, encoders[kind](answer));
}

// The app's own files. Every page path is the one shell: C routes.
const PAGES = /^\/(decks|settings|deck\/[^/]+)?$/;
const FILES = {
  '/app.wasm': [path.join(out, 'app.wasm'), 'application/wasm'],
  '/app.css': [path.join(out, 'app.css'), 'text/css; charset=utf-8'],
};
const PUBLIC_TYPES = { '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function serveFile(res, file, type) {
  fs.readFile(file, (err, data) => (err ? send(res, 404, 'text/plain', 'not found') : send(res, 200, type, data)));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
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
server.listen(PORT, '127.0.0.1', () => console.log(`amgi on http://127.0.0.1:${PORT}`));
