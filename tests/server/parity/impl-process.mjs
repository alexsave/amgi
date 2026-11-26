// The collection core as a process speaking the collection-parity protocol (tests/server/parity/protocol.mjs):
// one server session, as the backup ledger and the lock chains see it. It is the C core's CLI,
// server/build/collection_cli (make -C server), or the program AMGI_COLLECTION_IMPL names.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { sandboxEnv } from '../../repo/sandbox-home.cjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const IMPL = process.env.AMGI_COLLECTION_IMPL;

export const COLLECTION_CLI = path.join(ROOT, 'server', 'build', 'collection_cli');

export function implCommand() {
    return [IMPL || COLLECTION_CLI, []];
}

/** One implementation process: one server session, as the ledger and the lock chains see it. */
export class Impl {
    constructor() {
        const [cmd, args] = implCommand();
        this.child = spawn(cmd, args, { cwd: ROOT, env: sandboxEnv(), stdio: ['pipe', 'pipe', 'inherit'] });
        this.buffer = '';
        this.waiting = [];
        this.failure = null;
        // A process that cannot start (spawn ENOENT) or dies mid-session answers nothing, so every
        // read pending on it, and every later one, fails at once instead of waiting forever.
        this.child.once('error', (error) => this.fail(error));
        this.child.once('exit', (code, signal) => this.fail(new Error(`the collection process exited (${code ?? signal}) before it answered`)));
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', (chunk) => {
            this.buffer += chunk;
            this.drain();
        });
    }

    fail(error) {
        this.failure ??= error;
        for (const w of this.waiting.splice(0)) w.reject(this.failure);
    }

    drain() {
        while (this.waiting.length) {
            const nl = this.buffer.indexOf('\n');
            if (nl < 0) return;
            const line = this.buffer.slice(0, nl);
            this.buffer = this.buffer.slice(nl + 1);
            this.waiting.shift().resolve(line);
        }
    }

    line() {
        return new Promise((resolve, reject) => {
            if (this.failure) {
                reject(this.failure);
                return;
            }
            this.waiting.push({ resolve, reject });
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

    send(text) {
        if (this.failure) throw this.failure;
        this.child.stdin.on('error', () => {});
        this.child.stdin.write(text);
    }

    /** Send a command (and the lines it carries) and read its whole answer. */
    async cmd(line, more = []) {
        this.send(`${[line, ...more].join('\n')}\n`);
        return this.answer(line.split(' ')[0]);
    }

    /** Several single-line commands at once; their answers in order. */
    async parallel(lines) {
        this.send(`parallel ${lines.length}\n${lines.join('\n')}\n`);
        const answers = [];
        for (const line of lines) answers.push(await this.answer(line.split(' ')[0]));
        return answers;
    }

    async close() {
        if (this.failure) return;
        const exited = new Promise((resolve) => this.child.once('exit', resolve));
        this.child.stdin.on('error', () => {});
        this.child.stdin.end('quit\n');
        await exited;
    }
}

