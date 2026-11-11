// What the repository's source scans share (tests/repo/no-json.test.mjs; the C port of the checkpoint scan,
// tests/server/c/no_checkpoint.c, keeps its own copy of these rules in tests/server/c/srcscan.h):
// which tracked files ship, and their code with the comments blanked, so a scan reads code and
// not what a comment says about it.
import { execFileSync } from 'node:child_process';

export const SOURCE = /\.(?:js|mjs|cjs|ts|html|py|c|h)$/;
/** Not shipped: a directory of this name anywhere in the path. */
const NOT_SHIPPED_DIR = new Set([
  'test', 'tests', '__tests__', 'test-helpers', 'tools', 'scripts', 'docs', 'fixtures', 'e2e', 'vendor', 'node_modules',
]);
export const notShipped = (file) => {
  const parts = file.split('/');
  return parts.some((p) => NOT_SHIPPED_DIR.has(p)) || /\.(?:test|spec|config)\.[a-z]+$/.test(parts.at(-1));
};

/** JavaScript with its comments blanked, lines kept. Strings are kept, so a "//" in a URL does not start a comment. */
export function stripJsComments(src) {
  let out = '';
  let quote = '';
  for (let i = 0; i < src.length;) {
    const c = src[i], d = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += d ?? ''; i += 2; continue; }
      if (c === quote || (c === '\n' && quote !== '`')) quote = '';
      i++;
    } else if (c === '"' || c === '\'' || c === '`') {
      quote = c; out += c; i++;
    } else if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2;
    } else {
      out += c; i++;
    }
  }
  return out;
}

/** Python with its comments and triple-quoted strings (docstrings) blanked, lines kept. */
export function stripPyComments(src) {
  let out = '';
  let quote = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const triple = src.slice(i, i + 3);
    if (quote.length === 3) {
      if (triple === quote) { quote = ''; i += 3; continue; }
      if (c === '\n') out += '\n';
      i++;
    } else if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === quote || c === '\n') quote = '';
      i++;
    } else if (triple === '"""' || triple === '\'\'\'') {
      quote = triple; i += 3;
    } else if (c === '"' || c === '\'') {
      quote = c; out += c; i++;
    } else if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
    } else {
      out += c; i++;
    }
  }
  return out;
}

/** Every tracked source file under root that ships (the submodules are not listed by git ls-files). */
export function shippedSources(root) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0');
  return tracked.filter((f) => f && SOURCE.test(f) && !notShipped(f));
}
