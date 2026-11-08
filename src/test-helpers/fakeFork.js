// A stand-in for child_process.fork in jest tests of the code that runs
// plusaudio's scripts (src/server/anki/plusaudioCli.js): a child with stdout
// and stderr streams, an IPC-shaped send/on('message'), and an exit code -
// decided by `outcome(args)`, which answers {stdout, stderr, code} (or
// throws/rejects with an object carrying them).

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function fakeFork(args, outcome) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.send = () => true;
  Promise.resolve()
    .then(() => outcome(args))
    .then(
      (result = {}) => ({ code: result.code ?? 0, stdout: result.stdout || '', stderr: result.stderr || '' }),
      (error = {}) => ({ code: error.code ?? 1, stdout: error.stdout || '', stderr: error.stderr || '' }),
    )
    .then(({ code, stdout, stderr }) => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setImmediate(() => child.emit('close', code));
    });
  return child;
}

module.exports = { fakeFork };
