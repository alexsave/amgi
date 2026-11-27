// The one Chrome launch for the drives: cdom's launcher (cdom/tools/cdp.mjs: headless, a temp
// --user-data-dir of its own, muted). Chrome keeps the real HOME (only the
// servers and the Anki children get a temp one, tests/e2e/ui/sandbox-home.sh), so it never asks macOS
// for a keychain. No Chrome outlives its drive: on exit, and on SIGINT or SIGTERM, this process's own children
// (the Chrome it started; its helpers go with it) are stopped by PID.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxEnv } from '../../repo/sandbox-home.cjs';

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

/**
 * The drives' one screenshot: shotter(out, name) gives shot(b, file), which writes <out>/<name>-<file>.png
 * and, next to it, the DOM it shows as <name>-<file>.html (the outerHTML of the mount, the body the
 * app was started on, id "amgi" in ui/src/index.html). The DOM is
 * there to read beside the picture when a shot looks wrong.
 */
export function shotter(out, name) {
    return async (b, file) => {
        // A shot is taken a moment after a click, and the page's CSS has many `transition: all 0.2s`, so a
        // frame can land mid-transition (a few pixels of anti-aliasing that differ run to run), and a text
        // input's caret blinks. Two runs of the same screen must give the same pixels, so before capturing:
        // finish every finite animation (the end state, as a still page shows it), pause every infinite one
        // at its start, hide the caret with a temporary style, and wait two frames so the page has painted
        // that. The style is removed and the paused animations play on after; the page is otherwise untouched.
        await b.evaluate(`(async () => {
      for (const a of document.getAnimations()) {
        const t = a.effect?.getComputedTiming().iterations;
        if (t === Infinity) { a.pause(); a.currentTime = 0; (window.__shot_paused ||= []).push(a); } else a.finish();
      }
      const s = document.createElement('style');
      s.id = '__shot_still';
      s.textContent = '* { caret-color: transparent !important; }';
      document.head.appendChild(s);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`);
        const { result } = await b.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(out, `${name}-${file}.png`), Buffer.from(result.data, 'base64'));
        await b.evaluate(`(() => {
      document.getElementById('__shot_still')?.remove();
      for (const a of window.__shot_paused || []) a.play();
      window.__shot_paused = [];
    })()`);
        const html = await b.evaluate(`(document.getElementById('amgi') || document.body).outerHTML`);
        fs.writeFileSync(path.join(out, `${name}-${file}.html`), html);
    };
}
