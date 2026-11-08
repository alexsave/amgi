'use strict';

// A stand-in for a generator subprocess, forked by ipcGate.test.js: it reaches
// the parent's gate the way generate-clip.js does (gateForThisProcess), does
// what argv[2] says, reports its answer and exits.

const { gateForThisProcess } = require('../../lib/ipcGate');

const M = 'gemini-3.8-flash-tts';

(async () => {
  const gate = gateForThisProcess();
  const first = await gate.acquire(M);
  if (process.argv[2] === 'acquire-then-429') gate.record(M, 'rateLimited', 45_000);
  process.send({ result: first }, () => process.disconnect());
})();
