// A fresh Anki folder for the install and starter goldens: one profile, "User 1", whose collection
// the real anki library creates empty (ANKI_PYTHON_BIN), with Anki closed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv } from '../../sandbox-home.cjs';

export function freshAnki(python) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amgi-golden-'));
  fs.mkdirSync(path.join(dir, 'User 1'));
  execFileSync(python, ['-c', 'import sys\nfrom anki.collection import Collection\nCollection(sys.argv[1]).close()',
    path.join(dir, 'User 1', 'collection.anki2')], { env: sandboxEnv() });
  return dir;
}
