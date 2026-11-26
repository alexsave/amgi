// tools/indent4.py, the 4-space rule make lint runs: what it names, and what it leaves alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv } from './sandbox-home.cjs';

const SCRIPT = path.resolve(import.meta.dirname, '..', '..', 'tools', 'indent4.py');

/** The "line: reason" pairs indent4.py prints for one file named `name` holding `text`. */
function judged(name, text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indent4-'));
    try {
        const file = path.join(dir, name);
        fs.writeFileSync(file, text);
        const run = spawnSync('python3', ['-I', SCRIPT, file], { encoding: 'utf8', env: sandboxEnv() });
        const found = [...run.stdout.matchAll(/^.+?:(\d+): (.+)$/gm)].map((m) => `${m[1]}: ${m[2]}`);
        assert.equal(run.status, found.length ? 1 : 0, run.stdout + run.stderr);
        return found;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('a block 2 or 8 deeper than its opener is named; 4 deeper is right', () => {
    assert.deepEqual(judged('a.js', 'function f() {\n  return 1;\n}\n'), ['2: 2 deeper than the line that opens its block (4 is the step)']);
    assert.deepEqual(judged('a.c', 'int f(void) {\n        return 1;\n}\n'), ['2: 8 deeper than the line that opens its block (4 is the step)']);
    assert.deepEqual(judged('a.c', 'int f(void) {\n    return 1;\n}\n'), []);
    assert.deepEqual(judged('a.py', 'def f():\n  return 1\n'), ['2: 2 deeper than the line that opens its block (4 is the step)']);
    assert.deepEqual(judged('a.json', '{\n  "a": 1\n}\n'), ['2: 2 deeper than the line that opens its block (4 is the step)']);
});

test('a tab in the indent is named', () => {
    assert.deepEqual(judged('a.sh', 'f() {\n\techo hi\n}\n'), ['2: a tab in the indent']);
});

test('a closing line off the 4-space grid is named', () => {
    assert.deepEqual(judged('a.js', 'f(\n    function () {\n        g();\n      },\n);\n'), ['4: a closing line off the 4-space grid']);
});

test('a continuation aligned under its bracket is left alone', () => {
    assert.deepEqual(judged('a.c', 'int x = f(alpha,\n          beta);\nint y = 1 +\n        2;\n'), []);
});

test('prose in a /* */ comment, a docstring, and another program inside a template literal are left alone', () => {
    assert.deepEqual(judged('a.css', '.a {\n    /* why:\n           aligned prose */\n    color: red;\n}\n'), []);
    assert.deepEqual(judged('a.py', 'def f():\n    """Notes\n      kept as written\n    """\n    return 1\n'), []);
    assert.deepEqual(judged('a.mjs', 'run(`\n  (() => {\n      go();\n  })()`);\n'), []);
});

test('a C macro is judged through its line continuations; #define is not a comment', () => {
    assert.deepEqual(judged('a.c', '#define F(x) \\\n    do {      \\\n      g(x);   \\\n    } while (0)\n'),
        ['3: 2 deeper than the line that opens its block (4 is the step)']);
    assert.deepEqual(judged('a.c', '#define G(x) {   \\\n  h(x);          \\\n}\n'), ['2: 2 deeper than the line that opens its block (4 is the step)']);
});
