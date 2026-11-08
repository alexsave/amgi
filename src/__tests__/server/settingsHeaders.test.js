import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readSettings, PLAIN_HEADERS } from '../../server/anki/settings';

const request = (headers) => new Request('http://127.0.0.1/api/anki/status', { headers });

describe('readSettings', () => {
  test('reads the plain headers, percent-decoding UTF-8', () => {
    const settings = readSettings(request({
      [PLAIN_HEADERS.collectionPath]: encodeURIComponent('/Users/me/Anki2/사용자 1/collection.anki2'),
      [PLAIN_HEADERS.profileName]: encodeURIComponent('사용자 1'),
      [PLAIN_HEADERS.bridgeToken]: 'abc',
    }));
    assert.deepEqual(settings, {
      baseDirOverride: '',
      collectionPath: '/Users/me/Anki2/사용자 1/collection.anki2',
      profileName: '사용자 1',
      bridge: { baseUrl: '', token: 'abc' },
    });
  });

  test('prefers the plain headers over the JSON header', () => {
    const settings = readSettings(request({
      [PLAIN_HEADERS.baseDirOverride]: '%2Ftmp%2Fa',
      'x-amgi-anki-settings': JSON.stringify({ baseDirOverride: '/tmp/b' }),
    }));
    assert.equal(settings.baseDirOverride, '/tmp/a');
  });

  test('still reads the JSON header the documented API sends', () => {
    const settings = readSettings(request({
      'x-amgi-anki-settings': JSON.stringify({ collectionPath: '/c', bridge: { baseUrl: 'http://x', token: 't' } }),
    }));
    assert.deepEqual(settings, { baseDirOverride: '', collectionPath: '/c', profileName: '', bridge: { baseUrl: 'http://x', token: 't' } });
  });

  test('reads a malformed escape as empty, not as a thrown request', () => {
    assert.equal(readSettings(request({ [PLAIN_HEADERS.collectionPath]: '%E0%A4%A' })).collectionPath, '');
  });
});
