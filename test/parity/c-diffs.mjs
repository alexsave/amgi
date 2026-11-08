// Where the C recordings may differ from Node's, and nowhere else.
//
// Node is frozen (the owner's call, 2026-11-08), so the review findings of PR #30 are fixed in C
// alone, and C's answers now differ from the Node recordings on purpose in a few places. Each such
// recording has a C twin in test/parity/expect/c/, written by the runner under C with
// PARITY_RECORD_C=1. test/parity/C_DIFFS.txt names every difference, as a hunk:
//
//   == <what changed, and why: the finding it fixes>
//   @ <recording> [<recording> ...]
//     <the line before the change, the same in both>
//   - <Node's line(s)>
//   + <C's line(s)>
//
// (a blank line between hunks of one entry). The check computes the line diff of every C twin
// against its Node recording and fails unless each hunk is named exactly once per recording it is
// in, and each named hunk is found: no blanket skip, and no entry that outlives its case. At L4 the
// C recordings become the contract and this goes, with the Node ones.
import fs from 'node:fs';
import path from 'node:path';

export const EXPECT = path.resolve(import.meta.dirname, 'expect');
export const C_EXPECT = path.join(EXPECT, 'c');
export const C_DIFFS = path.resolve(import.meta.dirname, 'C_DIFFS.txt');

/** The hunks of a line diff (longest common subsequence), each with the one line before it. */
export function hunks(a, b) {
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the LCS length of a[i..] and b[j..], kept as rows of Uint32Array.
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  let last = '';
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      last = a[i];
      i += 1;
      j += 1;
      continue;
    }
    const hunk = { before: last, minus: [], plus: [] };
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) break;
      if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) hunk.plus.push(b[j++]);
      else hunk.minus.push(a[i++]);
    }
    out.push(hunk);
  }
  return out;
}

export const render = (h) => [`  ${h.before}`, ...h.minus.map((l) => `- ${l}`), ...h.plus.map((l) => `+ ${l}`)].join('\n');

/** C_DIFFS.txt as entries: {title, files, hunks: [rendered text]}. */
export function readDiffs(text = fs.existsSync(C_DIFFS) ? fs.readFileSync(C_DIFFS, 'utf8') : '') {
  const entries = [];
  let entry = null;
  let lines = [];
  const flush = () => {
    if (entry && lines.length) entry.hunks.push(lines.join('\n'));
    lines = [];
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    if (line.startsWith('== ')) {
      flush();
      entry = { title: line.slice(3), files: [], hunks: [] };
      entries.push(entry);
    } else if (line.startsWith('@ ')) {
      entry.files = line.slice(2).split(' ').filter(Boolean);
    } else if (line === '') {
      flush();
    } else if (entry) {
      lines.push(line);
    }
  }
  flush();
  return entries;
}

/** Every problem with the C twins against C_DIFFS, as sentences; [] when they agree. */
export function checkDiffs(entries = readDiffs()) {
  const problems = [];
  const twins = fs.existsSync(C_EXPECT) ? fs.readdirSync(C_EXPECT).filter((f) => f.endsWith('.txt')) : [];
  const used = new Set();
  for (const twin of twins) {
    const name = twin.replace(/\.txt$/, '');
    const node = fs.readFileSync(path.join(EXPECT, twin), 'utf8').split('\n');
    const c = fs.readFileSync(path.join(C_EXPECT, twin), 'utf8').split('\n');
    const named = entries.filter((e) => e.files.includes(name)).flatMap((e) => e.hunks.map((h) => ({ e, h })));
    const left = [...named];
    for (const h of hunks(node, c)) {
      const text = render(h);
      const k = left.findIndex((x) => x.h === text);
      if (k < 0) problems.push(`${name}: a difference from Node that C_DIFFS.txt does not name:\n${text}`);
      else {
        used.add(left[k]);
        left.splice(k, 1);
      }
    }
    for (const x of left) problems.push(`${name}: C_DIFFS.txt names a difference ("${x.e.title}") that is not there:\n${x.h}`);
  }
  for (const e of entries) {
    for (const f of e.files) if (!twins.includes(`${f}.txt`)) problems.push(`C_DIFFS.txt: "${e.title}" names ${f}, which has no C recording`);
  }
  return problems;
}
