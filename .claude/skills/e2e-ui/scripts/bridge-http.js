'use strict';

// Drives a real amgi_bridge HTTP server (bridge_server_entry.py, backed by a
// real Anki collection through bridge_ops.py - see that file's own comment
// for exactly what "real" means here) with real HTTP requests, to prove the
// token and Origin rules bridge_auth.py enforces - the same rules
// src/server/anki/bridgeClient.js's requests have to satisfy - against
// actual bytes on a socket, not a mock of either side.
//
//   node .claude/skills/e2e-ui/scripts/fixture.js .e2e/fixture
//   node .claude/skills/e2e-ui/scripts/bridge-http.js .e2e/fixture/collection.anki2
//
// Exits non-zero if any check fails.

const path = require('path');
const { spawn } = require('child_process');
const { anki } = require('./fixture');

const TOKEN = 'e2e-test-token';
const TOKEN_HEADER = 'X-Amgi-Bridge-Token';
// The default anki/addon/amgi_bridge/config.json allowlist - the amgi web
// UI's own local dev origin.
const ALLOWED_ORIGIN = 'http://localhost:3000';
const FOREIGN_ORIGIN = 'https://evil.example';

function startServer(collectionPath) {
  const script = path.join(__dirname, 'bridge_server_entry.py');
  const child = spawn(anki.bin, [script, collectionPath, TOKEN, ALLOWED_ORIGIN, '0'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const ready = new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk) => {
      const match = chunk.toString().match(/^LISTENING (\d+)/);
      if (match) resolve(Number(match[1]));
      else reject(new Error(`unexpected output starting the bridge: ${chunk}`));
    });
    child.once('error', reject);
  });
  function stop() {
    return new Promise((resolve) => {
      child.once('exit', resolve);
      child.stdin.write('\n');
      child.stdin.end();
    });
  }
  return { ready, stop };
}

let failures = 0;
async function check(label, response, expectedStatus) {
  const ok = response.status === expectedStatus;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} -> ${response.status} (expected ${expectedStatus})`);
  if (!ok) failures += 1;
  return response;
}

(async () => {
  const collectionPath = process.argv[2];
  if (!collectionPath) {
    console.error('usage: node bridge-http.js <path to a fixture collection.anki2>');
    process.exit(1);
  }
  if (!anki) {
    console.error('no python with the `anki` library on PATH; see fixture.js\'s own top comment');
    process.exit(1);
  }

  const server = startServer(collectionPath);
  const port = await server.ready;
  const base = `http://127.0.0.1:${port}`;
  console.log(`bridge listening on ${base}\n`);

  const get = (routePath, headers) => fetch(`${base}${routePath}`, { headers });

  // -- Token rules --------------------------------------------------------
  await check('no token at all', await get('/status', {}), 401);
  await check('wrong token', await get('/status', { [TOKEN_HEADER]: 'not-the-token' }), 401);
  await check(
    'correct token, no Origin header (the Node bridge client\'s own shape - see bridgeClient.js)',
    await get('/status', { [TOKEN_HEADER]: TOKEN }),
    200,
  );

  // -- Origin rules ---------------------------------------------------------
  await check(
    'correct token, allowed Origin',
    await get('/status', { [TOKEN_HEADER]: TOKEN, Origin: ALLOWED_ORIGIN }),
    200,
  );
  await check(
    'correct token, foreign Origin - rejected even though the token is right',
    await get('/status', { [TOKEN_HEADER]: TOKEN, Origin: FOREIGN_ORIGIN }),
    403,
  );

  const preflightAllowed = await fetch(`${base}/decks`, {
    method: 'OPTIONS',
    headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' },
  });
  await check('CORS preflight from the allowed origin', preflightAllowed, 204);

  const preflightForeign = await fetch(`${base}/decks`, {
    method: 'OPTIONS',
    headers: { Origin: FOREIGN_ORIGIN, 'Access-Control-Request-Method': 'POST' },
  });
  await check('CORS preflight from a foreign origin', preflightForeign, 403);

  // -- And a real mutation actually lands in the collection, not just a 200 --
  const createResponse = await fetch(`${base}/decks`, {
    method: 'POST',
    headers: { [TOKEN_HEADER]: TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `e2e-ui bridge ${Date.now()}` }),
  });
  await check('creating a deck through the bridge', createResponse, 200);
  const created = await createResponse.json();
  console.log(`  -> ${JSON.stringify(created)}`);

  const decksResponse = await get('/decks', { [TOKEN_HEADER]: TOKEN });
  const decks = await decksResponse.json();
  const found = decks.some((d) => d.id === created.deck.id);
  console.log(`${found ? 'ok  ' : 'FAIL'} the deck just created shows up in a fresh GET /decks`);
  if (!found) failures += 1;

  await server.stop();

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nOK: the bridge\'s token and Origin rules are proven over real HTTP against a real collection.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
