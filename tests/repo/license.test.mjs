// amgi's licence, as the owner decided it: the repository under the GNU AGPL, version 3 or later
// (LICENSE, the text from https://www.gnu.org/licenses/agpl-3.0.txt, unchanged), the agent skills
// under MIT (skills/LICENSE, covering skills/ and .claude/skills/), and both package.json files
// saying so. A file gone, a licence text edited, or a package licence changed fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('LICENSE is the GNU AGPL 3.0 text from gnu.org, unchanged', () => {
  const text = read('LICENSE');
  // gnu.org/licenses/agpl-3.0.txt as fetched: 34523 bytes, 661 lines.
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'), '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0');
  assert.match(text, /^ {20}GNU AFFERO GENERAL PUBLIC LICENSE\n {23}Version 3, 19 November 2007\n/);
});

test('skills/LICENSE is MIT, Alex Saveliev 2026, and names both skill folders', () => {
  const text = read('skills/LICENSE');
  assert.match(text, /everything under skills\/ and \.claude\/skills\//);
  assert.match(text, /\nMIT License\n\nCopyright 2026 Alex Saveliev\n\nPermission is hereby granted, free of charge,/);
  assert.match(text, /IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE\.\n$/);
  // .claude/skills/amgi is the same folder as skills/amgi, so the one file covers it as it is.
  assert.equal(fs.realpathSync(path.join(ROOT, '.claude', 'skills', 'amgi')), fs.realpathSync(path.join(ROOT, 'skills', 'amgi')));
});

test('both packages say AGPL-3.0-or-later', () => {
  for (const rel of ['package.json', 'plusaudio/package.json']) {
    assert.match(read(rel), /\n {2}"license": "AGPL-3\.0-or-later",\n/, rel);
  }
});

test('the README and the notices are there and point at each other', () => {
  const readme = read('README.md');
  assert.match(readme, /\n## License\n/);
  for (const link of ['(LICENSE)', '(skills/LICENSE)', '(THIRD_PARTY_NOTICES.md)']) assert.ok(readme.includes(link), link);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /^# Third-party notices\n/);
});

test('the starter clips carry their notice: how they were made, and what reuse is subject to', () => {
  const text = read('anki/starter/NOTICE.md');
  assert.match(text, /gemini-3\.8-flash-lite-tts/);
  assert.match(text, /`voices\.tsv`/);
  assert.match(text, /AGPL-3\.0-or-later/);
  assert.match(text, /https:\/\/aistudio\.google\.com\/docs\/terms on 2026-11-08/);
  assert.ok(fs.existsSync(path.join(ROOT, 'anki', 'starter', 'voices.tsv')), 'the voices file it names');
  assert.match(read('THIRD_PARTY_NOTICES.md'), /`anki\/starter\/NOTICE\.md`/);
});

test('every submodule has its notice', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  const paths = [...read('.gitmodules').matchAll(/^\s*path = (.+)$/gm)].map((m) => m[1].trim());
  assert.ok(paths.length >= 2, `the submodules: ${paths.join(', ')}`);
  for (const p of paths) {
    assert.match(notices, new RegExp(`\\n## ${p}\\n`), `${p}: a section of its own`);
    assert.ok(notices.includes(`\`${p}/\``), `${p}: where it is included`);
  }
});

test('every library the server links is noticed, read off its link line', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  // What build/amgi links (server/Makefile and cbase.mk's LDLIBS), as make spells it.
  const line = execFileSync('make', ['-s', '-C', path.join(ROOT, 'server'), 'print-ldlibs'], { encoding: 'utf8' });
  const libs = [...new Set([...line.matchAll(/(?:^|\s)-l(\S+)/g)].map((m) => m[1]))];
  assert.ok(libs.length >= 3, `the libraries: ${libs.join(' ')}`);
  // The C runtime's own (the system's libc carries them) need none; every other has its notice.
  const OWN = new Set(['pthread', 'm']);
  const NOTICE = { sqlite3: 'SQLite', ssl: 'OpenSSL', crypto: 'OpenSSL', icui18n: 'ICU', icuuc: 'ICU' };
  for (const lib of libs) {
    if (OWN.has(lib)) continue;
    assert.ok(NOTICE[lib], `-l${lib} is linked and THIRD_PARTY_NOTICES.md has no notice for it`);
    assert.ok(notices.includes(`**${NOTICE[lib]}**`), `${NOTICE[lib]} (-l${lib})`);
  }
});

test('the Anki fragments are where the notice says', () => {
  assert.match(read('THIRD_PARTY_NOTICES.md'), /fragments of Anki's source are reproduced in `server\/collection\/notes\.c`/);
  const notes = read('server/collection/notes.c');
  for (const src of ['rslib/src/storage/note/add.sql', 'rslib/src/storage/card/add_card.sql', 'rslib/src/notes/mod.rs']) assert.ok(notes.includes(src), src);
});
