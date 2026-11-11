// The one Chrome launch for the drives: cdom's launcher (cdom/tools/cdp.mjs: headless, a temp
// --user-data-dir of its own, muted). Chrome keeps the real HOME (only the
// servers and the Anki children get a temp one, tests/e2e/ui/sandbox-home.sh), so it never asks macOS
// for a keychain. No Chrome outlives its drive: on exit, and on SIGINT or SIGTERM, this process's own children
// (the Chrome it started; its helpers go with it) are stopped by PID.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxEnv } from '../../../test/sandbox-home.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { launch } = await import(path.join(process.env.CDOM || path.join(here, '..', '..', '..', 'cdom'), 'tools', 'cdp.mjs'));

// cdom's launcher keeps Chrome off the keychain itself (--use-mock-keychain, --password-store=basic),
// so a Chrome that meets a HOME with no login keychain never asks macOS for one in a dialog.
export const CHROME_FLAGS = ['--hide-scrollbars'];

let armed = false;
function arm() {
  if (armed) return;
  armed = true;
  process.once('exit', () => {
    try {
      execFileSync('pkill', ['-TERM', '-P', String(process.pid)], { env: sandboxEnv(), stdio: 'ignore' });
    } catch { /* none left */ }
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => process.exit(1));
}

/** A headless Chrome for one drive, with CHROME_FLAGS, stopped when the drive exits. */
export async function launchChrome() {
  arm();
  return launch(CHROME_FLAGS);
}
