// Every process the tests and the drives start runs with a fresh temp HOME and no XDG_DATA_HOME
// (incident 18:42, ~/Dev/foolish-reports/incident-1842.md). This holds the test code to it:
// - the node guard (test/sandbox-home.cjs) refuses the real home, a dir inside it or above it,
//   an Anki2 folder and XDG_DATA_HOME, and hands each child its own empty HOME;
// - every child-process call in the test code (JavaScript, parsed with eslint's own parser, and
//   Python, parsed with its ast module) passes an env made by sandboxEnv / sandbox_env, unless
//   the program is git, make or ffmpeg, which never open a collection;
// - the e2e shell tools source ui/tools/sandbox-home.sh, and e2e.sh starts each server and the
//   fake Gemini with a HOME of its own.
// The C binaries' own default base dir is the c-backend side's test, not this one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as espree from 'espree';
import { assertSandboxed, sandboxEnv } from './sandbox-home.cjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCANNED = ['test', 'ui/test', 'ui/tools', 'plusaudio/test', 'anki/addon/amgi_bridge/test', '.claude/skills/e2e-ui/scripts'];
const SELF = 'test/sandbox-home.test.mjs';
const EXEMPT = new Set(['git', 'make', 'ffmpeg']);
const JS_CALLS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);

test('the guard refuses the real home, a dir inside it or above it, an Anki2 folder and XDG_DATA_HOME', () => {
  const real = os.userInfo().homedir;
  const ok = sandboxEnv();
  assert.throws(() => assertSandboxed({ ...ok, HOME: real }), /real home/);
  assert.throws(() => assertSandboxed({ ...ok, HOME: path.join(real, 'Library') }), /real home/);
  assert.throws(() => assertSandboxed({ ...ok, HOME: '/' }), /real home/);
  assert.throws(() => assertSandboxed({ ...ok, XDG_DATA_HOME: ok.HOME }), /XDG_DATA_HOME/);
  assert.throws(() => assertSandboxed({ PATH: ok.PATH }), /no HOME/);
  fs.mkdirSync(path.join(ok.HOME, 'Library', 'Application Support', 'Anki2'), { recursive: true });
  assert.throws(() => assertSandboxed(ok), /Anki2/);
});

test('each child gets its own empty HOME, outside the real home, and none of the caller\'s environment', () => {
  const a = sandboxEnv({ GEMINI_API_KEY: 'k', GEMINI_API_BASE: undefined });
  const b = sandboxEnv();
  assert.notEqual(a.HOME, b.HOME);
  assert.deepEqual(fs.readdirSync(a.HOME), []);
  assert.ok(!fs.realpathSync(a.HOME).startsWith(fs.realpathSync(os.userInfo().homedir) + path.sep));
  assert.deepEqual(Object.keys(a).sort(), ['GEMINI_API_KEY', 'HOME', 'PATH', ...(process.env.TMPDIR ? ['TMPDIR'] : [])].sort());
});

const tracked = execFileSync('git', ['ls-files', '-z', '--', ...SCANNED], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter((f) => f && f !== SELF && fs.existsSync(path.join(ROOT, f)));

/** Walks every node of an espree tree. */
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) for (const v of value) walk(v, visit);
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

const isSandboxCall = (n) => n?.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'sandboxEnv';

/** The child-process calls in one JavaScript file that do not pass a sandboxed env, as "line: name". */
export function unsandboxedJs(source, file) {
  let ast;
  for (const sourceType of ['module', 'script', 'commonjs']) {
    try {
      ast = espree.parse(source, { ecmaVersion: 'latest', sourceType, loc: true });
      break;
    } catch { /* the next source type */ }
  }
  if (!ast) throw new Error(`${file}: does not parse`);
  // Names bound to a sandboxed env: X = sandboxEnv(...) or X = { ...sandboxEnv(...), ... }.
  const sandboxed = new Set();
  walk(ast, (n) => {
    if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier') return;
    if (isSandboxCall(n.init) || (n.init?.type === 'ObjectExpression'
      && n.init.properties.some((p) => p.type === 'SpreadElement' && isSandboxCall(p.argument)))) sandboxed.add(n.id.name);
  });
  const bad = [];
  walk(ast, (n) => {
    if (n.type !== 'CallExpression') return;
    const name = n.callee.type === 'Identifier' ? n.callee.name
      : n.callee.type === 'MemberExpression' && n.callee.object.name !== 'RegExp' && !n.callee.computed
        && /^(child_process|cp)$/.test(n.callee.object.name ?? '') ? n.callee.property.name : null;
    if (!JS_CALLS.has(name)) return;
    const program = n.arguments[0];
    if (program?.type === 'Literal' && EXEMPT.has(program.value)) return;
    const env = n.arguments.filter((a) => a.type === 'ObjectExpression')
      .flatMap((o) => o.properties).find((p) => p.type === 'Property' && (p.key.name ?? p.key.value) === 'env');
    if (env && (isSandboxCall(env.value) || (env.value.type === 'Identifier' && sandboxed.has(env.value.name)))) return;
    bad.push(`${n.loc.start.line}: ${name}`);
  });
  return bad;
}

const PY_CHECK = String.raw`
import ast, sys
EXEMPT = set(sys.argv[1].split(","))
for f in sys.argv[2:]:
    tree = ast.parse(open(f, encoding="utf-8").read(), f)
    for n in ast.walk(tree):
        if not (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name)
                and n.func.value.id == "subprocess" and n.func.attr in ("run", "Popen", "call", "check_call", "check_output")):
            continue
        first = n.args[0] if n.args else None
        if isinstance(first, ast.List) and first.elts and isinstance(first.elts[0], ast.Constant) and first.elts[0].value in EXEMPT:
            continue
        env = [k.value for k in n.keywords if k.arg == "env"]
        if env and isinstance(env[0], ast.Call) and isinstance(env[0].func, ast.Name) and env[0].func.id == "sandbox_env":
            continue
        print("%s:%d: subprocess.%s" % (f, n.lineno, n.func.attr))
`;

function unsandboxedPy(files) {
  if (!files.length) return [];
  const out = execFileSync('python3', ['-I', '-c', PY_CHECK, [...EXEMPT].join(','), ...files],
    { cwd: ROOT, env: sandboxEnv(), encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

test('the checks catch an unsandboxed call and pass a sandboxed or exempt one', () => {
  assert.deepEqual(unsandboxedJs([
    "spawn(SERVER, ['serve'], { stdio: 'pipe' });",
    "spawn(SERVER, ['serve'], { env: sandboxEnv(), stdio: 'pipe' });",
    "execFileSync('git', ['status']);",
    "execFileSync(dump, { input: b, env: process.env });",
    "const ENV = { ...sandboxEnv(), A: '1' };\nspawnSync(x, { env: ENV });",
    "const BAD = { ...process.env };\nspawnSync(x, { env: BAD });",
    "/a(b)/.exec(s); fork(script, args);",
  ].join('\n'), 'a.js'), ['1: spawn', '4: execFileSync', '8: spawnSync', '9: fork']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-sandbox-test-'));
  const py = path.join(dir, 't.py');
  fs.writeFileSync(py, [
    'import subprocess',
    'subprocess.run([CLI], input="x")',
    'subprocess.run([CLI], env=sandbox_env(), input="x")',
    'subprocess.run(["ffmpeg", "-i", "x"])',
    'subprocess.run(["node"], env=dict(os.environ))',
    'mock.patch("generator.subprocess.run")',
  ].join('\n'));
  assert.deepEqual(unsandboxedPy([py]), [`${py}:2: subprocess.run`, `${py}:5: subprocess.run`]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every child process the test code starts gets a sandboxed HOME', () => {
  const bad = [];
  for (const f of tracked.filter((f) => /\.(js|mjs|cjs)$/.test(f))) {
    for (const b of unsandboxedJs(fs.readFileSync(path.join(ROOT, f), 'utf8'), f)) bad.push(`${f}:${b}`);
  }
  bad.push(...unsandboxedPy(tracked.filter((f) => f.endsWith('.py'))));
  assert.deepEqual(bad, [], 'pass env: sandboxEnv() (test/sandbox-home.cjs) or env=sandbox_env() (sandbox_home.py)');
});

test('the e2e shell tools run in a sandbox, and e2e.sh gives each server and the fake its own HOME', () => {
  for (const f of ['ui/tools/e2e.sh', 'ui/tools/fixture.sh', 'ui/tools/drives.sh']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /^\. "\$here\/sandbox-home\.sh"$/m, `${f} sources sandbox-home.sh`);
  }
  const starts = fs.readFileSync(path.join(ROOT, 'ui/tools/e2e.sh'), 'utf8').split('\n').filter((l) => /^start /.test(l));
  assert.equal(starts.length, 4);
  for (const l of starts) assert.match(l, / env "HOME=\$\(fresh_home\)" /, l);
  const fixture = fs.readFileSync(path.join(ROOT, 'ui/tools/fixture.sh'), 'utf8');
  assert.match(fixture, /^env "HOME=\$\(fresh_home\)" "\$ANKI_PYTHON_BIN" /m, 'fixture.sh runs the anki library under its own HOME');
});

test('sandbox-home.sh keeps the shell\'s HOME for Chrome, gives fresh HOMEs, unsets XDG_DATA_HOME, refuses a TMPDIR inside the real home', () => {
  const sh = path.join(ROOT, 'ui/tools/sandbox-home.sh');
  const env = { ...sandboxEnv(), XDG_DATA_HOME: '/nowhere' };
  const out = execFileSync('bash', ['-c', `. "${sh}"; echo "$HOME"; echo "\${XDG_DATA_HOME-unset}"; fresh_home`],
    { env, encoding: 'utf8' }).split('\n');
  assert.equal(out[0], env.HOME, 'the shell keeps its HOME (Chrome uses it)');
  assert.equal(out[1], 'unset');
  assert.ok(out[2].startsWith(os.tmpdir()) || out[2].startsWith(fs.realpathSync(os.tmpdir())), out[2]);
  assert.notEqual(out[2], out[0]);
  assert.ok(!fs.existsSync(out[2]), 'the sandbox root is removed on exit');
  const inside = fs.mkdtempSync(path.join(os.userInfo().homedir, '.amgi-sandbox-probe-'));
  try {
    assert.throws(() => execFileSync('bash', ['-c', `. "${sh}"; echo reached`],
      { env: { ...env, TMPDIR: inside }, encoding: 'utf8', stdio: 'pipe' }), /inside the real home/);
  } finally {
    fs.rmSync(inside, { recursive: true, force: true });
  }
});

test('every drive starts Chrome through ui/tools/chrome.mjs, which stops it when the drive exits', () => {
  const drives = tracked.filter((f) => f.startsWith('ui/tools/') && f.endsWith('.mjs') && f !== 'ui/tools/chrome.mjs');
  for (const f of drives) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /\blaunch\(/, `${f}: Chrome only through launchChrome()`);
  assert.equal(drives.filter((f) => /launchChrome\(\)/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))).length, 6, 'the six drives');
});

test('a drive that exits without closing its Chrome leaves no Chrome running', () => {
  // A stand-in drive: launchChrome(), say the Chrome's PID (its child), and exit with it still open.
  const script = `import { execFileSync } from 'node:child_process';
    const { launchChrome } = await import(${JSON.stringify(path.join(ROOT, 'ui/tools/chrome.mjs'))});
    await launchChrome();
    process.stdout.write(execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }));
    process.exit(0);`;
  const env = { ...process.env };
  delete env.XDG_DATA_HOME;
  const pids = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' })
    .split('\n').filter(Boolean).map(Number);
  assert.ok(pids.length >= 1, 'the stand-in started a Chrome');
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && pids.some(alive); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  const left = pids.filter(alive);
  for (const p of left) process.kill(p, 'SIGKILL');
  assert.deepEqual(left, [], 'the Chrome it started is gone');
});
