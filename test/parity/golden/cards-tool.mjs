// The C card policy's pure functions through server/test/golden_cards.c, for the golden tests.
// Builds the tool on first use (make -C server build/golden_cards, with APP_PROGS extended on the
// command line so the shared Makefile is unchanged), then answers a batch of calls in one run.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const TOOL = path.join(ROOT, 'server', 'build', 'golden_cards');
let built = false;

// node --test runs the golden files side by side; one make at a time (a directory is the lock).
const LOCK = path.join(ROOT, 'server', 'build', '.golden_cards.lock');
function build() {
  if (built) return;
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  for (let tries = 0; ; tries++) {
    try {
      fs.mkdirSync(LOCK);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || tries > 600) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  try {
    execFileSync('make', ['-s', '-C', path.join(ROOT, 'server'),
      'APP_PROGS=collection_cli=collection/cli.c app_unit=test/app_unit.c golden_cards=test/golden_cards.c', 'build/golden_cards'],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  } finally {
    fs.rmdirSync(LOCK);
  }
  built = true;
}

/** calls: [op, language, text][]; answers in order, as strings. */
export function cards(calls) {
  build();
  const parts = calls.flatMap(([op, language, text]) => {
    const l = Buffer.from(language, 'utf8'), t = Buffer.from(text, 'utf8');
    const head = Buffer.alloc(5);
    head.write(op, 0, 'latin1');
    head.writeUInt32LE(l.length, 1);
    const tl = Buffer.alloc(4);
    tl.writeUInt32LE(t.length, 0);
    return [head, l, tl, t];
  });
  const out = execFileSync(TOOL, { input: Buffer.concat(parts), maxBuffer: 64 << 20 });
  const answers = [];
  for (let at = 0; at < out.length;) {
    const n = out.readUInt32LE(at);
    answers.push(out.toString('utf8', at + 4, at + 4 + n));
    at += 4 + n;
  }
  return answers;
}

/** A golden file's rows, split on tabs. */
export function rows(fs, file) {
  return fs.readFileSync(path.join(import.meta.dirname, file), 'utf8').split('\n').filter((l) => l !== '').map((l) => l.split('\t'));
}
