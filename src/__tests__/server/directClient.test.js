// The direct transport's per-collection serialization, which exists so that
// two calls from this process can never have the collection file open at the
// same instant and report each other as 'locked' (see directClient.js's own
// comment). What is checked here is the *keying*: one queue per collection,
// and one collection means one queue however its path was spelled.
//
// plusaudio/lib/collection is mocked out entirely - this is a test about the
// queue, not about SQLite, and the real module would want a real collection
// file on disk to open.

import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import path from 'node:path';

const started = [];
const deferreds = [];

// plusaudio/lib/collection, faked (run with --experimental-test-module-mocks).
mock.module('plusaudio/lib/collection', { namedExports: {
  Collection: class FakeCollection {
    constructor(collectionPath) {
      this.path = collectionPath;
    }

    status() {
      started.push(this.path);
      return new Promise((resolve, reject) => {
        deferreds.push({
          finish: () => resolve({ status: 'ok', schemaVersion: 18 }),
          fail: () => reject(new Error('collection blew up')),
        });
      });
    }
  },
} });

/** Let every already-queued microtask run, so "has it started yet" is a fair question. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const ONE = path.join('/tmp', 'amgi-profile-one', 'collection.anki2');
const TWO = path.join('/tmp', 'amgi-profile-two', 'collection.anki2');

// The queue map is module state, so each test gets its own copy of the module
// - otherwise one test's unfinished call leaves the next one queued behind it,
// and a single real failure cascades into failures that mean nothing.
let createDirectOps;
let fresh = 0;

beforeEach(async () => {
  // a module instance of its own: the query makes it a new module, as jest.resetModules did
  ({ createDirectOps } = await import(`../../server/anki/directClient.js?test=${(fresh += 1)}`));
  started.length = 0;
  deferreds.length = 0;
});

describe('createDirectOps serialization', () => {
  test('two calls for the same collection do not overlap', async () => {
    const first = createDirectOps(ONE).status();
    await settle();
    const second = createDirectOps(ONE).status();
    await settle();

    assert.deepEqual(started, [ONE]);
    deferreds.shift().finish();
    await first;
    await settle();
    assert.deepEqual(started, [ONE, ONE]);

    deferreds.shift().finish();
    await second;
  });

  test('the same collection spelled two ways is still one queue', async () => {
    // A path that resolves to ONE but is not string-equal to it. Keying the
    // queue on the raw string would hand these two callers separate queues,
    // which is two handles on one file at once - exactly the false 'locked'
    // the queue exists to prevent.
    // Built by hand rather than with path.join, which would normalize it away.
    const noisy = `${path.dirname(ONE)}/../${path.basename(path.dirname(ONE))}/./${path.basename(ONE)}`;
    assert.notDeepEqual(noisy, ONE);
    assert.deepEqual(path.resolve(noisy), ONE);

    const first = createDirectOps(ONE).status();
    await settle();
    const second = createDirectOps(noisy).status();
    await settle();

    assert.deepEqual(started, [ONE]); // the second caller waits its turn

    deferreds.shift().finish();
    await first;
    await settle();
    assert.deepEqual(started, [ONE, noisy]);

    deferreds.shift().finish();
    await second;
  });

  test('different collections do not queue behind each other', async () => {
    // Switching profiles, or a test collection alongside the real one: these
    // are different files with different locks, and making one wait for the
    // other would be a self-inflicted stall.
    const first = createDirectOps(ONE).status();
    const second = createDirectOps(TWO).status();
    await settle();

    assert.deepEqual(started.sort(), [ONE, TWO].sort());

    deferreds.shift().finish();
    deferreds.shift().finish();
    await Promise.all([first, second]);
  });

  test('a failed call does not wedge the queue behind it', async () => {
    const failing = createDirectOps(ONE).status();
    await settle();
    const next = createDirectOps(ONE).status();

    deferreds.shift().fail();
    await assert.rejects(failing, { message: new RegExp('collection blew up'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
    await settle();

    assert.deepEqual(started, [ONE, ONE]);
    deferreds.shift().finish();
    assert.deepEqual(await next, { status: 'ok', schemaVersion: 18 });
  });
});
