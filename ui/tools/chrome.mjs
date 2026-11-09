// The one Chrome launch for the drives: cdom's launcher (cdom/tools/cdp.mjs: headless, a temp
// --user-data-dir of its own, muted). Chrome keeps the real HOME (only the
// servers and the Anki children get a temp one, ui/tools/sandbox-home.sh), so it never asks macOS
// for a keychain. No Chrome outlives its drive: on exit, and on SIGINT or SIGTERM, this process's own children
// (the Chrome it started; its helpers go with it) are stopped by PID.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxEnv } from '../../test/sandbox-home.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { launch } = await import(path.join(process.env.CDOM || path.join(here, '..', '..', 'cdom'), 'tools', 'cdp.mjs'));

// Off the keychain as well: cdom's pin (cbfcf6f) does not pass these yet, and a Chrome that ever
// meets a HOME with no login keychain asks macOS for one in a dialog. Drop them here once the cdom
// pin's cdp.mjs carries them.
export const CHROME_FLAGS = ['--hide-scrollbars', '--use-mock-keychain', '--password-store=basic'];

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
