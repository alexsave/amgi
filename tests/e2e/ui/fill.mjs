// Fill missing audio on the deck page, end to end, against the project's fake Gemini (its limits and delay switched through
// POST /control) and a fresh copy of the UI fixture (tests/e2e/ui/flows.sh, amgi installed). Decks are added to that copy with
// Anki's own library, so each is what the command line leaves behind: notes with no clip, the deck's pair stored.
//   - FillAmgi (amgi Listening notes, no choices): the line "5 cards have no audio · Fill", the run, and the line gone with the
//     rows' chips there; both audio fields hold amgi's clips afterwards (read by Anki's library from the file);
//   - the deck whose clips are someone else's (and one that cannot hold a clip at all) shows no line;
//   - FillOther (a note type of another shape): the picker with its guessed fields, a field and a language and a form picked,
//     the plan following, the clips written as picked; Cancel midway leaves the done notes done;
//   - FillMixed: the note type picker beside the others;
//   - FillWait: Gemini's per-minute limit shown as a countdown on the line, Cancel during it, Fill again to the end;
//   - FillCap: the day's cap said under the line.
// Every state is shot at 1280 and at phone width.
//
//   node tests/e2e/ui/fill.mjs <base url> <fake gemini url> <name> <anki folder> [out dir]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.mjs';

const { withAnkiLibrary } = createRequire(import.meta.url)('../../helpers/anki-python.js');
const { controlFake } = createRequire(import.meta.url)('../../helpers/fake-gemini.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const cdom = process.env.CDOM || path.join(here, '..', '..', '..', 'cdom');
const { sleep } = await import(path.join(cdom, 'tools', 'cdp.mjs'));
const { launchChrome, shotter } = await import('./chrome.mjs');
const [base, gemini, name, ankiDir, outArg] = process.argv.slice(2);
const out = outArg || path.join(here, '..', '..', '..', 'ui', 'out', 'shots');
fs.mkdirSync(out, { recursive: true });
const collection = path.join(ankiDir, 'User 1', 'collection.anki2');
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };
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
const shoot = shotter(out, name);
async function click(b, selector) {
    const box = await b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
    e?.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = e?.getBoundingClientRect();
    return r ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
    if (!box) throw new Error(`nothing to click at ${selector}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await b.send('Input.dispatchMouseEvent', { type, x: box[0], y: box[1], button: 'left', clickCount: 1 });
    }
}
const control = (q) => controlFake(gemini, q);
const py = (code) => withAnkiLibrary(collection, code).trim();

// What Anki's library reads from the file: a deck's notes as "field|field" per line.
const dump = (deck, fields) => py(`
for nid in sorted(col.find_notes(f'deck:"${deck}"')):
    n = col.get_note(nid)
    print("${'|'}".join(n[f] for f in ${JSON.stringify(fields)}))
`).split('\n').filter(Boolean);

// The decks: a pair stored, as amgi's own deck pair is.
py(`
def deck(name):
    d = col.decks.get(col.decks.id(name))
    d["amgiLanguages"] = "en ko"
    col.decks.save(d)
    return d["id"]
amgi = col.models.by_name("amgi Listening")
f = {x["name"]: i for i, x in enumerate(amgi["flds"])}
def amgi_notes(name, pairs):
    did = deck(name)
    for cue, target in pairs:
        n = col.new_note(amgi)
        n.fields[f["Cue"]], n.fields[f["Target"]], n.fields[f["Language"]] = cue, target, "ko"
        col.add_note(n, did)
vocab = col.models.new("Vocab")
for x in ("Word", "Meaning", "Audio"):
    col.models.add_field(vocab, col.models.new_field(x))
t = col.models.new_template("Card 1")
t["qfmt"], t["afmt"] = "{{Word}}", "{{FrontSide}}<hr id=answer>{{Meaning}}{{Audio}}"
col.models.add_template(vocab, t)
col.models.add(vocab)
vocab = col.models.by_name("Vocab")
def vocab_notes(name, pairs):
    did = deck(name)
    for word, meaning in pairs:
        n = col.new_note(vocab)
        n["Word"], n["Meaning"] = word, meaning
        col.add_note(n, did)
amgi_notes("FillAmgi", [("Hello", "안녕하세요"), ("Thank you", "고맙습니다"), ("Where is the station?", "역이 어디예요?"), ("Good night", "안녕히 주무세요"), ("See you", "또 만나요")])
vocab_notes("FillOther", [("사과", "apple"), ("물", "water"), ("빵", "bread"), ("우유", "milk"), ("밥", "rice")])
amgi_notes("FillMixed", [("Cheers", "건배")])
vocab_notes("FillMixed", [("커피", "coffee")])
amgi_notes("FillWait", [("One", "하나"), ("Two", "둘"), ("Three", "셋")])
basic = col.models.by_name("Basic")
did = deck("FillBasic")
for front, back in [("사과", "apple"), ("물", "water")]:
    n = col.new_note(basic)
    n["Front"], n["Back"] = front, back
    col.add_note(n, did)
amgi_notes("FillCap", [("Dawn", "새벽"), ("Dusk", "해질녘")])
`);

const line = `document.querySelector('.deck-fill')?.textContent`;
const noScroll = `document.documentElement.scrollWidth <= innerWidth`;
const picks = `[...document.querySelectorAll('.deck-fill select')].map(s => s.selectedOptions[0].textContent).join('|')`;

const b = await launchChrome();
const watchdog = setTimeout(async () => {
    console.log('FAIL the drive took more than 8 minutes');
    await b.close();
    process.exit(1);
}, 480000);
const pageErrors = [];
const requests = []; // /api/anki requests the page made: "POST /decks/1/audio-plan"
b.onEvent = (d) => {
    if (d.method === 'Network.requestWillBeSent') {
        const u = new URL(d.params.request.url);
        if (u.pathname.startsWith('/api/anki/')) requests.push(`${d.params.request.method} ${u.pathname.slice(9)}`);
    }
    if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') pageErrors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
// A shot at 1280 and at phone width, the page not wider than the window at either.
async function both(file, what) {
    for (const [m, tag] of [[DESKTOP, ''], [PHONE, '-phone']]) {
        await b.send('Emulation.setDeviceMetricsOverride', m);
        await sleep(300);
        check(await b.evaluate(noScroll), `${what}: no horizontal scroll at ${m.width}`);
        await shoot(b, file + tag);
    }
    await b.send('Emulation.setDeviceMetricsOverride', DESKTOP);
}
async function openDeck(deckName) {
    await goto(b, `${base}/decks`);
    await until(b, `document.querySelectorAll('.deck-item').length > 0`, 150);
    const i = await b.evaluate(`[...document.querySelectorAll('.deck-item h3')].findIndex(h => h.textContent === ${JSON.stringify(deckName)})`);
    if (i < 0) throw new Error(`no deck row ${deckName}`);
    await click(b, `.deck-item:nth-child(${i + 1})`);
    await until(b, `document.querySelector('.deck-name-button')?.textContent === ${JSON.stringify(deckName)}`, 150);
    await until(b, `document.querySelectorAll('.note-row').length > 0`, 150);
    await sleep(500); // the plan
}
async function pick(which, value) {
    await b.evaluate(`(() => { const s = document.querySelectorAll('.deck-fill select')[${which}]; s.focus(); s.value = ${JSON.stringify(String(value))};
    s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(400);
}
async function pressButton(label) {
    const at = await b.evaluate(`(() => { const x = [...document.querySelectorAll('.deck-fill button')].find(e => e.textContent === ${JSON.stringify(label)});
    const r = x?.getBoundingClientRect(); return r ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
    if (!at) throw new Error(`no ${label} button`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await b.send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
    }
}
// the box of an element: left, top, width, height, rounded
const box = (sel) => b.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r && [r.left, r.top, r.width, r.height].map(Math.round); })()`);

try {
    await control('perMinute=1000&daily=0&delay=0');
    await b.send('Emulation.setDeviceMetricsOverride', DESKTOP);
    await b.send('Network.enable');
    await seed(b, base, { baseDir: ankiDir, collection, profile: 'User 1' });

    // 1. A deck with no choices to make: the line, the run, the line gone.
    await openDeck('FillAmgi');
    check((await b.evaluate(line)) === '5 cards have no audio · Fill', `the line says what is missing (${await b.evaluate(line)})`);
    check((await b.evaluate(`!document.querySelector('.deck-fill select')`)), 'an amgi deck has no picker');
    const planned = requests.filter((r) => /POST \/decks\/\d+\/audio-plan/.test(r)).length;
    check(planned >= 1, `the plan was asked (${planned} times)`);
    const sub = await box('.deck-cards-sub'), fl = await box('.deck-fill');
    check(sub && fl && fl[1] >= sub[1] + sub[3] - 1 && fl[1] - (sub[1] + sub[3]) <= 8 && fl[0] === sub[0],
      `the line sits right under the count and starts at its left edge (count ${sub}, line ${fl})`);
    await both('60-fill-line', 'the line');

    await control('delay=350');
    await pressButton('Fill');
    check(await until(b, `/^Filling audio \\d of 5/.test(${line})`), `a run says where it is (${await b.evaluate(line)})`);
    await sleep(600);
    check(!!(await b.evaluate(`[...document.querySelectorAll('.deck-fill button')].find(x => x.textContent === 'Cancel')`)), 'with Cancel beside it');
    await both('61-fill-running', 'running');
    check(await until(b, `!document.querySelector('.deck-fill')`, 300), 'when it is done the line is gone');
    await control('delay=0');
    const filled = dump('FillAmgi', ['TargetAudio', 'CueAudio']);
    check(filled.length === 5 && filled.every((r) => /^<audio src="amgi-[0-9a-f]{20}\.wav"><\/audio>\|<audio src="amgi-[0-9a-f]{20}\.wav"><\/audio>$/.test(r)),
      `both audio fields of every note hold amgi's clips in the file (${filled[0]})`);
    check(await until(b, `document.querySelectorAll('.note-row .note-row-noaudio').length === 0 && document.querySelectorAll('.note-row-clips > *').length >= 10`, 100),
      'and the rows show their chips');
    await both('62-fill-done', 'done');
    const asked = requests.filter((r) => /POST \/notes\/\d+\/audio-fill/.test(r)).length;
    check(asked === 5, `one request per note (${asked})`);
    await sleep(300);
    check(!(await b.evaluate(`!!document.querySelector('.deck-fill')`)), 'and no line comes back');

    // 2. Nothing to fill, nothing shown: a deck whose notes have every clip, and one whose note type has no audio field.
    const plans = () => requests.filter((r) => /POST \/decks\/\d+\/audio-plan/.test(r)).length;
    const before = plans();
    await openDeck('FillBasic');
    check(!(await b.evaluate(`!!document.querySelector('.deck-fill')`)), 'a deck whose notes have nowhere for a clip shows no line');
    check(plans() === before, 'and no plan is asked for it (Basic has no audio field)');

    // someone else's audio is audio: the fixture's Korean deck holds clips of another origin (cue-hello.wav), so it offers nothing
    await openDeck('한국어');
    check(!(await b.evaluate(`!!document.querySelector('.deck-fill')`)), 'a deck whose notes have audio of another origin shows no line');

    // 3. A note type of another shape: the picker, the plan following it, the clips written as picked.
    await openDeck('FillOther');
    check((await b.evaluate(line)).startsWith('5 cards have no audio · Fill'), `the line (${await b.evaluate(line)})`);
    check((await b.evaluate(picks)) === 'Word|Audio|한국어|[sound:] tag', `the picker holds the guessed fields (${await b.evaluate(picks)})`);
    const pk = await box('.deck-fill-pick'), pf = await box('.deck-fill');
    check(pk && pf && pk[0] === pf[0] && pk[2] === pf[2], `the picker takes the line's own row (${pk} in ${pf})`);
    await both('63-fill-picker', 'the picker');
    await pick(1, 1); // the audio field: Meaning
    check((await b.evaluate(picks)).startsWith('Word|Meaning|'), `the audio field can be picked (${await b.evaluate(picks)})`);
    await pick(1, 2);
    await pick(0, 1); // the text field: Meaning
    check((await b.evaluate(picks)).startsWith('Meaning|Audio|'), `the text field can be picked (${await b.evaluate(picks)})`);
    await pick(2, 1); // in English: the known language
    await pick(3, 1); // as an <audio> element
    check((await b.evaluate(picks)) === 'Meaning|Audio|English|<audio> element', `the language and the form too (${await b.evaluate(picks)})`);
    check(await b.evaluate(`document.activeElement === document.querySelectorAll('.deck-fill select')[3]`),
        'the select just changed keeps the focus through the plan\'s redraws');
    await pick(1, 1); // the audio field as the text's own field: refused, the select goes back
    check((await b.evaluate(picks)) === 'Meaning|Audio|English|<audio> element', 'the same field on both sides is refused');
    check((await b.evaluate(line)).startsWith('5 cards have no audio'), 'the plan still counts them');
    await control('delay=500');
    await pressButton('Fill');
    check(await until(b, `/^Filling audio [2-4] of 5/.test(${line})`, 100), `a run (${await b.evaluate(line)})`);
    await pressButton('Cancel');
    check(await until(b, `/^[1-4] cards? ha(s|ve) no audio/.test(${line})`, 100), `Cancel stops it and the line counts what is left (${await b.evaluate(line)})`);
    const left = Number((await b.evaluate(line)).match(/^(\d)/)[1]);
    const half = dump('FillOther', ['Audio']);
    check(half.filter((r) => r).length === 5 - left && half.filter((r) => r).every((r) => /^<audio src="amgi-[0-9a-f]{20}\.wav"><\/audio>$/.test(r)),
      `the notes done stay done, in the form picked, the rest untouched (${half.join(',')})`);
    check((await b.evaluate(picks)) === 'Meaning|Audio|English|<audio> element', 'and the picks are kept');
    await control('delay=0');
    await pressButton('Fill');
    check(await until(b, `!document.querySelector('.deck-fill')`, 200), 'Fill again takes it to the end');
    check(dump('FillOther', ['Audio']).every((r) => /^<audio src="amgi-/.test(r)), 'every note has its clip');

    // 4. A deck with two fillable note types: the type picker too.
    await openDeck('FillMixed');
    check((await b.evaluate(line)).startsWith('1 card has no audio · Fill'), `one card is missing one (${await b.evaluate(line)})`);
    check((await b.evaluate(picks)) === 'amgi Listening', `the amgi type is first, with its type picker alone (${await b.evaluate(picks)})`);
    await both('66-fill-types', 'two note types');
    await pick(0, 1);
    check((await b.evaluate(picks)) === 'Vocab|Word|Audio|한국어|[sound:] tag' && (await b.evaluate(line)).startsWith('1 card has no audio'),
      `the other type brings its fields (${await b.evaluate(picks)} / ${await b.evaluate(line)})`);
    await goto(b, `${base}/decks`);

    // 5. Gemini's per-minute limit: the countdown on the line, Cancel during it, Fill again once the limit is lifted.
    await control('perMinute=2');
    await openDeck('FillWait');
    check((await b.evaluate(line)).startsWith('3 cards have no audio'), `three to fill (${await b.evaluate(line)})`);
    await pressButton('Fill');
    check(await until(b, `/waiting \\d+s for the rate limit/.test(${line})`, 300), `the limit is waited out with a countdown (${await b.evaluate(line)})`);
    // On a server of its own (e2e.sh), whose rate gate has met no refusal before this one, the wait comes at the same note
    // every time (the second, in three runs of the whole suite); on the server bulk used, it moved with what bulk met.
    check(/^Filling audio 2 of 3/.test(await b.evaluate(line)), `the wait comes at the same note on every run (${await b.evaluate(line)})`);
    const w1 = Number((await b.evaluate(line)).match(/waiting (\d+)s/)[1]);
    await sleep(2200);
    const w2 = Number((await b.evaluate(line)).match(/waiting (\d+)s/)[1]);
    check(w2 < w1, `and it counts down (${w1}s, then ${w2}s)`);
    await both('64-fill-wait', 'waiting for the rate limit');
    await pressButton('Cancel');
    check(await until(b, `/^[123] cards? ha(s|ve) no audio/.test(${line})`, 100), `Cancel ends the wait at once (${await b.evaluate(line)})`);
    check(dump('FillWait', ['TargetAudio']).filter((r) => r).length === 3 - Number((await b.evaluate(line)).match(/^(\d)/)[1]), 'what was done stays done');
    await control('perMinute=1000');
    await pressButton('Fill');
    check(await until(b, `!document.querySelector('.deck-fill')`, 1200), 'with the limit gone it runs to the end');

    // 6. The day's cap: said under the line, nothing more asked.
    await control('daily=1');
    await openDeck('FillCap');
    await pressButton('Fill');
    check(await until(b, `document.querySelector('.deck-fill .deck-name-error')`, 100), 'a spent day is said');
    const msg = await b.evaluate(`document.querySelector('.deck-fill .deck-name-error').textContent`);
    check(msg.startsWith('Filled 0: '), `with what was done and why it stopped (${msg})`);
    check((await b.evaluate(line)).includes('2 cards have no audio · Fill'), `and the line says what is left (${await b.evaluate(line)})`);
    await both('65-fill-capped', 'the cap');
    await control('daily=0');

    check(!pageErrors.length, `no page errors${pageErrors.length ? `: ${pageErrors.join(' / ')}` : ''}`);
} finally {
    clearTimeout(watchdog);
    await control('perMinute=1000&daily=0&delay=0').catch(() => {});
    await b.close();
}
if (failures.length) {
    console.log(`${failures.length} check(s) failed`);
    process.exitCode = 1;
}
