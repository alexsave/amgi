// Text too long for the page's buffer, against a copy of the UI fixture that each run builds fresh
// (ui/tools/flows.sh, amgi installed): every box refuses it with a message and keeps nothing, never
// a value cut short (ui/src/dom.c input_value). A deck name past the new-deck modal's 512 bytes and
// past the rename's, a paste past the card box's MAX_PASTE (64 KB), a card field past 4096 bytes, a
// bridge token past the settings' 2048, each crossed by one byte (in multi-byte UTF-8 where the limit
// is a name's, so the value does not end on a character boundary at the limit); an Anki data folder
// path of 1024 or 1500 bytes refused alike by Save and Scan, which share one limit, and one of 1023
// saved; and a save refused for one value keeps none of the others.
//
//   node ui/tools/limits.mjs <base url> <name> <anki folder> [out dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cdom = process.env.CDOM || path.join(here, '..', '..', 'cdom');
const { sleep } = await import(path.join(cdom, 'tools', 'cdp.mjs'));
const { launchChrome } = await import('./chrome.mjs');
const [base, name, ankiDir, outArg] = process.argv.slice(2);
const out = outArg || path.join(here, '..', 'out', 'shots');
fs.mkdirSync(out, { recursive: true });
const collection = path.join(ankiDir, 'User 1', 'collection.anki2');
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
async function until(b, expr, tries = 100) {
  let v;
  for (let i = 0; i < tries; i++) {
    v = await b.evaluate(expr);
    if (v) return v;
    await sleep(100);
  }
  return v;
}
async function goto(b, url) {
  await b.send('Page.navigate', { url });
  await until(b, `document.readyState === 'complete'`);
}
const shot = async (b, file) => {
  const { result } = await b.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, `${name}-${file}.png`), Buffer.from(result.data, 'base64'));
};
async function click(b, selector) {
  const box = await b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
    e?.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = e?.getBoundingClientRect();
    return r ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
  if (!box) throw new Error(`nothing to click at ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await b.send('Input.dispatchMouseEvent', { type, x: box[0], y: box[1], button: 'left', clickCount: 1 });
  }
}
const key = async (b, k, code, keyCode) => {
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode });
};
const selectAll = (b) => b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, commands: ['selectAll'] });
// Typed (pasted) into the focused box as a person's paste arrives: one insertText, one input event.
const paste = async (b, text) => {
  await selectAll(b);
  await b.send('Input.insertText', { text });
};
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const text = (selector) => `document.querySelector(${JSON.stringify(selector)})?.textContent`;
const decksShown = `document.querySelectorAll('.deck-item').length`;
const deckNames = `[...document.querySelectorAll('.deck-item h3')].map(h => h.textContent)`;

// Each limit is a section of its own, from its own page, so one that fails (a mutant that lets the
// long value through) still lets the others run and say whether they hold.
async function section(what, fn) {
  try {
    await fn();
  } catch (err) {
    check(false, `${what}: ${err.message}`);
  }
}
async function openDeck(b, deck) {
  await goto(b, `${base}/decks`);
  await until(b, `${decksShown} >= 7`, 150);
  const i = await b.evaluate(`${deckNames}.findIndex(h => h === ${JSON.stringify(deck)})`);
  await click(b, `.deck-item:nth-child(${i + 1})`);
  await until(b, `document.querySelector('.deck-name-button')?.textContent === ${JSON.stringify(deck)} && document.querySelectorAll('.note-rows > li').length > 0`, 150);
}

// 171 three-byte characters: 513 bytes, one past the 512 the deck name buffers hold
const longName = '덱'.repeat(171);

const b = await launchChrome();
const watchdog = setTimeout(async () => {
  console.log('FAIL the drive took more than 3 minutes');
  await b.close();
  process.exit(1);
}, 180000);
const pageErrors = [];
b.onEvent = (d) => {
  if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
try {
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await seed(b, base, { baseDir: ankiDir, collection, profile: 'User 1' });
  await goto(b, `${base}/decks`);
  check(await until(b, `${decksShown} === 7`, 150), 'the deck list, seven decks');

  // 1. decks.c: a new deck's name one byte past 512 is refused in the modal, and no deck is made.
  await section('the new-deck name', async () => {
    check(bytes(longName) === 513, `the long name is 513 bytes (${bytes(longName)})`);
    await click(b, '.deck-actions .action-btn');
    await until(b, `document.activeElement?.id === 'deckName'`);
    await paste(b, longName);
    await click(b, '.modal-content .primary-btn');
    const modalErr = await until(b, text('.modal-content .error-message'));
    check(modalErr === 'That name is too long', `the modal refuses a 513-byte name: ${modalErr}`);
    await sleep(300);
    await shot(b, '60-modal-name-too-long');
    // one character fewer (510 bytes) fits, so the refusal is the length's and nothing else's
    await click(b, '#deckName');
    await paste(b, longName.slice(1));
    await click(b, '.modal-content .primary-btn');
    check(await until(b, `/^\\/deck\\/\\d+$/.test(location.pathname) && document.querySelector('.deck-name-button')?.textContent === ${JSON.stringify(longName.slice(1))}`, 150),
      `a 510-byte name is made and opened (${await b.evaluate(`location.pathname + ' ' + (document.querySelector('.modal-content .error-message')?.textContent ?? '')`)})`);
    await goto(b, `${base}/decks`);
    await until(b, `${decksShown} === 8`, 150);
    check(!(await b.evaluate(deckNames)).includes(longName), 'and no deck has the 513-byte name');
  });

  // 2. deck.c: a rename one byte past 512 is refused under the name, which stays as it was.
  await section('the rename', async () => {
    await openDeck(b, '한국어');
    await click(b, '.deck-name-button');
    await until(b, `document.activeElement?.classList.contains('deck-name-input')`);
    await paste(b, longName);
    await key(b, 'Enter', 'Enter', 13);
    const renameErr = await until(b, text('.deck-name-error'));
    check(renameErr === 'That name is too long', `the rename refuses a 513-byte name: ${renameErr}`);
    check(await b.evaluate(`${text('.deck-name-button')} === '한국어'`), 'and the name stays 한국어');
    await sleep(300);
    await shot(b, '61-rename-too-long');
  });

  // 3. form.c: a paste one byte past MAX_PASTE says so, and the button makes nothing.
  await section('the paste', async () => {
    await openDeck(b, '한국어');
    const lines = [];
    for (let n = 0; bytes(lines.join('\n')) < 65537; n++) lines.push(`line ${n} of a long paste`);
    let long = lines.join('\n');
    while (bytes(long) > 65537) long = long.slice(0, -1);
    check(bytes(long) === 65537, `the long paste is 65537 bytes (${bytes(long)})`);
    await click(b, '#amgiCardInput');
    await paste(b, long);
    const formErr = await until(b, text('.card-form-error'));
    check(/too long/.test(formErr || ''), `the box says the paste is too long: ${formErr}`);
    check(await b.evaluate(`document.querySelector('.card-form-go').disabled`), 'and its button is off');
    await sleep(300);
    await shot(b, '62-paste-too-long');
    await paste(b, 'short again');
    check(await until(b, `!document.querySelector('.card-form-error') && !document.querySelector('.card-form-go').disabled`),
      'a short text takes the message away and turns the button on');
  });

  // 4. panel.c: a card field one byte past 4096 is not saved, and the panel says why.
  await section('the card field', async () => {
    await openDeck(b, '한국어');
    await click(b, '.note-rows > li:nth-child(3) .note-row-edit');
    await until(b, `!!document.querySelector('.card-panel-value-big')`);
    const before = await b.evaluate(`document.querySelector('.card-panel-value-big').value`);
    await click(b, '.card-panel-value-big');
    await paste(b, 'x'.repeat(4097));
    await key(b, 'Enter', 'Enter', 13);
    const panelErr = await until(b, text('.card-panel-error'));
    check(panelErr === 'This field is too long to save', `the panel refuses a 4097-byte field: ${panelErr}`);
    await sleep(300);
    await shot(b, '63-field-too-long');
    await click(b, '.note-rows > li:nth-child(3) .note-row-edit'); // Close
    await goto(b, `${base}${await b.evaluate('location.pathname')}`);
    await until(b, `document.querySelectorAll('.note-rows > li').length > 0`, 150);
    await click(b, '.note-rows > li:nth-child(3) .note-row-edit');
    await until(b, `!!document.querySelector('.card-panel-value-big')`);
    check(await b.evaluate(`document.querySelector('.card-panel-value-big').value === ${JSON.stringify(before)}`), 'and Anki keeps the field as it was');
  });

  // 5. settings.c: a bridge token one byte past 2048 saves nothing, and says which setting.
  await section('the bridge token', async () => {
    await goto(b, `${base}/settings`);
    await until(b, `!!document.querySelector('#bridgeToken')`, 150);
    // the scan's answer draws its message above the bridge rows: typed once it has, so the clicks land
    await until(b, `[...document.querySelectorAll('.save-button')].some(x => x.textContent === 'Scan for profiles')`, 150);
    await sleep(300);
    await click(b, '#bridgeToken');
    await paste(b, 't'.repeat(2049));
    await click(b, '#bridgeUrl');
    await paste(b, 'http://127.0.0.1:9999');
    const typedToken = await b.evaluate(`document.querySelector('#bridgeToken').value.length`);
    check(typedToken === 2049, `the token box holds 2049 bytes (${typedToken})`);
    await b.evaluate(`[...document.querySelectorAll('.save-button')].find(x => x.textContent === 'Save Anki settings').dataset.drive = 'save'`);
    await click(b, '.save-button[data-drive="save"]');
    const saveErr = await until(b, text('.settings-page .message.error'));
    check(saveErr === 'The bridge token is too long', `Save refuses a 2049-byte token: ${saveErr}`);
    check(await b.evaluate(`!document.querySelector('.settings-page .message.success')`), 'and does not say saved');
    await sleep(300);
    await shot(b, '64-setting-too-long');
    await goto(b, `${base}/settings`);
    await until(b, `!!document.querySelector('#bridgeUrl')`, 150);
    check(await b.evaluate(`document.querySelector('#bridgeUrl').value === 'http://127.0.0.1:8798'`),
      `and nothing was kept, not even the address typed with it (${await b.evaluate(`document.querySelector('#bridgeUrl').value`)})`);
  });

  // 6. settings.c: the Anki data folder has one limit for save, scan and install alike: shorter than
  // MAX_BASE_DIR (1024, macOS's PATH_MAX, where no path that long opens). 1024 bytes and 1500 bytes
  // (between the old 1024 and 2048) are refused by Save and by Scan the same way.
  const tooLongPath = 'The Anki data folder path is too long';
  const pathErrors = `[...document.querySelectorAll('.settings-page .message.error')].filter(e => e.textContent === ${JSON.stringify(tooLongPath)}).length`;
  const pathOf = (n) => `${ankiDir}/` + 'p'.repeat(n - bytes(`${ankiDir}/`));
  const settingsPage = async () => {
    await goto(b, `${base}/settings`);
    // the scan's answer draws its message above the rows below it: typed once it has, so clicks land
    await until(b, `[...document.querySelectorAll('.save-button')].some(x => x.textContent === 'Scan for profiles')`, 150);
    await sleep(300);
  };
  const press = async (label) => {
    await b.evaluate(`[...document.querySelectorAll('.save-button')].find(x => x.textContent === ${JSON.stringify(label)}).dataset.drive = 'pressed'`);
    await click(b, '.save-button[data-drive="pressed"]');
    await b.evaluate(`delete document.querySelector('.save-button[data-drive="pressed"]').dataset.drive`);
  };
  const installsInto = `document.querySelector('.install-block code')?.textContent`;
  // Each section starts from the fixture's folder saved, so one that fails does not leave the next
  // a folder of its own.
  const settingsAtFixture = async () => {
    await settingsPage();
    if (await b.evaluate(`document.querySelector('#ankiBaseDir').value === ${JSON.stringify(ankiDir)}`)) return;
    await click(b, '#ankiBaseDir');
    await paste(b, ankiDir);
    await press('Save Anki settings');
    await sleep(300);
    await settingsPage();
  };
  for (const n of [1024, 1500]) {
    await section(`a ${n}-byte data folder path`, async () => {
      const long = pathOf(n);
      check(bytes(long) === n, `the path is ${n} bytes (${bytes(long)})`);
      await settingsAtFixture();
      await click(b, '#ankiBaseDir');
      await paste(b, long);
      await press('Save Anki settings');
      check(await until(b, `${pathErrors} === 1`, 30), `Save refuses a ${n}-byte path (${await b.evaluate(pathErrors)} message)`);
      await press('Scan for profiles');
      check(await until(b, `${pathErrors} === 2`, 30), `and Scan refuses it the same way (${await b.evaluate(pathErrors)} messages)`);
      if (n === 1024) {
        await sleep(300);
        await shot(b, '65-path-too-long');
      }
      await settingsPage();
      check(await b.evaluate(`document.querySelector('#ankiBaseDir').value === ${JSON.stringify(ankiDir)}`), 'and the saved folder is the one it was');
    });
  }

  // 7. settings.c: a save refused for one value keeps none of them: a new folder typed with a token
  // too long is not kept, on the screen (the install line reads what the screen holds) or after a reload.
  await section('a refused save keeps no value', async () => {
    await settingsAtFixture();
    check(await b.evaluate(`${installsInto} === ${JSON.stringify(ankiDir)}`), `the install line names the saved folder (${await b.evaluate(installsInto)})`);
    await click(b, '#ankiBaseDir');
    await paste(b, `${ankiDir}-other`);
    await click(b, '#bridgeToken');
    await paste(b, 't'.repeat(2049));
    await press('Save Anki settings');
    const tokenError = `[...document.querySelectorAll('.settings-page .message.error')].some(e => e.textContent === 'The bridge token is too long')`;
    check(await until(b, tokenError, 30), 'Save refuses the token');
    check(await b.evaluate(`${installsInto} === ${JSON.stringify(ankiDir)}`), `the install line still names the saved folder (${await b.evaluate(installsInto)})`);
    await settingsPage();
    check(await b.evaluate(`document.querySelector('#ankiBaseDir').value === ${JSON.stringify(ankiDir)} && ${installsInto} === ${JSON.stringify(ankiDir)}`),
      `and after a reload the folder is the one it was (${await b.evaluate(`document.querySelector('#ankiBaseDir').value`)})`);
  });

  // 8. One byte under the limit saves: a 1023-byte path is kept (last: the folder it names is not there).
  await section('a 1023-byte data folder path', async () => {
    const fits = pathOf(1023);
    check(bytes(fits) === 1023, `the path is 1023 bytes (${bytes(fits)})`);
    await settingsAtFixture();
    await click(b, '#ankiBaseDir');
    await paste(b, fits);
    await press('Save Anki settings');
    check(await until(b, `${text('.settings-page .message.success')} === 'Anki settings saved.'`, 30), `Save keeps a 1023-byte path (${await b.evaluate(text('.settings-page .message'))})`);
    await sleep(500); // the store's write lands (IndexedDB, after the message)
    await settingsPage();
    check(await b.evaluate(`document.querySelector('#ankiBaseDir').value === ${JSON.stringify(fits)}`), `and it is there after a reload (${await b.evaluate(`document.querySelector('#ankiBaseDir').value.length + ' ' + location.pathname`)})`);
    check(await b.evaluate(`${pathErrors} === 0`), 'and Scan, run as the page opens, takes it without a word on its length');
  });

  check(!pageErrors.length, `no page errors${pageErrors.length ? `: ${pageErrors.join(' / ')}` : ''}`);
} finally {
  clearTimeout(watchdog);
  await b.close();
}
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exitCode = 1;
}
