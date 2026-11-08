// One implementation of the collection-parity protocol (test/parity/protocol.mjs) as a process:
// one server session, as the backup ledger and the lock chains see it. Which one is
// AMGI_COLLECTION_IMPL's: the C CLI at that path, or (unset) the Node one, which goes at L4.
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const IMPL = process.env.AMGI_COLLECTION_IMPL;

export function implCommand() {
  return IMPL
    ? [IMPL, []]
    : [process.execPath, ['--import', './ui/server/hooks.mjs', 'test/parity/collection-impl.mjs']];
}

/** One implementation process: one server session, as the ledger and the lock chains see it. */
export class Impl {
  constructor() {
    const [cmd, args] = implCommand();
    this.child = spawn(cmd, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
    this.buffer = '';
    this.waiting = [];
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      this.drain();
    });
  }

  drain() {
    while (this.waiting.length) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.waiting.shift()(line);
    }
  }

  line() {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.drain();
    });
  }

  /** How many lines follow an answer's first line. */
  static following(verb, first) {
    const t = first.split(' ');
    if (t[0] !== 'ok') return 0;
    if (verb === 'listDecks' || verb === 'listNotetypes' || verb === 'addNotesBulk') return Number(t[1]);
    if (verb === 'listNotesInDeck') return Number(t[4]);
    return 0;
  }

  async answer(verb) {
    const first = await this.line();
    const rest = [];
    for (let i = Impl.following(verb, first); i > 0; i -= 1) rest.push(await this.line());
    return [first, ...rest].join('\n');
  }

  /** Send a command (and the lines it carries) and read its whole answer. */
  async cmd(line, more = []) {
    this.child.stdin.write(`${[line, ...more].join('\n')}\n`);
    return this.answer(line.split(' ')[0]);
  }

  /** Several single-line commands at once; their answers in order. */
  async parallel(lines) {
    this.child.stdin.write(`parallel ${lines.length}\n${lines.join('\n')}\n`);
    const answers = [];
    for (const line of lines) answers.push(await this.answer(line.split(' ')[0]));
    return answers;
  }

  async close() {
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.stdin.end('quit\n');
    await exited;
  }
}

