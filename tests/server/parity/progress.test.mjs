// What a card being made says it is doing (GET /api/anki/progress, server/amgi/progress.c), step by
// step. Gemini and the Anki bridge are fakes that hold every call until the test lets it go, so each
// step is read while it is the one running, the two that take a millisecond on a real machine
// (checking reuse, storing) as surely as the slow ones. No sleeps decide anything here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { BRIDGE_PROTOCOL, WIRE_MIME, decode, encode } from '../../../ui/wire/wire.mjs';
import { startServer } from './servers.mjs';

const { fakeGemini, quotaExhausted, wavAnswer } = createRequire(import.meta.url)('../plusaudio/helpers/fake-gemini.js');

// wire.h's WP_*, in its order.
const [WRITING, TARGET_REUSE, TARGET_RECORDING, TARGET_TRANSCRIBING, TARGET_JUDGING, TARGET_STORING,
  CUE_REUSE, CUE_RECORDING, CUE_TRANSCRIBING, CUE_JUDGING, CUE_STORING] = Array.from({ length: 11 }, (_, i) => i + 1);

const NO_SLOT = /#define WIRE_NO_SLOT_ERROR "([^"]+)"/.exec(fs.readFileSync(new URL('../../../ui/wire/wire.h', import.meta.url), 'utf8'))[1];
const DECK = 1794149693370; // the deck the add-on lists, English -> Korean
const FRONT = 'Where is the station?';
const BACK = '역이 어디예요?';
const CARD = { known_text: FRONT, learning_text: BACK, sense_tag: '', register: 'polite', spoken_reading: '' };
const STATUS = { profileOpen: true, profileName: 'User 1', collectionOpen: true, schemaVersion: 18, ankiVersion: '26.09.4', qtVersion: '6.9' };

/** The server, and fakes whose every call waits in `next(kind)` for the test to answer it. */
async function rig(t) {
    const queues = new Map();
    const queue = (kind) => {
        if (!queues.has(kind)) queues.set(kind, { calls: [], takers: [] });
        return queues.get(kind);
    };
    const open = new Set();
    let over = false; // the test has ended: what is asked from here on fails at once (a retry, say)
    const held = (kind) => new Promise((resolve) => {
        if (over) return resolve(undefined);
        const release = (value) => {
            open.delete(release);
            resolve(value);
        };
        open.add(release);
        const q = queue(kind);
        if (q.takers.length) q.takers.shift()(release);
        else q.calls.push(release);
    });
    const next = (kind) => new Promise((resolve, reject) => {
        const q = queue(kind);
        if (q.calls.length) return resolve(q.calls.shift());
        const timer = setTimeout(() => reject(new Error(`no ${kind} call came`)), 15000);
        q.takers.push((release) => {
            clearTimeout(timer);
            resolve(release);
        });
    });

    const kinds = ['text', 'speech', 'transcribe', 'judge', 'transcriptJudge'];
    const gemini = await fakeGemini(Object.fromEntries(kinds.map((kind) => [kind, () => held(kind)])));
    const addon = http.createServer(async (req, res) => {
        req.resume();
        let body;
        if (req.url === '/status') body = encode('b_status', STATUS);
        else if (req.url === '/decks') body = encode('b_decks', { decks: [{ id: DECK, name: 'Korean', known: 'en', learning: 'ko' }] });
        else if (req.method === 'GET') body = encode('b_media_exists', { exists: !!(await held('reuse')) });
        else {
            await held('store');
            body = encode('b_media_added', { filename: 'clip.wav' });
        }
        res.writeHead(200, { 'content-type': WIRE_MIME, 'x-amgi-bridge-protocol': String(BRIDGE_PROTOCOL), 'content-length': body.length });
        res.end(Buffer.from(body));
    });
    await new Promise((resolve) => addon.listen(0, '127.0.0.1', resolve));
    const app = await startServer({ key: 'fake', base: gemini.baseUrl });
    t.after(async () => {
        over = true;
        for (const release of [...open]) release(undefined);
        await app.stop();
        await gemini.close();
        addon.closeAllConnections();
        await new Promise((resolve) => addon.close(resolve));
    });

    const headers = { 'x-amgi-bridge-url': encodeURIComponent(`http://127.0.0.1:${addon.address().port}`), 'x-amgi-bridge-token': 'tok' };
    async function progress() {
        const res = await fetch(new URL('/api/anki/progress', app.url));
        const bytes = new Uint8Array(await res.arrayBuffer());
        assert.equal(res.status, 200, 'GET /progress answers');
        return decode('progress', bytes).cards;
    }
    async function card(progressId, extra = {}) {
        const res = await fetch(new URL('/api/anki/card-text', app.url), {
            method: 'POST',
            headers: { ...headers, 'content-type': WIRE_MIME },
            body: encode('q_card_text', { userInput: FRONT, deckId: DECK, includeCueAudio: true, progressId, ...extra }),
        });
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, body: decode(res.ok ? 'card_text' : 'error', bytes) };
    }
    /** The next call of `kind`, checked to be running as `step`, then answered. */
    async function during(kind, step, value, { take = 0, takes = 0, id = 7 } = {}) {
        const release = await next(kind);
        const now = (await progress()).find((c) => c.id === id);
        assert.ok(now, `${kind}: card ${id} is listed`);
        assert.deepEqual({ step: now.step, take: now.take, takes: now.takes, waitMs: now.waitMs }, { step, take, takes, waitMs: 0 }, `while ${kind} runs`);
        release(value);
        return now;
    }
    return { next, progress, card, during };
}

const take = (n, takes = 3) => ({ take: n, takes });

test('a card names every step in order, with both sides once they are written', async (t) => {
    const r = await rig(t);
    const made = r.card(7);
    const writing = await r.during('text', WRITING, CARD, take(1, 2));
    assert.deepEqual([writing.frontText, writing.backText], ['', ''], 'no text before it is written');
    const reuse = await r.during('reuse', TARGET_REUSE, false);
    assert.deepEqual([reuse.frontText, reuse.backText], [FRONT, BACK], 'both sides, from the moment they exist');
    await r.during('speech', TARGET_RECORDING, wavAnswer(), take(1));
    await r.during('transcribe', TARGET_TRANSCRIBING, '전혀 다른 말', take(1));
    await r.during('judge', TARGET_JUDGING, { heard: BACK, matches: true, reason: 'ok' }, take(1));
    await r.during('store', TARGET_STORING);
    await r.during('reuse', CUE_REUSE, false);
    await r.during('speech', CUE_RECORDING, wavAnswer(), take(1));
    await r.during('transcribe', CUE_TRANSCRIBING, 'something else', take(1));
    await r.during('judge', CUE_JUDGING, { heard: FRONT, matches: true, reason: 'ok' }, take(1));
    await r.during('store', CUE_STORING);
    assert.equal((await made).status, 200);
    assert.deepEqual(await r.progress(), [], 'a card that answered is listed no more');
});

test('a take that fails goes back to recording, on both sides', async (t) => {
    const r = await rig(t);
    const made = r.card(7);
    await r.during('text', WRITING, CARD, take(1, 2));
    for (const [reuse, recording, transcribing, judging, storing, said] of [
      [TARGET_REUSE, TARGET_RECORDING, TARGET_TRANSCRIBING, TARGET_JUDGING, TARGET_STORING, BACK],
      [CUE_REUSE, CUE_RECORDING, CUE_TRANSCRIBING, CUE_JUDGING, CUE_STORING, FRONT],
    ]) {
        await r.during('reuse', reuse, false);
        // take 1 is judged wrong
        await r.during('speech', recording, wavAnswer(), take(1));
        await r.during('transcribe', transcribing, 'wrong', take(1));
        await r.during('judge', judging, { heard: 'wrong', matches: false, reason: 'other words' }, take(1));
        // take 2 loses its judge: the transcript's judge is judging still
        await r.during('speech', recording, wavAnswer(), take(2));
        await r.during('transcribe', transcribing, 'wrong again', take(2));
        await r.during('judge', judging, undefined, take(2));
        await r.during('transcriptJudge', judging, { matches: false }, take(2));
        await r.during('speech', recording, wavAnswer(), take(3));
        await r.during('transcribe', transcribing, said, take(3));
        await r.during('store', storing);
    }
    assert.equal((await made).status, 200);
});

test('a side that cannot be spoken is written again, and says it is the second take', async (t) => {
    const r = await rig(t);
    const made = r.card(7, { includeCueAudio: false });
    await r.during('text', WRITING, { ...CARD, learning_text: '1. 역이 어디예요?\n2. 역은 어디에 있어요?' }, take(1, 2));
    await r.during('text', WRITING, CARD, take(2, 2));
    await r.during('reuse', TARGET_REUSE, true);
    assert.equal((await made).status, 200);
});

test('a clip that is reused records nothing', async (t) => {
    const r = await rig(t);
    const made = r.card(7);
    await r.during('text', WRITING, CARD, take(1, 2));
    await r.during('reuse', TARGET_REUSE, true);
    await r.during('reuse', CUE_REUSE, true);
    assert.equal((await made).status, 200);
});

test("Gemini's limit inside a step says it waits, keeps the step, and then goes on with it", async (t) => {
    const r = await rig(t);
    const made = r.card(7, { includeCueAudio: false });
    await r.during('text', WRITING, CARD, take(1, 2));
    await r.during('reuse', TARGET_REUSE, false);
    await r.during('speech', TARGET_RECORDING, quotaExhausted({ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel', quotaValue: 1 }, 2), take(1));
    const again = r.next('speech');
    let waiting;
    for (let i = 0; i < 150 && !waiting; i++) {
        waiting = (await r.progress()).find((c) => c.id === 7 && c.waitMs > 0);
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(waiting, 'the wait is shown');
    assert.equal(waiting.step, TARGET_RECORDING, 'of the step it interrupted');
    assert.ok(waiting.waitMs <= 2600, `no longer than the wait (${waiting.waitMs} ms)`);
    const release = await again;
    const resumed = (await r.progress()).find((c) => c.id === 7);
    assert.deepEqual([resumed.step, resumed.waitMs], [TARGET_RECORDING, 0], 'the wait over, the step is back');
    release(wavAnswer());
    await r.during('transcribe', TARGET_TRANSCRIBING, BACK, take(1));
    await r.during('store', TARGET_STORING);
    assert.equal((await made).status, 200);
});

test('cards made at once each have their own, a failed one leaves, and id 0 is never listed', async (t) => {
    const r = await rig(t);
    const first = r.card(7);
    const one = await r.next('text');
    const second = r.card(8);
    const two = await r.next('text');
    const unnamed = r.card(0);
    const none = await r.next('text');
    assert.deepEqual((await r.progress()).map((c) => c.id).sort(), [7, 8]);
    one(undefined); // the fake's outage
    assert.equal((await first).status, 500);
    assert.deepEqual((await r.progress()).map((c) => c.id), [8]);
    two(undefined);
    none(undefined);
    assert.deepEqual([(await second).status, (await unnamed).status], [500, 500]);
    assert.deepEqual(await r.progress(), []);
});

test('a card refused for want of a slot says so, apart from the rate limit', async (t) => {
    const r = await rig(t);
    const running = [];
    const held = [];
    for (let id = 1; id <= 12; id++) { // amgi_app.c's slow_workers
        running.push(r.card(id));
        held.push(await r.next('text'));
    }
    const refused = await r.card(13);
    assert.equal(refused.status, 429);
    assert.equal(refused.body.notStarted, true);
    assert.equal(refused.body.error, NO_SLOT, 'the sentence the page tells the slot from the limit by');
    for (const release of held) release(undefined);
    await Promise.all(running);
});
